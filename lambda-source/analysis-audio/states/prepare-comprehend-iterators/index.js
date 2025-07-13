// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  StateData,
  AnalysisError,
} = require('core-lib');

const {
  States: {
    StartKeyphrase,
    StartEntity,
    StartSentiment,
  },
} = StateData;

class StatePrepareComprehendIterators {
  static opSupported(op) {
    return op === 'StatePrepareComprehendIterators';
  }

  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new AnalysisError('stateData not StateData object');
    }
    this.$stateData = stateData;
  }

  get [Symbol.toStringTag]() {
    return 'StatePrepareComprehendIterators';
  }

  get stateData() {
    return this.$stateData;
  }

  async process() {
    const {
      uuid,
      input,
      data,
    } = this.stateData;

    const {
      aiOptions,
      audio: {
        transcribe,
      },
    } = input;

    const {
      languageCode,
      vtt,
    } = transcribe || {};

    if (!vtt || !languageCode) {
      data.iterators = [];
      return this.setCompleted();
    }

    const { keyphrase, sentiment, entity } = aiOptions;

    const comprehends = {
      [StartKeyphrase]: keyphrase,
      [StartEntity]: entity,
      [StartSentiment]: sentiment,
    };

    const iteratorData = { uuid, input, data };

    const iterators = [];

    for (const [operation, enabled] of Object.entries(comprehends)) {
      if (enabled === true) {
        const duped = JSON.parse(JSON.stringify(iteratorData));
        iterators.push({
          operation,
          ...duped,
        });
      }
    }

    data.iterators = iterators;

    return this.setCompleted();
  }

  setCompleted() {
    this.stateData.setCompleted();
    return this.stateData.toJSON();
  }
}

module.exports = StatePrepareComprehendIterators;
