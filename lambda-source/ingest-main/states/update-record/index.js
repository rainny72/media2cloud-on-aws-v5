// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  join,
} = require('node:path');
const {
  DB,
  CommonUtils: {
    headObject,
    listObjects,
    download,
  },
  MimeTypeHelper: {
    getMime,
    parseMimeType,
  },
  Environment: {
    DynamoDB: {
      Ingest: {
        Table,
        PartitionKey,
      },
    },
  },
  StateData,
  IngestError,
} = require('core-lib');

const REGION = process.env.AWS_REGION;

const OUTPUT_TYPE_PROXY = 'proxy';
const OUTPUT_TYPE_AIML = 'aiml';
const OUTPUT_TYPE_PROD = 'prod';

class StateUpdateRecord {
  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new IngestError('stateData not StateData object');
    }
    this.$stateData = stateData;
  }

  get [Symbol.toStringTag]() {
    return 'StateUpdateRecord';
  }

  static opSupported(op) {
    return op === 'StateUpdateRecord';
  }

  get stateData() {
    return this.$stateData;
  }

  async process() {
    const {
      uuid,
      input: {
        bucket,
        key,
        destination: {
          bucket: proxyBucket,
        },
      },
      data: {
        transcode: {
          output: outputPrefix,
          copyFromSource,
        },
        frameExtraction,
        audioExtractions,
        diarisation,
        loudness,
        transcribe,
        audioenhancement,
        audiotagging,
      },
    } = this.stateData;

    if (!bucket || !key) {
      throw new IngestError('fail to find input.bucket and key');
    }

    if (!outputPrefix) {
      throw new IngestError('fail to find proxy destination');
    }

    let proxies = await this.tryProxiesByFFmpeg();
    if (proxies.length === 0) {
      proxies = await this.tryProxiesByMediaConvert();
    }

    if (proxies.length === 0) {
      throw new IngestError(`fail to find proxy under ${proxyBucket}/${outputPrefix}`);
    }

    const fieldsToUpdate = {
      proxies,
      frameExtraction,
      audioExtractions,
      diarisation,
      loudness,
      transcribe,
      audioenhancement,
      audiotagging,
      copyFromSource,
    };

    for (const [key, value] of Object.entries(fieldsToUpdate)) {
      if (value === undefined) {
        delete fieldsToUpdate[key];
      }
    }

    const db = new DB({ Table, PartitionKey });

    await db.update(uuid, undefined, fieldsToUpdate, false);

    this.stateData.setCompleted();

    return this.stateData.toJSON();
  }

  async tryProxiesByFFmpeg() {
    const {
      input: {
        destination: {
          bucket: proxyBucket,
        },
      },
      data: {
        transcode: {
          output: transcodePrefix,
        },
        frameExtraction,
        audioExtractions,
      },
    } = this.stateData;

    if (frameExtraction === undefined) {
      return [];
    }

    let proxies = [];

    // video proxy
    const videoPrefix = join(transcodePrefix, OUTPUT_TYPE_AIML, '/');
    await this.enumerateProxies(proxyBucket, videoPrefix, OUTPUT_TYPE_AIML)
      .then((res) =>
        proxies = res.concat(proxies));

    // audio proxy
    if (Array.isArray(audioExtractions) && audioExtractions.length > 0) {
      const { output } = audioExtractions[0];
      const proxy = await this.getProps(proxyBucket, output);
      proxies.push(proxy);
    }

    // frame captures
    const {
      framePrefix,
      embeddings: embeddingsJson,
    } = frameExtraction;

    let { frames } = await download(proxyBucket, join(framePrefix, embeddingsJson))
      .then((res) =>
        JSON.parse(res));

    frames = frames.splice(0, 600);
    frames.sort((a, b) =>
      b.laplacian - a.laplacian);

    const frame = frames[0];

    const frameKey = join(framePrefix, frame.name);
    const proxy = await this.getProps(proxyBucket, frameKey);
    proxies.push(proxy);

    return proxies;
  }

  async tryProxiesByMediaConvert() {
    const {
      input: {
        destination: {
          bucket: proxyBucket,
        },
      },
      data: {
        transcode: {
          output: outputPrefix,
        },
      },
    } = this.stateData;

    const outputGroups = [OUTPUT_TYPE_AIML, OUTPUT_TYPE_PROD];
    let proxies = [];

    // find proxy video and proxy audio
    for (const outputGroup of outputGroups) {
      const prefix = join(outputPrefix, outputGroup, '/');
      await this.enumerateProxies(proxyBucket, prefix, outputGroup)
        .then((res) =>
          proxies = proxies.concat(res));
    }

    // find the largest JPEG from first 100 frames
    const prefix = join(outputPrefix, OUTPUT_TYPE_PROXY, '/');
    let jpegImage = await listObjects(proxyBucket, prefix, {
      MaxKeys: 100,
    }).catch(() => undefined);

    if (jpegImage !== undefined) {
      jpegImage = jpegImage.Contents
        .sort((a, b) =>
          b.Size - a.Size)
        .shift();
    }

    if (jpegImage !== undefined) {
      const {
        Key: key,
      } = jpegImage;

      const mime = getMime(key);
      const type = parseMimeType(mime);
      const props = this.parseObjectProps(jpegImage);

      proxies.push({
        ...props,
        outputType: OUTPUT_TYPE_PROXY,
        key,
        mime,
        type,
      });
    }

    return proxies;
  }

  async enumerateProxies(proxyBucket, prefix, outputType, isFolder = true) {
    const proxies = [];

    let response;
    do {
      const params = {
        ContinuationToken: (response || {}).NextContinuationToken,
        MaxKeys: 300,
      };

      response = await listObjects(proxyBucket, prefix, params, REGION, isFolder)
        .catch((e) => {
          console.error(
            'ERR:',
            'StateUpdateRecord.process:',
            'CommonUtils.listObjects:',
            e.name,
            e.message,
            prefix
          );
          return undefined;
        });

      if (!Array.isArray((response || {}).Contents)) {
        continue;
      }

      for (const content of response.Contents) {
        const {
          Key: key,
        } = content;

        const mime = getMime(key);
        const type = parseMimeType(mime);
        const props = this.parseObjectProps(content);
        proxies.push({
          ...props,
          outputType,
          key,
          mime,
          type,
        });
      }
    } while ((response || {}).NextContinuationToken);

    return proxies;
  }

  async getProps(bucket, key) {
    const response = await headObject(bucket, key);
    const mime = getMime(key);
    const type = parseMimeType(mime);
    const props = this.parseObjectProps(response);
    return {
      ...props,
      outputType: OUTPUT_TYPE_PROXY,
      key,
      mime,
      type,
    };
  }

  parseObjectProps(data) {
    const {
      Key: key,
      StorageClass: storageClass = 'STANDARD',
      LastModified,
      Metadata: metadata,
    } = data;

    const fileSize = data.Size || data.ContentLength;
    const lastModified = new Date(LastModified).getTime();
    return {
      key,
      fileSize,
      storageClass,
      lastModified,
      ...metadata,
    };
  }
}

module.exports = StateUpdateRecord;
