// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  M2CException,
} = require('core-lib');

const StatePrepareTranscodeIterators = require('./states/prepare-transcode-iterators');
const StateTranscodeVideo = require('./states/transcode-video');
const StateTranscodeCompleted = require('./states/transcode-completed');

exports.handler = async (event, context) => {
  try {
    console.log(JSON.stringify(event, null, 2));
    console.log(JSON.stringify(context, null, 2));

    const {
      operation,
    } = event;

    // routing
    let instance;

    if (StatePrepareTranscodeIterators.opSupported(operation)) {
      instance = new StatePrepareTranscodeIterators(event, context);
    } else if (StateTranscodeVideo.opSupported(operation)) {
      instance = new StateTranscodeVideo(event, context);
    } else if (StateTranscodeCompleted.opSupported(operation)) {
      instance = new StateTranscodeCompleted(event, context);
    } else {
      throw new M2CException('invalid state');
    }

    return instance.process();
  } catch (e) {
    console.error(e);
    throw e;
  }
};
