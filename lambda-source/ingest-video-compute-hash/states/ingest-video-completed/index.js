// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  StateData,
  IngestError,
} = require('core-lib');

const {
  Statuses: {
    Completed,
    Processing,
  },
} = StateData;

class StateIngestVideoCompleted {
  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new IngestError('stateData not StateData object');
    }
    this.$stateData = stateData;
  }

  get [Symbol.toStringTag]() {
    return 'StateIngestVideoCompleted';
  }

  get stateData() {
    return this.$stateData;
  }

  static opSupported(op) {
    return op === 'StateIngestVideoCompleted';
  }

  async process() {
    const {
      parallelStateOutputs = [],
    } = this.stateData.event;

    let mergedOutput = {};
    for (const stateOutput of parallelStateOutputs) {
      const {
        uuid,
        input,
        data,
      } = stateOutput;

      if (mergedOutput.uuid === undefined) {
        mergedOutput.uuid = uuid;
      }

      if (mergedOutput.input === undefined) {
        mergedOutput.input = input;
      }

      if (mergedOutput.data === undefined) {
        mergedOutput.data = data;
      }

      for (const [key, value] of Object.entries(data)) {
        mergedOutput.data = {
          ...mergedOutput.data,
          [key]: value,
        };
      }
    }

    // // move frameExtraction and audioExtractions into transcode
    // if (mergedOutput.data.frameExtraction) {
    //   mergedOutput.data.transcode.frameExtraction = mergedOutput.data.frameExtraction;
    //   delete mergedOutput.data.frameExtraction;
    // }

    // if (mergedOutput.data.audioExtractions) {
    //   mergedOutput.data.transcode.audioExtractions = mergedOutput.data.audioExtractions;
    //   delete mergedOutput.data.audioExtractions;
    // }

    mergedOutput.status = Completed;
    mergedOutput.overallStatus = Processing;

    delete mergedOutput.data.iterators;

    return mergedOutput;
  }
}

module.exports = StateIngestVideoCompleted;
