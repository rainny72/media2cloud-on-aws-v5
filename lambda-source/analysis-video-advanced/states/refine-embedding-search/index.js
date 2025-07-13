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
  JimpHelper: {
    compareHashes,
  },
  SimpleMath: {
    cosim,
  },
  SegmentHelper: {
    groupFramesToShots,
    shotGroupAttributes,
  },
} = require('core-lib');
const BaseState = require('../shared/base');

class StateRefineEmbeddingSearch extends BaseState {
  static opSupported(op) {
    return op === 'StateRefineEmbeddingSearch';
  }

  async process() {
    try {
      const {
        data,
      } = this.stateData;

      const {
        structural: {
          bucket,
          frameExtraction: {
            framePrefix,
          },
          diarisation,
          loudness,
          embeddings: embeddingsJson,
          similarity: similarityJson,
          framesToShots: framesToShotsJson,
          shotsToScenes: shotsToScenesJson,
          filterSettings,
        },
        iterators,
      } = data;

      const {
        minFrameSimilarity,
      } = filterSettings;

      let startTime = Date.now();
      if (data.structural.startTime !== undefined) {
        startTime = data.structural.startTime;
      }

      let promises = [];
      for (const name of [embeddingsJson]) {
        promises.push(download(bucket, join(framePrefix, name))
          .then((res) =>
            JSON.parse(res)));
      }

      let [frameEmbeddings] = await Promise.all(promises);
      const oNumFrames = frameEmbeddings.frames.length;

      const frameMap = {};
      for (const frame of frameEmbeddings.frames) {
        frameMap[String(frame.frameNum)] = frame;
      }

      promises = [];
      for (const iterator of iterators) {
        const {
          itemData: {
            sceneBoundary: boundaryKey,
          },
        } = iterator;

        if (boundaryKey) {
          promises.push(_addNewFrames(bucket, join(framePrefix, boundaryKey), frameMap));
        }
      }

      promises = await Promise.all(promises);

      for (const titanApiCount of promises) {
        if (titanApiCount === undefined) {
          continue;
        }
        frameEmbeddings.titanApiCount += titanApiCount;
      }

      frameEmbeddings.frames = Object.values(frameMap);
      frameEmbeddings.frames.sort((a, b) =>
        a.frameNum - b.frameNum);

      // patch new frames
      frameEmbeddings.frames = _patchNewFrames(frameEmbeddings.frames);

      promises = [];

      // regroup and restamp shots
      const shotGroups = _regroupFrameShots(frameEmbeddings.frames, minFrameSimilarity);
      promises.push(_updateFramesToShots(bucket, framePrefix, framesToShotsJson, shotGroups));

      // update frame embeddings as well
      promises.push(_updateFrameEmbeddings(bucket, framePrefix, embeddingsJson, frameEmbeddings));

      await Promise.all(promises);

      // print out scene
      console.log(`Frames: ${oNumFrames} --> ${frameEmbeddings.frames.length}`)

      data.structural = {
        bucket,
        prefix: framePrefix,
        embeddings: embeddingsJson,
        similarity: similarityJson,
        framesToShots: framesToShotsJson,
        shotsToScenes: shotsToScenesJson,
        diarisation,
        loudness,
        filterSettings,
        numFrames: frameEmbeddings.frames.length,
        numShots: shotGroups.length,
        titanApiCount: frameEmbeddings.titanApiCount,
        startTime,
        endTime: Date.now(),
      };

      data.iterators = [{
        bucket,
        prefix: framePrefix,
        embeddings: embeddingsJson,
        similarity: similarityJson,
      }];

      return this.stateData;
    } catch (e) {
      console.error(e);
      throw e;
    }
  }
}

async function _addNewFrames(bucket, key, frameMap) {
  const boundaries = await download(bucket, key)
    .then((res) =>
      JSON.parse(res));

  let totalTitanApiCount = 0;

  for (const { response } of boundaries) {
    if (response === undefined) {
      continue;
    }

    const {
      newFrames,
      titanApiCount,
    } = response;

    for (const frame of newFrames) {
      const strId = String(frame.frameNum);
      if (frameMap[strId] === undefined) {
        frameMap[strId] = frame;
      } else {
        const oFrame = frameMap[strId];
        if (oFrame.shot !== frame.shot || oFrame.scene !== frame.scene) {
          frameMap[strId] = frame;
        }
      }
      // mark dirty to recalibrate hash distance and embed similarity
      frame.dirty = true;
    }

    totalTitanApiCount += titanApiCount;
  }

  return totalTitanApiCount;
}

function _regroupFrameShots(frames, minFrameSimilarity) {
  const shotGroups = groupFramesToShots(frames, minFrameSimilarity);

  for (let i = 0; i < shotGroups.length; i += 1) {
    for (const frame of shotGroups[i]) {
      frame.shot = i;
    }
  }

  return shotGroups;
}

function _patchNewFrames(frames) {
  for (let i = 1; i < frames.length; i += 1) {
    const pre = frames[i - 1];
    const cur = frames[i];
    const nex = frames[i + 1];

    if (!cur.dirty) {
      continue;
    }

    pre.hashDistance = compareHashes(pre.hash, cur.hash);
    pre.embedSimilarity = cosim(pre.embedding, cur.embedding);

    if (nex) {
      cur.hashDistance = compareHashes(cur.hash, nex.hash);
      cur.embedSimilarity = cosim(cur.embedding, nex.embedding);
    }

    delete cur.dirty;
  }

  return frames;
}

async function _updateFrameEmbeddings(bucket, prefix, name, frameEmbeddings) {
  return uploadFile(bucket, prefix, name, frameEmbeddings);
}

async function _updateFramesToShots(bucket, prefix, name, shotGroups) {
  const shotAttributes = [];

  for (const shotGroup of shotGroups) {
    const shotId = shotGroup[0].shot;
    const attribute = shotGroupAttributes(shotId, shotGroup);
    shotAttributes.push(attribute);
  }

  return uploadFile(bucket, prefix, name, shotAttributes)
    .then(() => shotAttributes);
}

module.exports = StateRefineEmbeddingSearch;
