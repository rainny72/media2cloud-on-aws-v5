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
} = require('core-lib');
const BaseState = require('../shared/base');

class StateIteratorCompleted extends BaseState {
  static opSupported(op) {
    return op === 'StateIteratorCompleted';
  }

  async process() {
    const {
      itemId,
      itemData,
    } = this.stateData;
    const {
      output: {
        bucket,
        framePrefix,
      },
      embeddings: embeddingsJson,
      shotBoundaryFrames: shotBoundaryFramesJson,
    } = itemData;

    if (embeddingsJson === undefined || shotBoundaryFramesJson === undefined) {
      throw new Error('fail to collect frame embeddings or shot boundary frames result');
    }

    let frameEmbeddings;
    let shotBoundaryFrames;

    let promises = [];

    promises.push(download(bucket, join(framePrefix, embeddingsJson))
      .then((res) => {
        frameEmbeddings = JSON.parse(res);
      }));

    promises.push(download(bucket, join(framePrefix, shotBoundaryFramesJson))
      .then((res) => {
        shotBoundaryFrames = JSON.parse(res);
      }));

    await Promise.all(promises);

    const frameMap = {};
    for (const frame of frameEmbeddings.frames) {
      frameMap[String(frame.frameNum)] = frame;
    }

    for (const { response } of shotBoundaryFrames) {
      const {
        newFrames,
        titanApiCount,
      } = response;

      for (const frame of newFrames) {
        if (frameMap[String(frame.frameNum)] === undefined) {
          frameMap[String(frame.frameNum)] = frame;
        }
      }

      if (titanApiCount !== undefined) {
        frameEmbeddings.titanApiCount += titanApiCount;
      }
    }

    frameEmbeddings.frames = Object.values(frameMap)
      .sort((a, b) =>
        a.frameNum - b.frameNum);

    await uploadFile(bucket, framePrefix, embeddingsJson, frameEmbeddings);

    return {
      itemId,
      ...itemData,
      titanApiCount: frameEmbeddings.titanApiCount,
    };
  }
}

module.exports = StateIteratorCompleted;
