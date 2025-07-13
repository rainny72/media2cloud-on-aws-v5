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
    toHHMMSS,
  },
  TimecodeUtils: {
    isDropFrame,
    framerateToEnum,
    fromTimecode,
    toTimecode,
  },
  SimpleGeometry: {
    timeIntersected,
  },
  SegmentHelper: {
    JSON_SCENESTOCHAPTERS,
  }
} = require('core-lib');
const BaseState = require('../shared/base');

const CHAPTERS_PER_ITERATOR = 20;

class StateScenesToChapters extends BaseState {
  static opSupported(op) {
    return op === 'StateScenesToChapters';
  }

  async process() {
    const {
      uuid,
      input: {
        destination: {
          bucket: proxyBucket,
        },
        aiOptions: {
          filters = {},
        },
      },
      data,
    } = this.stateData;

    // DISABLE IT FOR NOW
    const disabled = true;
    if (disabled) {
      data.iterators = [];
      return this.setCompleted();
    }

    const {
      video: {
        rekognition: {
          structural: {
            prefix: framePrefix,
            embeddings: embeddingsKey,
            shotsToScenes: sceneKey,
          },
        },
      },
      audio = {},
    } = data;

    let sceneShots;
    let audioSegments;

    let promises = [];

    promises.push(download(proxyBucket, join(framePrefix, sceneKey))
      .then((res) => {
        sceneShots = JSON.parse(res);
      }));

    if ((audio.audioSegments || {}).output) {
      promises.push(download(proxyBucket, join(audio.audioSegments.prefix, audio.audioSegments.output))
        .then((res) => {
          audioSegments = JSON.parse(res);
        }));
    }

    const filterSettings = {};
    for (const category of Object.values(filters)) {
      for (const [key, value] of Object.entries(category)) {
        filterSettings[key] = value;
      }
    }

    await Promise.all(promises);

    //
    // TO BE CONTINUED
    //
    if (((audioSegments || {}).conversationAnalysis || {}).topic_change_events === undefined) {
      data.iterators = [];
      return this.setCompleted();
    }

    const {
      conversationAnalysis: {
        topic_change_events,
      },
    } = audioSegments;

    const topicTimeRanges = [];
    for (const { start, end } of topic_change_events) {
      topicTimeRanges.push([start, end]);
    }

    let chapterGroups = [];

    let duped = sceneShots.slice();

    for (const [tmin, tmax] of topicTimeRanges) {
      const subGroup = [];
      while (duped.length) {
        const {
          timestampRange: [smin, smax],
        } = duped[0];
        if (smin > tmax) {
          break;
        }

        if (smax < tmin) {
          subGroup.push(duped.shift());
          continue;
        }

        if (timeIntersected([smin, smax], [tmin, tmax])) {
          subGroup.push(duped.shift());
          continue;
        }
        throw new Error('LOGIC ERROR');
      }

      if (subGroup.length > 0) {
        chapterGroups.push(subGroup);
      }
    }

    if (duped.length > 0) {
      chapterGroups.push(duped);
    }

    duped = chapterGroups;
    chapterGroups = [];
    for (let i = 0; i < duped.length; i += 1) {
      const first = duped[i][0];
      const last = duped[i][duped[i].length - 1];

      const sceneRange = [first.scene, last.scene];
      const timestampRange = [first.timestampRange[0], last.timestampRange[1]];
      const frameRange = [first.frameRange[0], last.frameRange[1]];
      chapterGroups.push({
        chapter: i,
        sceneRange,
        timestampRange,
        frameRange,
        scenes: duped[i],
      });
    }

    const {
      input: {
        duration,
        framerate,
        video: {
          timeCodeFirstFrame,
        },
      },
    } = this.stateData;
    const dropFrame = isDropFrame(timeCodeFirstFrame);
    const enumFPS = framerateToEnum(framerate);
    const timecodeFrameOffset = fromTimecode(enumFPS, timeCodeFirstFrame);

    for (const chapter of chapterGroups) {
      const {
        chapter: chapterId,
        timestampRange: [tmin, tmax],
        frameRange: [fmin, fmax],
      } = chapter;

      const timecodeA = toTimecode(enumFPS, (timecodeFrameOffset + fmin), dropFrame)[0];
      const timecodeB = toTimecode(enumFPS, (timecodeFrameOffset + fmax), dropFrame)[0];
      console.log(`Chapter #${String(chapterId).padStart(3, '0')}: ${fmin}F -> ${fmax}F: ${toHHMMSS(tmin, true)} -> ${toHHMMSS(tmax, true)} (${timecodeA} -> ${timecodeB})`);
    }

    console.log(`Total duration: ${toHHMMSS(duration, true)}`);

    const name = JSON_SCENESTOCHAPTERS;

    await uploadFile(proxyBucket, framePrefix, name, chapterGroups)
      .then(() =>
        data.video.rekognition.structural.scenesToChapters = name);

    const numChapters = chapterGroups.length;
    const nIterations = Math.ceil(numChapters / CHAPTERS_PER_ITERATOR);

    data.iterators = [];

    for (let i = 0; i < nIterations; i += 1) {
      data.iterators.push({
        uuid,
        bucket: proxyBucket,
        prefix: framePrefix,
        name,
        embeddings: embeddingsKey,
        framerate,
        timeCodeFirstFrame,
        nIterations,
      });
    }

    return this.setCompleted();
  }

  setCompleted() {
    this.stateData.status = Completed;
    return this.stateData;
  }
}

module.exports = StateScenesToChapters;
