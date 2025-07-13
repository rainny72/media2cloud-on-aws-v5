// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  parse,
  join,
} = require('node:path');
const {
  StateData: {
    Statuses: {
      Completed,
    },
  },
  CommonUtils: {
    download,
    uploadFile,
  },
  SegmentHelper: {
    JSON_FACEEMBEDDINGS,
  },
} = require('core-lib');
const BaseState = require('../shared/base');

const JSON_SNAPSHOT_FRAMSHOTS = 'snapshot_frameshots.json';
const FRAMES_PER_ITERATION = 1200;
const DEFAULT_FACE_THRESHOLD = {
  minFaceW: 64,
  minFaceH: 64,
  maxPitch: 0,
  maxRoll: 0,
  maxYaw: 0,
  minConfidence: 0.80,
};

class StatePrepareFaceEmbeddingIterators extends BaseState {
  static opSupported(op) {
    return op === 'StatePrepareFaceEmbeddingIterators';
  }

  get data() {
    return this.stateData.data;
  }

  get facerecognition() {
    return this.data.facerecognition;
  }

  get bucket() {
    return this.facerecognition.bucket;
  }

  get aiOptions() {
    return this.facerecognition.aiOptions;
  }

  get filterSettings() {
    return this.facerecognition.filterSettings;
  }

  get frameExtraction() {
    return this.facerecognition.frameExtraction;
  }

  get framePrefix() {
    return this.frameExtraction.framePrefix;
  }

  get embeddings() {
    return this.frameExtraction.embeddings;
  }

  async process() {
    try {
      const filterSettings = this.filterSettings;
      for (const [k, v] of Object.entries(DEFAULT_FACE_THRESHOLD)) {
        if (filterSettings[k] === undefined) {
          filterSettings[k] = v;
        }
      }

      // use lower confidence for faceapi
      // filterSettings.minConfidence = 0.10;
      filterSettings.maxResults = 5;

      const outputs = {};
      let promises = [];

      const bucket = this.bucket;
      const framePrefix = this.framePrefix;
      const dataFiles = [
        ['frameEmbeddings', join(framePrefix, this.embeddings)],
      ];
      for (const [field, key] of dataFiles) {
        promises.push(download(bucket, key)
          .then((res) => {
            outputs[field] = JSON.parse(res);
          }));
      }
      await Promise.all(promises);

      const {
        frameEmbeddings: { imageWxH, frames },
      } = outputs;

      const [framesToShots, snapshot] = await this.snapshotOfFrameShots(frames);
      this.facerecognition.frameshotSnapshot = snapshot;

      const iterators = [];
      let perIterator = [];
      while (framesToShots.length) {
        const shot = framesToShots.shift();

        for (const frame of shot) {
          perIterator.push({
            frameNum: frame.frameNum,
            timestampMillis: frame.timestampMillis,
            name: frame.name,
            shot: frame.shot,
          });
        }

        if (perIterator.length >= FRAMES_PER_ITERATION) {
          iterators.push(perIterator);
          perIterator = [];
        }
      }
      if (perIterator.length > 0) {
        iterators.push(perIterator);
        perIterator = [];
      }

      promises = [];

      const parsed = parse(JSON_FACEEMBEDDINGS);
      for (let i = 0; i < iterators.length; i += 1) {
        // face embedding JSON file
        const itemId = i;
        const name = `${parsed.name}_${itemId}.json`;
        const faceEmbeddings = {
          imageWxH,
          frames: iterators[i],
        };

        promises.push(uploadFile(bucket, framePrefix, name, faceEmbeddings)
          .then(() => ({
            itemId,
            bucket,
            prefix: framePrefix,
            faceEmbeddings: name,
            filterSettings,
            aiOptions: this.aiOptions,
          })));
      }

      this.data.iterators = await Promise.all(promises);

      return this.setCompleted();
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  setCompleted() {
    this.stateData.status = Completed;
    return this.stateData;
  }

  async snapshotOfFrameShots(frames = []) {
    if (frames.length === 0) {
      throw new Error('No frame embedding?');
    }

    const framesToShots = [];
    let curShot = [frames[0]];

    for (let i = 1; i < frames.length; i += 1) {
      const pre = curShot[curShot.length - 1];
      const cur = frames[i];
      if (cur.shot !== pre.shot) {
        framesToShots.push(curShot);
        curShot = [];
      }
      curShot.push(cur);
    }

    if (curShot.length > 0) {
      framesToShots.push(curShot);
      curShot = [];
    }

    const shotMap = {};
    for (const framesInCurrentShot of framesToShots) {
      framesInCurrentShot.sort((a, b) => a.timestampMillis - b.timestampMillis);

      const {
        timestampMillis: t0, frameNum: f0, shot,
      } = framesInCurrentShot[0];
      const {
        timestampMillis: tN, frameNum: fN,
      } = framesInCurrentShot[framesInCurrentShot.length - 1];

      const shotId = String(shot);
      shotMap[shotId] = {
        shot,
        timestampRange: [t0, tN],
        frameRange: [f0, fN],
      };
    }

    const {
      bucket, frameExtraction: { framePrefix },
    } = this.facerecognition;

    const name = JSON_SNAPSHOT_FRAMSHOTS;
    await uploadFile(bucket, framePrefix, name, shotMap);

    return [framesToShots, name];
  }
}

module.exports = StatePrepareFaceEmbeddingIterators;
