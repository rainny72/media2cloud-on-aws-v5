// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  parse,
} = require('node:path');
const {
  aimlGetPresets,
  DB,
  CommonUtils: {
    download,
    headObject,
    getTags,
    makeSafeOutputPrefix,
  },
  MimeTypeHelper: {
    getMime,
    parseMimeType,
  },
  Environment: {
    Proxy: {
      Bucket: ProxyBucket,
    },
    DynamoDB: {
      Ingest: {
        Table: IngestTable,
        PartitionKey: IngestPartitionKey,
      },
    },
  },
  StateData,
  FrameCaptureMode: {
    MODE_DYNAMIC_FPS,
  },
  IngestError,
} = require('core-lib');

const {
  Statuses: {
    IngestStarted,
    Processing,
  },
} = StateData;

const DEFAULT_AI_OPTIONS = process.env.ENV_DEFAULT_AI_OPTIONS;
const AI_OPTIONS_S3KEY = process.env.ENV_AI_OPTIONS_S3KEY;

class StateCreateRecord {
  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new IngestError('stateData not StateData object');
    }
    this.$stateData = stateData;
  }

  get [Symbol.toStringTag]() {
    return 'StateCreateRecord';
  }

  static opSupported(op) {
    return op === 'StateCreateRecord';
  }

  get stateData() {
    return this.$stateData;
  }

  async process() {
    const {
      uuid,
      input: src,
    } = this.stateData;

    if (!uuid || !src.bucket || !src.key) {
      throw new IngestError('missing uuid, bucket and key');
    }

    const response = await headObject(src.bucket, src.key);
    if (!src.mime) {
      src.mime = getMime(src.key);
    }
    /* try our best to find md5 from metadata, object-tags, and etag */
    const md5 = await this.findMd5(response);
    /* parse frame capture mode settings */
    src.aiOptions = await this.parseFrameCaptureMode(src.aiOptions);
    /* update type based on mime */
    src.type = parseMimeType(src.mime);
    /* make sure destination.bucket and prefix are set */
    if (!(src.destination || {}).bucket || !(src.destination || {}).prefix) {
      src.destination = {
        bucket: ProxyBucket,
        prefix: makeSafeOutputPrefix(uuid, src.key),
        ...src.destination,
      };
    }
    /* create ddb record */
    const status = IngestStarted;
    const overallStatus = Processing;
    const merged = {
      ...this.parseObjectProps(response),
      bucket: src.bucket,
      key: src.key,
      basename: parse(src.key).name,
      md5,
      mime: src.mime,
      type: src.type,
      timestamp: (new Date()).getTime(),
      schemaVersion: 1,
      attributes: src.attributes,
      aiOptions: src.aiOptions,
      status,
      overallStatus,
      executionArn: this.stateData.event.executionArn,
      destination: src.destination,
    };
    const db = new DB({
      Table: IngestTable,
      PartitionKey: IngestPartitionKey,
    });
    await db.update(uuid, undefined, merged);

    this.stateData.setCompleted(status);
    return this.stateData.toJSON();
  }

  async findMd5(data) {
    /* #1: x-amz-metadat-md5 is set, we are all good */
    if (((data || {}).Metadata || {}).md5) {
      return data.Metadata.md5;
    }

    /* #2: try object tagging */
    const src = this.stateData.input || {};
    const response = await getTags(src.bucket, src.key)
      .catch(() =>
        undefined);
    const chksum = ((response || {}).TagSet || []).find((x) =>
      x.Key === 'computed-md5');
    if (chksum && chksum.Value.match(/^([0-9a-fA-F]{32})$/)) {
      return chksum.Value;
    }

    /* #3: try ETag iff it is NOT multipart upload and SSE is disable or AES256 */
    if (!data.ServerSideEncryption
      || data.ServerSideEncryption.toLowerCase() === 'aes256') {
      /* the regex screens any multipart upload ETag */
      const matched = data.ETag.match(/^"([0-9a-fA-F]{32})"$/);
      if (matched) {
        return matched[1];
      }
    }

    return undefined;
  }

  parseObjectProps(data) {
    return Object.assign({
      key: data.Key,
      fileSize: data.ContentLength || data.Size,
      storageClass: data.StorageClass || 'STANDARD',
      lastModified: new Date(data.LastModified).getTime(),
    }, data.Metadata);
  }

  async parseFrameCaptureMode(aiOptions) {
    let options = aiOptions;
    if (!options) {
      const bucket = ProxyBucket;
      const key = AI_OPTIONS_S3KEY;
      options = await download(
        bucket,
        key
      ).then((res) =>
        JSON.parse(res))
        .catch(() =>
          undefined);
    }

    // load from environment variable
    if (!options) {
      options = aimlGetPresets(DEFAULT_AI_OPTIONS);
    }

    options.frameCaptureMode = MODE_DYNAMIC_FPS;

    return options;
  }
}

module.exports = StateCreateRecord;
