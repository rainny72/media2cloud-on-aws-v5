// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
} = require('node:path');
const {
  CommonUtils: {
    download,
    uploadFile,
  },
  SegmentHelper: {
    JSON_SHOTBOUNDARYFRAMES,
    MAXBOUNDARYFRAMES,
    groupFramesToShots,
  },
} = require('core-lib');
const BaseState = require('../shared/base');

class StatePrepareShotBoundaryFrames extends BaseState {
  static opSupported(op) {
    return op === 'StatePrepareShotBoundaryFrames';
  }

  async process() {
    const {
      itemData,
    } = this.stateData;
    const {
      output: {
        bucket,
        framePrefix,
      },
      embeddings: embeddingsJson,
      filterSettings: {
        minFrameSimilarity,
      },
    } = itemData;

    if (embeddingsJson === undefined) {
      throw new Error('fail to collect frame embeddings result');
    }

    const frameEmbeddings = await download(bucket, join(framePrefix, embeddingsJson))
      .then((res) =>
        JSON.parse(res));

    frameEmbeddings.frames.sort((a, b) =>
      a.frameNum - b.frameNum);

    // prepare for frame accurarcy black frames
    const shotGroups = groupFramesToShots(frameEmbeddings.frames, minFrameSimilarity);
    const boundaries = _findShotBoundaryFrames(shotGroups);

    const filtered = boundaries.filter((x) => x.step < 0);
    console.log(`Number of boundaries = ${boundaries.length}. ${filtered.length} boundaries are either black or monochrome shots.`);

    await uploadFile(bucket, framePrefix, JSON_SHOTBOUNDARYFRAMES, boundaries);
    itemData.shotBoundaryFrames = JSON_SHOTBOUNDARYFRAMES;

    return this.stateData;
  }
}

function _findShotBoundaryFrames(shotGroups) {
  let boundaries = [];

  // collect the boundary frames:
  // black, monochrome, and shot with single frame
  for (let i = 1; i < shotGroups.length; i += 1) {
    const pre = shotGroups[i - 1];
    const cur = shotGroups[i];

    const preFrame = pre[pre.length - 1];
    const curFrame = cur[0];

    const boundary = {
      frameFrom: preFrame,
      frameTo: curFrame,
      maxFrames: MAXBOUNDARYFRAMES,
    };

    if (preFrame.knownType || curFrame.knownType) {
      boundary.maxFrames = -1; // every frame
    }

    boundaries.push(boundary);
  }

  return boundaries;
}

module.exports = StatePrepareShotBoundaryFrames;
