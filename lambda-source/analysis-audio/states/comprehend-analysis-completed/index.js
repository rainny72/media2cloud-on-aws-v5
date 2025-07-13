// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  StateData,
  AnalysisError,
} = require('core-lib');

class StateComprehendAnalysisCompleted {
  static opSupported(op) {
    return op === 'StateComprehendAnalysisCompleted';
  }

  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new AnalysisError('stateData not StateData object');
    }
    this.$stateData = stateData;
  }

  get [Symbol.toStringTag]() {
    return 'StateComprehendAnalysisCompleted';
  }

  get stateData() {
    return this.$stateData;
  }

  async process() {
    const {
      parallelStateOutputs,
    } = this.stateData.event;

    const responseData = {};
    for (const stateOutput of parallelStateOutputs) {
      const {
        data,
      } = stateOutput;

      for (const [key, value] of Object.entries(data)) {
        if (key === 'comprehend') {
          responseData.comprehend = {
            ...responseData.comprehend,
            ...value,
          };
          continue;
        }

        if (key === 'iterators') {
          for (const iterator of value) {
            const {
              data: {
                comprehend,
              },
            } = iterator;
            responseData.comprehend = {
              ...responseData.comprehend,
              ...comprehend,
            };
          }
          continue;
        }
        responseData[key] = value;
      }
    }

    return responseData;
  }
}

module.exports = StateComprehendAnalysisCompleted;
