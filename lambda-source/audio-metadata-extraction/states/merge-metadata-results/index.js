// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  parse,
} = require('node:path');
const {
  merge: mergeDiarisation,
} = require('./diarisationHelper');
const {
  merge: mergeTranscript,
} = require('./transcriptHelper');
const {
  merge: mergeEnhancedAudio,
} = require('./enhanceAudioHelper');
const {
  merge: mergeAudioTags,
} = require('./audioTagHelper');

const BaseState = require('../shared/base');

class StateMergeMetadataResults extends BaseState {
  static opSupported(op) {
    return op === 'StateMergeMetadataResults';
  }

  async process() {
    try {
      const {
        input: {
          destination: {
            bucket: proxyBucket,
          },
          duration,
          audio,
        },
        data,
      } = this.stateData;

      const {
        audioExtractions,
        iterators,
      } = data || {};

      let audioKey = (audio || {}).key;
      if (audioKey === undefined) {
        audioKey = ((audioExtractions || [])[0] || {}).output;
      }

      // no audio data
      if (!audioKey || (iterators || []).length === 0) {
        return {};
      }

      const diarisationIterators = [];
      const transcriptIterators = [];
      const audioTagIterators = [];

      for (const stateOutputs of iterators) {
        for (const stateOutput of stateOutputs) {
          const { model } = stateOutput;
          if (model === 'pyannote') {
            diarisationIterators.push(stateOutput);
          } else if (model === 'whisperx') {
            transcriptIterators.push(stateOutput);
          } else if (model === 'panns') {
            audioTagIterators.push(stateOutput);
          }
        }
      }

      let promises = [];

      const prefix = parse(audioKey).dir;
      promises.push(mergeDiarisation(proxyBucket, prefix, diarisationIterators, duration));
      promises.push(mergeTranscript(proxyBucket, prefix, transcriptIterators, duration));
      promises.push(mergeEnhancedAudio(proxyBucket, prefix, diarisationIterators, duration));
      promises.push(mergeAudioTags(proxyBucket, prefix, audioTagIterators, duration));

      promises = await Promise.all(promises);

      promises = promises.reduce((acc, cur) => ({
        ...acc,
        ...cur,
      }), {});

      return promises;
    } catch (e) {
      console.error(e);
      throw e;
    }
  }
}

module.exports = StateMergeMetadataResults;
