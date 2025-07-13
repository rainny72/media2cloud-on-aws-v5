// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  M2CException,
} = require('core-lib');
const StatePrepareFrameIterators = require('./states/prepare-frame-iterators')
const StateExtractFrames = require('./states/extract-frames');
const StateComputeFrameProperties = require('./states/compute-frame-properties');
const StatePrepareShotBoundaryFrames = require('./states/prepare-shot-boundary-frames');
const StateExtractShotBoundaryFrames = require('./states/extract-shot-boundary-frames');
const StateIteratorCompleted = require('./states/iterator-completed');
const StatePrepareEmbeddingSearch = require('./states/prepare-embedding-search');
const StateFrameExtractionCompleted = require('./states/frame-extraction-completed');

exports.handler = async (event, context) => {
  try {
    console.log(JSON.stringify(event, null, 2));
    console.log(JSON.stringify(context, null, 2));

    const {
      operation,
    } = event;

    // routing
    let instance;

    if (StatePrepareFrameIterators.opSupported(operation)) {
      instance = new StatePrepareFrameIterators(event, context);
    } else if (StateExtractFrames.opSupported(operation)) {
      instance = new StateExtractFrames(event, context);
    } else if (StateComputeFrameProperties.opSupported(operation)) {
      instance = new StateComputeFrameProperties(event, context);
    } else if (StatePrepareShotBoundaryFrames.opSupported(operation)) {
      instance = new StatePrepareShotBoundaryFrames(event, context);
    } else if (StateExtractShotBoundaryFrames.opSupported(operation)) {
      instance = new StateExtractShotBoundaryFrames(event, context);
    } else if (StateIteratorCompleted.opSupported(operation)) {
      instance = new StateIteratorCompleted(event, context);
    } else if (StatePrepareEmbeddingSearch.opSupported(operation)) {
      instance = new StatePrepareEmbeddingSearch(event, context);
    } else if (StateFrameExtractionCompleted.opSupported(operation)) {
      instance = new StateFrameExtractionCompleted(event, context);
    } else {
      throw new M2CException('invalid state');
    }

    return instance.process();
  } catch (e) {
    console.error(e);
    throw e;
  }
};
