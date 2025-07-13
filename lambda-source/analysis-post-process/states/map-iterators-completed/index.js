// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
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
} = require('core-lib');
const BaseState = require('../shared/base');

class StateMapIterationCompleted extends BaseState {
  static opSupported(op) {
    return op === 'StateMapIterationCompleted';
  }

  async process() {
    const {
      input: {
        destination: {
          bucket,
        },
      },
      data,
    } = this.stateData;

    const {
      iterators,
      video: {
        rekognition: {
          structural: {
            prefix: framePrefix,
            scenesToChapters: chapterKey,
          },
        },
      },
    } = data;

    if (iterators.length === 0) {
      return {};
    }

    let chapterGroups = await download(bucket, join(framePrefix, chapterKey))
      .then((res) =>
        JSON.parse(res));

    const chapterMap = {};
    for (const group of chapterGroups) {
      const {
        chapter: id,
      } = group;
      const strId = String(id);
      chapterMap[strId] = group;
    }

    for (const iterator of iterators) {
      for (const item of iterator) {
        const {
          chapter: id,
          sequenceImages,
        } = item;
        chapterMap[String(id)].frameSequences = sequenceImages;
      }
    }

    chapterGroups = Object.values(chapterMap);
    await uploadFile(bucket, framePrefix, chapterKey, chapterGroups);

    delete data.iterators;

    return data.video.rekognition.structural;
  }

  setCompleted() {
    this.stateData.status = Completed;
    return this.stateData;
  }
}

module.exports = StateMapIterationCompleted;
