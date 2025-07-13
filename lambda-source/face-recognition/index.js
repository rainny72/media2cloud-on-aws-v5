// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  M2CException,
} = require('core-lib');

const StatePrepareFaceEmbeddingIterators = require('./states/prepare-face-embedding-iterators');
const StateIteratorCompleted = require('./states/iterator-completed');
const StateClusterFaceEmbeddings = require('./states/cluster-face-embeddings');
const StateJobCompleted = require('./states/job-completed');

exports.handler = async (event, context) => {
  try {
    console.log(JSON.stringify(event, null, 2));
    console.log(JSON.stringify(context, null, 2));

    // routing
    const { operation } = event;
    let instance;

    if (StatePrepareFaceEmbeddingIterators.opSupported(operation)) {
      instance = new StatePrepareFaceEmbeddingIterators(event, context);
    } else if (StateIteratorCompleted.opSupported(operation)) {
      instance = new StateIteratorCompleted(event, context);
    } else if (StateClusterFaceEmbeddings.opSupported(operation)) {
      instance = new StateClusterFaceEmbeddings(event, context);
    } else if (StateJobCompleted.opSupported(operation)) {
      instance = new StateJobCompleted(event, context);
    } else {
      throw new M2CException('invalid state');
    }

    return instance.process();
  } catch (e) {
    console.error(e);
    throw e;
  }
};
