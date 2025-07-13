// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const BaseState = require('../shared/base');

class StateJobCompleted extends BaseState {
  static opSupported(op) {
    return op === 'StateJobCompleted';
  }

  async process() {
    const {
      stateExecution: {
        StartTime,
        Input: {
          uuid,
          input,
          data,
        }
      },
      parallelStateOutputs,
    } = this.stateData;

    let responseData = {
      ...data,
      startTime: new Date(StartTime).getTime(),
      endTime: Date.now(),
    };

    for (const stateOutput of parallelStateOutputs) {
      const { input, data } = stateOutput;

      // likely pass through, skip it
      if (input !== undefined && data !== undefined) {
        continue;
      }

      responseData = {
        ...responseData,
        ...stateOutput,
      };
    }

    return {
      uuid,
      input,
      data: responseData,
    }
  }
}

module.exports = StateJobCompleted;
