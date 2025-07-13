// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const BaseState = require('../shared/base');

class StateFrameExtractionCompleted extends BaseState {
  static opSupported(op) {
    return op === 'StateFrameExtractionCompleted';
  }

  get data() {
    return this.stateData.data;
  }

  async process() {
    try {
      const {
        frameExtraction,
        iterators = [],
      } = this.data;

      if (iterators.length === 0) {
        throw new Error('iterators is empty');
      }

      const { similarity } = iterators[0];
      frameExtraction.similarity = similarity;

      return this.stateData;
    } catch (e) {
      console.error(e);
      throw e;
    }
  }
}

module.exports = StateFrameExtractionCompleted;
