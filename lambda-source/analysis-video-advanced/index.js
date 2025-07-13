// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  M2CException,
} = require('core-lib');

const StateShotsToScenes = require('./states/shots-to-scenes');
const StateFindFrameAccurateBoundary = require('./states/find-frame-accurate-boundary');
const StateRefineEmbeddingSearch = require('./states/refine-embedding-search');
const StateAdjustScenesWithFrameAccuracy = require('./states/adjust-scenes-with-frame-accuracy');

exports.handler = async (event, context) => {
  try {
    console.log(JSON.stringify(event, null, 2));
    console.log(JSON.stringify(context, null, 2));

    const {
      operation,
    } = event;

    // routing
    let instance;

    if (StateShotsToScenes.opSupported(operation)) {
      instance = new StateShotsToScenes(event, context);
    } else if (StateFindFrameAccurateBoundary.opSupported(operation)) {
      instance = new StateFindFrameAccurateBoundary(event, context);
    } else if (StateRefineEmbeddingSearch.opSupported(operation)) {
      instance = new StateRefineEmbeddingSearch(event, context);
    } else if (StateAdjustScenesWithFrameAccuracy.opSupported(operation)) {
      instance = new StateAdjustScenesWithFrameAccuracy(event, context);
    } else {
      throw new M2CException('invalid state');
    }

    return instance.process();
  } catch (e) {
    console.error(e);
    throw e;
  }
};
