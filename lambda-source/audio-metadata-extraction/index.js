// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  M2CException,
} = require('core-lib');

const StatePrepareMetadataIterators = require('./states/prepare-metadata-iterators');
const StateSegmentAudio = require('./states/segment-audio');
const StateSpeedEnhancementCompleted = require('./states/speech-enhancement-completed');
const StateMergeMetadataResults = require('./states/merge-metadata-results');

exports.handler = async (event, context) => {
  try {
    console.log(JSON.stringify(event, null, 2));
    console.log(JSON.stringify(context, null, 2));

    // routing
    const { operation } = event;
    let instance;

    if (StatePrepareMetadataIterators.opSupported(operation)) {
      instance = new StatePrepareMetadataIterators(event, context);
    } else if (StateSegmentAudio.opSupported(operation)) {
      instance = new StateSegmentAudio(event, context);
    } else if (StateSpeedEnhancementCompleted.opSupported(operation)) {
      instance = new StateSpeedEnhancementCompleted(event, context);
    } else if (StateMergeMetadataResults.opSupported(operation)) {
      instance = new StateMergeMetadataResults(event, context);
    } else {
      throw new M2CException('invalid state');
    }

    return instance.process();
  } catch (e) {
    console.error(e);
    throw e;
  }
};
