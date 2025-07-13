// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  StateData,
  M2CException,
} = require('core-lib');

const {
  Statuses: {
    Completed,
  },
} = StateData;

class StateMapIterationsCompleted {
  static opSupported(op) {
    return op === 'StateMapIterationsCompleted';
  }

  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new M2CException('stateData not StateData object');
    }
    this.$stateData = stateData;
  }

  get [Symbol.toStringTag]() {
    return 'StateMapIterationsCompleted';
  }

  get stateData() {
    return this.$stateData;
  }

  async process() {
    const {
      stateExecution: {
        Id,
        StartTime,
      },
      data: {
        iterators,
      },
    } = this.stateData.event;

    const startTime = new Date(StartTime).getTime();

    let rekognition = {};
    for (const iterator of iterators) {
      rekognition = {
        ...rekognition,
        ...iterator,
      };
    }

    const responseData = {
      video: {
        startTime,
        endTime: Date.now(),
        status: Completed,
        executionArn: Id,
        rekognition,
      },
    };

    return responseData;
  }
}

module.exports = StateMapIterationsCompleted;
