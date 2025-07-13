// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  join,
} = require('node:path');
const {
  AnalysisTypes: {
    Scene,
  },
  StateData,
  M2CException,
  CommonUtils: {
    download,
    uploadFile,
    deleteObject,
  },
  SegmentHelper: {
    loadModelConfigs,
    getPreferredModel,
  },
  ExceptionHelper: {
    retryableExceptions,
  },
} = require('core-lib');

const {
  Statuses: { Completed, Processing },
} = StateData;

const {
  ENV_PROXY_BUCKET: ProxyBucket,
  ENV_BEDROCK_MODELLIST_LOCATION: ModelListLocation = '_settings/availablemodels.json',
} = process.env;

const BATCH_SIZE = 4;

class StateRunTitanEmbeddings {
  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new M2CException('stateData not StateData object');
    }
    this.$stateData = stateData;
  }

  get [Symbol.toStringTag]() {
    return 'StateRunTitanEmbeddings';
  }

  get stateData() {
    return this.$stateData;
  }

  async process() {
    await loadModelConfigs(ProxyBucket, ModelListLocation);

    const model = await getPreferredModel(['titan-embed']);

    await this.startClean();

    const {
      data: {
        [Scene]: {
          bucket: proxyBucket,
          prefix: framePrefix,
          json: frameJson,
          embeddings: embeddingsJson,
          nextIdx: _nextIdx,
        },
      },
    } = this.stateData;

    let nextIdx = _nextIdx;
    if (nextIdx === undefined) {
      nextIdx = 0;
    }

    let frames = join(framePrefix, frameJson);
    frames = await download(proxyBucket, frames)
      .then((res) =>
        JSON.parse(res).slice(nextIdx));

    if (frames.length === 0) {
      return this.setCompleted();
    }

    let frameEmbeddings = [];
    let processed = 0;

    try {
      while (frames.length > 0) {
        const batched = frames.slice(0, BATCH_SIZE);

        const embeddings = await _batchGenerateEmbeddings(
          model,
          proxyBucket,
          framePrefix,
          batched
        );
        processed += embeddings.length;
        frameEmbeddings = frameEmbeddings.concat(embeddings);
        // remove frames
        frames.splice(0, embeddings.length);

        if (this.lambdaTimeout()) {
          break;
        }
      }
    } catch (e) {
      console.log(e);
      if (!retryableExceptions(e)) {
        throw e;
      }
    }

    // update embedding json
    if (frameEmbeddings.length > 0) {
      await _updateEmbeddingFile(proxyBucket, framePrefix, embeddingsJson, frameEmbeddings);
    }

    if (frames.length === 0) {
      return this.setCompleted();
    }

    nextIdx += processed;
    return this.setProcessing(nextIdx);
  }

  setCompleted() {
    delete this.stateData.data[Scene].nextIdx;
    this.stateData.status = Completed;

    return this.stateData;
  }

  setProcessing(nextIdx) {
    this.stateData.data[Scene].nextIdx = nextIdx;
    this.stateData.status = Processing;

    return this.stateData;
  }

  async startClean() {
    const {
      data: {
        [Scene]: {
          bucket: proxyBucket,
          prefix: framePrefix,
          embeddings,
          similarity,
          nextIdx,
        },
      },
    } = this.stateData;

    if (nextIdx !== undefined) {
      return undefined;
    }

    // delete the existing embedding and simlarity outputs in case
    // this is triggered by re-analysis flow
    const promises = [embeddings, similarity]
      .map((name) =>
        deleteObject(proxyBucket, join(framePrefix, name)));

    return Promise.all(promises);
  }

  lambdaTimeout() {
    return this.stateData.quitNow();
  }
}

async function _updateEmbeddingFile(
  bucket,
  prefix,
  name,
  frameEmbeddings
) {
  const key = join(prefix, name);
  let embeddings = await download(bucket, key)
    .then((res) =>
      JSON.parse(res))
    .catch(() => {
      return [];
    });

  embeddings = embeddings.concat(frameEmbeddings);

  return uploadFile(bucket, prefix, name, embeddings);
}

async function _batchGenerateEmbeddings(
  model,
  bucket,
  prefix,
  frames = []
) {
  let embeddings = frames
    .map((frame) =>
      _generateEmbeddings(model, bucket, prefix, frame));

  embeddings = await Promise.all(embeddings);

  return embeddings;
}

async function _generateEmbeddings(
  model,
  bucket,
  prefix,
  frame
) {
  const key = join(prefix, frame.name);

  const image = await (await download(bucket, key, false)
    .then((res) =>
      res.Body.transformToString('base64')));

  const {
    response: { embedding: embeddings },
  } = await model.inference(undefined, [{ image }]);

  return {
    name: frame.name,
    label: 'n/a',
    score: 1,
    embeddings,
  };
}

module.exports = StateRunTitanEmbeddings;
