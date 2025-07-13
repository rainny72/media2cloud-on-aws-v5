// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  StateData: {
    Statuses: {
      Completed,
    },
  },
} = require('core-lib');
const BaseState = require('../shared/base');

class StateJobCompleted extends BaseState {
  static opSupported(op) {
    return op === 'StateJobCompleted';
  }

  async process() {
    const {
      stateExecution: {
        Input: stateData,
      },
      parallelStateOutputs,
    } = this.event;

    const {
      data: {
        video: {
          rekognition,
        },
      },
    } = stateData;

    for (const stateOutput of parallelStateOutputs) {
      for (const [key, value] of Object.entries(stateOutput)) {
        if (rekognition[key] === undefined) {
          rekognition[key] = value;
        } else {
          rekognition[key] = {
            ...rekognition[key],
            ...value,
          };
        }
      }
    }

    stateData.status = Completed;

    return stateData;
  }
}

module.exports = StateJobCompleted;
