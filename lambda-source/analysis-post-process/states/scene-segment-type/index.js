// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
} = require('node:path');
const {
  StateData: {
    Statuses: {
      InProgress,
      Completed,
    },
  },
  CommonUtils: {
    download,
    uploadFile,
    debugLocally,
  },
} = require('core-lib');
const {
  getDefaultTemplate,
  preAnalyzeProgramSequences,
  identifyProgramSequence,
} = require('./programSequenceHelper');
const {
  CustomPromptTemplate,
} = require('../shared/defs');
const BaseState = require('../shared/base');

// minimium duration to analyze start/end sequences
const BAILOUT_RETRY = 10;
const USE_MULTIPLE_MODELS = false;

class StateSceneSegmentType extends BaseState {
  static opSupported(op) {
    return op === 'StateSceneSegmentType';
  }

  async process() {
    try {
      const { retries } = this.data;
      if (retries && retries >= BAILOUT_RETRY) {
        throw new Error('Too many retries');
      }

      const bucket = this.proxyBucket;
      const {
        prefix: framePrefix, shotsToScenes: sceneJson,
      } = this.structural || {};

      let outputs;
      let promises = [];

      promises.push(this.downloadAllOutputs()
        .then((res) => {
          outputs = res;
        }));
      await Promise.all(promises);

      let {
        sceneGroups, frameEmbeddings: { frames },
      } = outputs;

      const frameMap = {};
      for (const frame of frames) {
        frameMap[String(frame.frameNum)] = frame;
      }
      outputs.frameMap = frameMap;
      delete outputs.frameEmbeddings;

      promises = [];
      promises.push(this.analyzeProgramSequences(bucket, framePrefix, outputs));

      const lastException = await _waitAndCheckExceptions(promises);

      // update output first
      const outputData = [];
      outputData.push([framePrefix, sceneJson, sceneGroups]);

      promises = [];
      for (const [prefix, name, data] of outputData) {
        promises.push(uploadFile(bucket, prefix, name, data));
      }
      await Promise.all(promises);

      // throw to the state machine to trigger Retry logic
      if (lastException !== undefined) {
        throw lastException;
      }

      const processed = sceneGroups.filter((scene) => {
        const { programSequenceResponse } = scene;
        return programSequenceResponse !== undefined;
      });

      if (sceneGroups.length === processed.length) {
        _printUsage(sceneGroups);
        return this.setCompleted(sceneGroups);
      }

      const progress = Math.round((processed.length / sceneGroups.length) * 100);
      return this.setProgress(progress);
    } catch (e) {
      console.log(e);
      throw e;
    }
  }

  setCompleted() {
    this.stateData.status = Completed;
    delete this.data.retries;
    return this.stateData;
  }

  setProgress(progress) {
    this.stateData.status = InProgress;
    this.stateData.progress = progress;

    let { retries } = this.data;
    if (retries === undefined) {
      retries = 0;
    }
    retries += 1;
    this.data.retries = retries;

    return this.stateData;
  }

  async downloadAllOutputs() {
    const {
      prefix: framePrefix,
      shotsToScenes: sceneJson,
      embeddings: embeddingsJson,
    } = this.structural || {};

    // audio sub-elements are scattered to ingest and analysis workflows now!
    const audio = {
      ...this.inputaudio,
      ...this.dataaudio,
    };

    const {
      diarisation, loudness,
    } = audio;

    const outputs = {};
    const dataFiles = [];

    // shots_to_scene
    dataFiles.push(['sceneGroups', join(framePrefix, sceneJson)]);
    // frame_embeddings
    dataFiles.push(['frameEmbeddings', join(framePrefix, embeddingsJson)]);
    // diarisation
    if ((diarisation || {}).output !== undefined) {
      const { prefix, output } = diarisation;
      dataFiles.push(['diarisationGroups', join(prefix, output)]);
    }
    // loudness
    if ((loudness || {}).output !== undefined) {
      const { prefix, output } = loudness;
      dataFiles.push(['loudnessGroups', join(prefix, output)]);
    }

    let promises = [];

    const bucket = this.proxyBucket;
    for (const [field, key] of dataFiles) {
      promises.push(download(bucket, key)
        .then((res) => {
          outputs[field] = JSON.parse(res);
        }));
    }
    await Promise.all(promises);

    return outputs;
  }

  async analyzeProgramSequences(bucket, framePrefix, data) {
    const { programSequence } = CustomPromptTemplate;

    let instruction = getDefaultTemplate();
    instruction = await this.getUserDefinedTemplate(programSequence, instruction);

    let models = ['nova-pro'];
    if (USE_MULTIPLE_MODELS) {
      models = ['sonnet', 'nova-pro', 'nova-premier'];
      models = models.concat([]);
    }
    models = models.map((model) => this.getModel(model));
    models = await Promise.all(models);

    const {
      sceneGroups, frameMap, loudnessGroups, diarisationGroups,
    } = data;

    const exceptions = [];
    console.log(`======= PROGRAMME SEQUENCES (${sceneGroups.length}) =========`);

    const respondToField = 'programSequenceResponse';
    preAnalyzeProgramSequences(sceneGroups, frameMap, loudnessGroups, diarisationGroups, respondToField);

    for (const scene of sceneGroups) {
      if (this.lambdaTimeout()) {
        break;
      }

      let response;

      const { programSequenceResponse } = scene;
      if (programSequenceResponse !== undefined && !debugLocally()) {
        response = programSequenceResponse;
      } else {
        response = await identifyProgramSequence(
          models,
          bucket,
          framePrefix,
          scene,
          instruction
        ).catch((e) => e);
      }

      if (response instanceof Error) {
        exceptions.push(response);
        break;
      }

      if ((response || {}).response === undefined) {
        continue;
      }

      console.log(JSON.stringify(response.response.jsonOutput, null, 2));

      scene.programSequenceResponse = response;
    }

    return exceptions;
  }
}

async function _waitAndCheckExceptions(promises) {
  let exception;

  let responses = await Promise.all(promises);
  responses = responses.flat(2);

  for (const response of responses) {
    if (response instanceof Error) {
      exception = response;
      break;
    }
  }

  return exception;
}

function _printUsage(sceneGroups) {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalEstimatedCost = 0;

  for (const scene of sceneGroups) {
    const {
      programSequenceResponse: { response: { usage } },
    } = scene;
    if (usage) {
      const { inputTokens, outputTokens, estimatedCost } = usage;
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
      totalEstimatedCost += estimatedCost;
    }
  }

  console.log(`Total InputTokens: ${totalInputTokens}`);
  console.log(`Total OutputTokens: ${totalOutputTokens}`);
  console.log(`Total EstimatedCost: ${totalEstimatedCost}`);
}

module.exports = StateSceneSegmentType;
