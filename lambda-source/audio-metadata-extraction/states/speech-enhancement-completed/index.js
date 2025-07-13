// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
} = require('node:path');
const {
  CommonUtils: { headObject },
} = require('core-lib');
const BaseState = require('../shared/base');

class StateSpeedEnhancementCompleted extends BaseState {
  static opSupported(op) {
    return op === 'StateSpeedEnhancementCompleted';
  }

  async process() {
    const { itemData } = this.stateData;

    try {
      const { bucket, prefix, enhancedAudio } = itemData;

      const enhancedOutput = await headObject(bucket, join(prefix, enhancedAudio))
        .then(() => true)
        .catch(() => false);

      if (enhancedOutput) {
        itemData.original = itemData.name;
        itemData.name = enhancedAudio;
      }
    } catch (e) {
      console.log(e);
    }
    return itemData;
  }
}

module.exports = StateSpeedEnhancementCompleted;
