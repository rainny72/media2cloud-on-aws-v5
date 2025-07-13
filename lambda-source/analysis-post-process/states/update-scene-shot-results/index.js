// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
} = require('node:path');
const {
  CommonUtils: {
    download,
    uploadFile,
    deleteObject,
  },
  SegmentHelper: {
    JSON_SCENESTOCHAPTERS,
    JSON_SCENESEGMENTTYPE,
  }
} = require('core-lib');
const BaseState = require('../shared/base');


class StateUpdateSceneShotResults extends BaseState {
  static opSupported(op) {
    return op === 'StateUpdateSceneShotResults';
  }

  async process() {
    try {
      const {
        data,
      } = this.stateData;

      const {
        video: {
          rekognition: {
            structural: {
              bucket,
              prefix: framePrefix,
              shotsToScenes: sceneKey,
              embeddings: embeddingsKey,
            },
          },
        },
        iterators,
      } = data;

      // clean up previous run results
      let promises = [];
      for (const name of [JSON_SCENESTOCHAPTERS, JSON_SCENESEGMENTTYPE]) {
        promises.push(deleteObject(bucket, join(framePrefix, name)));
      }
      await Promise.all(promises);

      promises = [];
      for (const name of [sceneKey, embeddingsKey]) {
        promises.push(download(bucket, join(framePrefix, name))
          .then((res) =>
            JSON.parse(res)));
      }

      const [sceneShots, frameEmbeddings] = await Promise.all(promises);

      const frameMap = {};
      const sceneMap = {};
      const shotMap = {};

      for (const frame of frameEmbeddings.frames) {
        frameMap[String(frame.frameNum)] = frame;
      }

      for (const scene of sceneShots) {
        const {
          frameRange: [fmin, fmax],
        } = scene;
        scene.smpteTimecodes = [
          frameMap[String(fmin)].smpteTimecode,
          frameMap[String(fmax)].smpteTimecode,
        ];
        sceneMap[String(scene.scene)] = scene;
        for (const shot of scene.shots) {
          shotMap[String(shot.shot)] = shot;
        }
      }

      for (const iterator of iterators) {
        for (const item of iterator) {
          const {
            shot,
            scene,
            frameSequences = [],
          } = item;

          if (scene !== undefined) {
            sceneMap[String(scene)].frameSequences = frameSequences;
          } else if (shot !== undefined) {
            shotMap[String(shot)].frameSequences = frameSequences;
          }
        }
      }

      delete data.iterators;

      await uploadFile(bucket, framePrefix, sceneKey, sceneShots);

      return this.stateData;
    } catch (e) {
      console.error(e);
      throw e;
    }
  }
}

module.exports = StateUpdateSceneShotResults;
