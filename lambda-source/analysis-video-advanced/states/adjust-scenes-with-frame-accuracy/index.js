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
    TYPE_BLACKFRAMES,
    groupShotsToScenes,
    tagAudioMetadataToFrames,
    tagAudioMetadataToShots,
  },
  SimpleMath: {
    cosim,
    rms,
  },
} = require('core-lib');
const BaseState = require('../shared/base');

const ENABLE_BLACKFRAMES_HOTFIX = false;

class StateAdjustScenesWithFrameAccuracy extends BaseState {
  static opSupported(op) {
    return op === 'StateAdjustScenesWithFrameAccuracy';
  }

  async process() {
    try {
      const {
        data,
      } = this.stateData;

      const {
        structural: {
          bucket,
          prefix,
          embeddings: embeddingsJson,
          similarity: similarityJson,
          framesToShots: framesToShotsJson,
          shotsToScenes: shotsToScenesJson,
          diarisation,
          loudness,
          filterSettings,
        },
      } = data;

      const {
        minFrameSimilarity,
        maxTimeDistance,
      } = filterSettings;

      const dataFiles = [
        ['frameEmbeddings', join(prefix, embeddingsJson)],
        ['similarity', join(prefix, similarityJson)],
        ['framesToShots', join(prefix, framesToShotsJson)],
        ['oShotsToScenes', join(prefix, shotsToScenesJson)],
      ];

      // audio metadata
      if ((diarisation || {}).pauseOutput) {
        dataFiles.push(['pauseTimestamps', join(diarisation.prefix, diarisation.pauseOutput)]);
      }
      if ((loudness || {}).output) {
        dataFiles.push(['loudnesses', join(loudness.prefix, loudness.output)]);
      }

      const outputs = {};
      let promises = [];

      for (const [field, key] of dataFiles) {
        promises.push(download(bucket, key)
          .then((res) => {
            outputs[field] = JSON.parse(res);
          }));
      }

      await Promise.all(promises);

      const {
        frameEmbeddings,
        similarity,
        framesToShots,
        oShotsToScenes,
        pauseTimestamps,
        loudnesses,
      } = outputs;

      const frameMap = {};
      for (const frame of frameEmbeddings.frames) {
        frameMap[String(frame.frameNum)] = frame;
      }

      if (loudnesses && pauseTimestamps) {
        tagAudioMetadataToFrames(frameEmbeddings.frames, loudnesses, pauseTimestamps);
        tagAudioMetadataToShots(frameMap, framesToShots);
      }

      let shotsToScenes = groupShotsToScenes(
        frameEmbeddings.frames,
        framesToShots,
        similarity,
        minFrameSimilarity,
        maxTimeDistance
      );

      shotsToScenes = _hotfixBlackFramesSegment(shotsToScenes);

      _computeSceneSimilarity(shotsToScenes, frameMap);
      _computeSimAcrossAllScenes(shotsToScenes, frameMap);

      // make sure to delete frame detail information.
      for (const scene of shotsToScenes) {
        for (const shot of scene.shots) {
          delete shot.frames;
        }
      }

      // print out scene
      console.log(`Merging ${oShotsToScenes.length} --> ${shotsToScenes.length}`);

      promises = [];
      for (const [name, data] of [[shotsToScenesJson, shotsToScenes], [embeddingsJson, frameEmbeddings]]) {
        promises.push(uploadFile(bucket, prefix, name, data));
      }

      await Promise.all(promises);

      const responseData = {
        structural: {
          ...data.structural,
        },
      };

      return responseData;
    } catch (e) {
      console.error(e);
      throw e;
    }
  }
}

function _computeSceneSimilarity(shotsToScenes, frameMap) {
  for (let i = 1; i < shotsToScenes.length; i += 1) {
    const pre = shotsToScenes[i - 1];
    const cur = shotsToScenes[i];

    const preFrame = frameMap[String(pre.frameRange[1])];
    const curFrame = frameMap[String(cur.frameRange[0])];
    cur.simToPreviousFrame = cosim(preFrame.embedding, curFrame.embedding);

    let preFrames = [];
    for (const { frames } of pre.shots) {
      preFrames = preFrames.concat(frames);
    }

    let curFrames = [];
    for (const { frames } of cur.shots) {
      curFrames = curFrames.concat(frames);
    }

    // cross examine the similarity
    const sims = [];
    for (const frameA of curFrames) {
      for (const frameB of preFrames) {
        const sim = cosim(frameA.embedding, frameB.embedding);
        sims.push(sim);
      }
    }

    const mean = rms(sims);
    sims.sort((a, b) => a - b);

    cur.simToPreviousScene = [sims[0], sims[sims.length - 1], mean];
  }
}

function _computeSimAcrossAllScenes(shotsToScenes, frameMap) {
  const len = shotsToScenes.length;
  const matrix = new Array(len);
  for (let i = 0; i < matrix.length; i += 1) {
    matrix[i] = new Array(len);
  }

  for (let i = 0; i < len; i += 1) {
    const cur = shotsToScenes[i];
    const { frameRange: [fmin, fmax] } = cur;
    const curFrameA = frameMap[String(fmin)];
    const curFrameB = frameMap[String(fmax)];

    if (!curFrameA || !curFrameB) {
      throw new Error(`Fail to find frames [${fmin}, ${fmax}] for scene #${cur.scene}`);
    }

    for (let j = 0; j < len; j += 1) {
      if (i === j) {
        matrix[i][j] = 1.0;
        continue;
      }

      if (j < i) {
        matrix[i][j] = matrix[j][i];
        continue;
      }

      const nex = shotsToScenes[j];
      const { frameRange: [fmin2, fmax2] } = nex;
      const nexFrameA = frameMap[String(fmin2)];
      const nexFrameB = frameMap[String(fmax2)];

      if (!nexFrameA || !nexFrameB) {
        throw new Error(`Fail to find frames [${fmin2}, ${fmax2}] for scene #${nex.scene}`);
      }

      let sim = [
        cosim(curFrameA.embedding, nexFrameA.embedding),
        cosim(curFrameA.embedding, nexFrameB.embedding),
        cosim(curFrameB.embedding, nexFrameA.embedding),
        cosim(curFrameB.embedding, nexFrameB.embedding)
      ];
      // use the highest similarity
      sim = Math.max(...sim);

      matrix[i][j] = sim;
    }
  }

  for (let i = 0; i < len; i += 1) {
    let sum = 0;
    for (let j = 0; j < len; j += 1) {
      sum += matrix[j][i];
    }
    sum = sum / len;

    shotsToScenes[i].simToAllScenes = sum;
  }
}

function _hotfixBlackFramesSegment(scenes = []) {
  if (!ENABLE_BLACKFRAMES_HOTFIX) {
    return scenes;
  }

  if (scenes.length < 2) {
    return scenes;
  }

  const groups = [];
  let curGroup = [];
  curGroup.push(scenes[0]);

  for (let i = 1; i < scenes.length; i += 1) {
    const pre = curGroup[curGroup.length - 1];
    const cur = scenes[i];

    // merge on consecutive BlackFrames segments
    if (pre.knownType === TYPE_BLACKFRAMES && pre.knownType === cur.knownType) {
      curGroup.push(cur);
      continue;
    }

    groups.push(curGroup);
    curGroup = [cur];
  }
  if (curGroup.length > 0) {
    groups.push(curGroup);
  }

  const shotsToScenes = [];
  for (const group of groups) {
    if (group.length === 1) {
      const sceneNo = shotsToScenes.length;
      shotsToScenes.push({
        ...group[0],
        scene: sceneNo,
      });
      continue;
    }

    // merge the scenes
    const {
      timestampRange: [tmin,], frameRange: [fmin,], shotRange: [smin,],
    } = group[0];
    const {
      timestampRange: [, tmax], frameRange: [, fmax], shotRange: [, smax],
    } = group[group.length - 1];

    const timestampRange = [tmin, tmax];
    const frameRange = [fmin, fmax];
    const shotRange = [smin, smax];

    let knownType;
    let loudnessLevel;
    let pauseInDialogue;
    let pauseDuration;
    let shots = [];

    for (const scene of group) {
      knownType = knownType || scene.knownType;
      loudnessLevel = loudnessLevel || scene.loudnessLevel;
      pauseInDialogue = pauseInDialogue || scene.pauseInDialogue;
      if (scene.pauseDuration !== undefined) {
        pauseDuration = (pauseDuration || 0) + scene.pauseDuration;
      }
      shots = shots.concat(scene.shots);
    }

    shots.sort((a, b) =>
      a.shot - b.shot);

    // restamp the scene number
    const sceneNo = shotsToScenes.length;
    shotsToScenes.push({
      scene: sceneNo,
      timestampRange,
      frameRange,
      shotRange,
      knownType,
      loudnessLevel,
      pauseInDialogue,
      pauseDuration,
      shots,
    });
  }

  // restamp the scene number at frame level
  for (const { scene: sceneNo, shots } of shotsToScenes) {
    for (const { frames } of shots) {
      for (const frame of frames) {
        frame.scene = sceneNo;
      }
    }
  }

  return shotsToScenes;
}

module.exports = StateAdjustScenesWithFrameAccuracy;
