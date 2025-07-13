// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
} = require('node:path');
const {
  CommonUtils: {
    download,
    uploadFile,
    toHHMMSS,
    freeHeapMemory,
  },
  SimpleMath: {
    cosim,
  },
  SimpleGeometry: {
    timeIntersected,
  },
  SegmentHelper: {
    JSON_ADBREAK,
    TYPE_COLORBARS,
    TYPE_OPENINGCREDITS,
    TYPE_MAINPROGRAM,
    TYPE_BLACKFRAMES,
    TYPE_ENDCREDITS,
    TYPE_TECHNICAL_SLATE,
    TYPE_IDENTS,
    // TYPE_INTRO,
    // TYPE_TITLE,
  },
} = require('core-lib');
const BaseState = require('../shared/base');

const REK_COLORBARS = 'ColorBars';
const REK_ENDCREDITS = 'EndCredits';
const REK_BLACKFRAMES = 'BlackFrames';
const REK_OPENINGCREDITS = 'OpeningCredits';
const REK_STUDIOLOGO = 'StudioLogo';
const REK_SLATE = 'Slate';
const REK_CONTENT = 'Content';

class StateGenerateAdBreaks extends BaseState {
  static opSupported(op) {
    return op === 'StateGenerateAdBreaks';
  }

  async process() {
    const {
      input: {
        destination: {
          prefix: outPrefix,
        },
        audio: audioMeta = {},
      },
      data: {
        video: {
          rekognition,
        },
        audio = {},
      },
    } = this.stateData;

    const {
      structural: videoMeta,
    } = rekognition;

    const {
      bucket,
      filterSettings,
    } = videoMeta;

    const startTime = Date.now();

    // video metadata
    const dataFiles = {
      frameEmbeddings: join(videoMeta.prefix, videoMeta.embeddings),
      shotsToScenes: join(videoMeta.prefix, videoMeta.shotsToScenes),
      smpteElements: join(videoMeta.prefix, videoMeta.smpteElements),
    };

    // audio metadata
    if ((audioMeta.diarisation || {}).pauseOutput) {
      dataFiles.pauseInDialogues = join(audioMeta.diarisation.prefix, audioMeta.diarisation.pauseOutput);
    }
    if ((audioMeta.loudness || {}).output) {
      dataFiles.loudnesses = join(audioMeta.loudness.prefix, audioMeta.loudness.output);
    }
    // audio analysis
    if ((audio.audioSegments || {}).output) {
      dataFiles.audioSegments = join(audio.audioSegments.prefix, audio.audioSegments.output);
    }

    let promises = [];

    for (const [field, jsonKey] of Object.entries(dataFiles)) {
      promises.push(download(bucket, jsonKey)
        .then((res) => {
          dataFiles[field] = JSON.parse(res);
        }));
    }

    await Promise.all(promises);

    const {
      frameEmbeddings,
      shotsToScenes,
      smpteElements,
      pauseInDialogues = [],
      loudnesses = [],
      audioSegments,
    } = dataFiles;

    const frameMap = {};
    for (const frame of frameEmbeddings.frames) {
      frameMap[String(frame.frameNum)] = frame;
    }

    // free up memory
    frameEmbeddings.frames = undefined;
    freeHeapMemory();

    const candidates = _searchForBreaks({
      frameMap,
      shotsToScenes,
      smpteElements,
      audioSegments,
      pauseInDialogues,
      loudnesses,
      filterSettings,
    });

    const framePrefix = videoMeta.prefix;
    const breakCandidates = _toAdBreakCandidates(candidates, frameMap);

    const adbreak = {
      framePrefix,
      adbreak: breakCandidates,
    };

    const prefix = join(outPrefix, 'metadata', 'adbreak');
    const output = JSON_ADBREAK;

    await uploadFile(bucket, prefix, output, adbreak);

    rekognition.adbreak = {
      prefix,
      output,
      startTime,
      endTime: Date.now(),
    };

    return {
      ...rekognition,
    };
  }
}

function _toAdBreakCandidates(candidates, frameMap) {
  const breakCandidates = [];

  for (const candidate of candidates) {
    const {
      type,
      suggestedType,
      knownType,
      pauseInDialogue,
      segmentType,
      timestampRange,
      smpteTimecodes,
      shotRange,
      frameRange,
      frameSequences,
      weight,
      reason,
      chosenSim,
    } = candidate;

    // For backward compatibility only
    const technicalCueType = _toRekognitionTechnicalCueType(type, suggestedType, knownType, segmentType);

    const breakType = 'SCENE_BEGIN';
    const breakNo = breakCandidates.length;
    const timestamp = timestampRange[0];
    const smpteTimestamp = smpteTimecodes[0];
    const frame = frameMap[String(frameRange[0])];
    const key = frame.name;
    const images = frameSequences;

    const scene = {
      sceneNo: candidate.scene,
      shotStart: shotRange[0],
      frameStart: frameRange[0],
      timeStart: timestampRange[0],
      smpteStart: smpteTimecodes[0],
      shotEnd: shotRange[1],
      frameEnd: frameRange[1],
      timeEnd: timestampRange[1],
      smpteEnd: smpteTimecodes[1],
      duration: timestampRange[1] - timestampRange[0],
      type,
      suggestedType,
      segmentType,
      knownType,
      technicalCueType,
      pauseIn: pauseInDialogue,
    };

    breakCandidates.push({
      breakType,
      timestamp,
      smpteTimestamp,
      weight,
      reason,
      chosenSim,
      key,
      scene,
      breakNo,
      images,
    });
  }

  // sort by weight, then by timestamp
  breakCandidates.sort((a, b) => {
    if (b.weight > a.weight) {
      return -1;
    }
    if (b.weight < a.weight) {
      return 1;
    }
    return a.timestamp - b.timestamp;
  });

  for (let i = 0; i < breakCandidates.length; i += 1) {
    breakCandidates[i].ranking = i;
  }

  // sort ascending
  breakCandidates.sort((a, b) =>
    a.timestamp - b.timestamp);

  return breakCandidates;
}

function _searchForBreaks(data) {
  const {
    frameMap,
    shotsToScenes,
    smpteElements: {
      smpteElements,
    },
    pauseInDialogues,
    loudnesses,
    filterSettings: {
      breakInterval = 5 * 60 * 1000,
      breakOffset = 2.5 * 60 * 1000,
    },
  } = data;

  const sceneMap = {};
  for (const scene of shotsToScenes) {
    sceneMap[String(scene.scene)] = scene;
  }

  let FFOC = smpteElements.findIndex((x) =>
    x.label === 'FFOC');

  let LFOC = smpteElements.findIndex((x) =>
    x.label === 'LFOC');

  let programElements = smpteElements;
  if (FFOC >= 0 && LFOC >= 0) {
    programElements = smpteElements.slice(FFOC, LFOC + 1);
  }

  // programElements = smpteElements;

  const programTimeRange = [
    programElements[0].timestampMillis,
    programElements[programElements.length - 1].timestampMillis,
  ];

  console.log(`Programme start/end time: ${toHHMMSS(programTimeRange[0], true)} -> ${toHHMMSS(programTimeRange[1], true)}`);

  let candidates = {};

  // find breaks from program elements
  for (const element of programElements) {
    const { frameNum, type, label } = element;

    if (type !== TYPE_OPENINGCREDITS && ['FFTC', 'FFCL', 'FFCB', 'FPCI'].includes(label)) {
      const frame = frameMap[String(frameNum)];
      const sceneId = String(frame.scene)
      const scene = sceneMap[sceneId];

      if (type === 'FFCB') {
        scene.weight = 1.0;
        scene.reason = 'Blackframe scene';
        scene.chosenSim = 0.0;
      } else {
        scene.weight = 0.8;
        scene.reason = 'Transition or title scene';
        scene.chosenSim = 0.0;
      }
      candidates[sceneId] = scene;
    }
  }

  // Now, search for breaks at break interval
  let breakAt = programTimeRange[0] + breakInterval;

  for (breakAt; breakAt < programTimeRange[1]; breakAt += breakInterval) {
    const searchRange = [
      Math.max(0, breakAt - breakOffset),
      breakAt + breakOffset,
    ];

    const subset = _searchInRange(shotsToScenes, searchRange, sceneMap, frameMap, pauseInDialogues, loudnesses);
    for (const scene of subset) {
      const sceneId = String(scene.scene);
      if (candidates[sceneId] === undefined) {
        candidates[sceneId] = scene;
      }
    }
  }

  candidates = Object.values(candidates);

  return candidates;
}

function _searchInRange(scenes, range, sceneMap, frameMap, pauseInDialogues, loudnesses) {
  const scenesInRange = _getScenesInRange(scenes, range);

  if (scenesInRange.length === 0) {
    return [];
  }

  const sceneTimeRange = [
    scenesInRange[0].timestampRange[0],
    scenesInRange[scenesInRange.length - 1].timestampRange[1],
  ];

  const pausesInRange = _getPausesInRange(pauseInDialogues, sceneTimeRange);
  const loudnessInRange = _getLoudnessInRange(loudnesses, sceneTimeRange);

  let candidates = {};

  for (const scene of scenesInRange) {
    const { knownType } = scene;
    if (knownType !== undefined) {
      candidates[String(scene.scene)] = scene;
      scene.weight = scene.weight || 1.0;
      scene.reason = `${knownType} scene`;
      scene.chosenSim = 0.0;
    }
  }

  if (Object.values(candidates).length === 0) {
    // search similarity across scenes in range
    const matches = _computeSimInRange(scenesInRange, frameMap, pausesInRange, true);

    if (matches.length > 0) {
      let scene = _chooseSceneBySimInRange(matches, 0.70);
      if (scene) {
        candidates[String(scene.scene)] = scene;
        scene.weight = scene.weight || 0.6;
        scene.reason = scene.reason || 'Lowest sim score in range';
        scene.chosenSim = scene.chosenSim || scene.simInRange;
      }

      // sort by rms of similarity of the previous scene
      scene = _chooseSceneByPreviousSimRMS(matches, 0.70);
      if (scene) {
        candidates[String(scene.scene)] = scene;
        scene.weight = scene.weight || 0.6;
        scene.reason = scene.reason || 'Lowest sim score to previous scene (rms)';
        scene.chosenSim = scene.chosenSim || scene.simToPreviousScene[2];
      }

      // sort by previous frame similarity
      scene = _chooseSceneByAdjacentFrameSim(matches, 0.70);
      if (scene) {
        candidates[String(scene.scene)] = scene;
        scene.weight = scene.weight || 0.5;
        scene.reason = scene.reason || 'Lowest sim score to previous frame';
        scene.chosenSim = scene.chosenSim || scene.simToPreviousFrame;
      }

      // // sort by the minimum of the max scene similarity
      // scene = _chooseSceneByPreviousSimMax(matches, 0.80);
      // if (scene) {
      //   candidates[String(scene.scene)] = scene;
      //   scene.weight = scene.weight || 0.4;
      //   scene.reason = scene.reason || 'Lowest sim score to previous scene (max)';
      //   scene.chosenSim = scene.chosenSim || scene.simToPreviousScene[1];
      // }

      // // choose from overall scene similarity???
      // scene = _chooseSceneByOverallSceneSim(matches, 0.80);
      // if (scene) {
      //   candidates[String(scene.scene)] = scene;
      //   scene.weight = scene.weight || 0.3;
      //   scene.reason = scene.reason || 'Lowest sim score to overall scenes';
      //   scene.chosenSim = scene.chosenSim || scene.simToAllScenes;
      // }

      // choose an additional one by the earliest timestamp
      const timeT = (range[0] + range[1]) / 2;
      scene = _chooseSceneByTimestamp(matches, timeT, 0.70);
      if (scene) {
        candidates[String(scene.scene)] = scene;
        scene.weight = scene.weight || 0.2;
        scene.reason = scene.reason || 'Closest scene to break interval';
        scene.chosenSim = scene.chosenSim || scene.simToPreviousFrame;
      }
    }
  }

  candidates = Object.values(candidates);

  // if (candidates.length > 1) {
  //   debugger;
  // }

  candidates.sort((a, b) =>
    a.timestampRange[0] - b.timestampRange[0]);

  for (const candidate of candidates) {
    const { timestampRange: [t,] } = candidate;
    // tag loudness to the candidate
    const loudness = _loudnessAtT(loudnessInRange, t);
    candidate.loudnessProps = loudness;
  }

  candidates = _printCandidates(candidates, frameMap);

  return candidates;
}

function _computeSimInRange(scenes, frameMap, pauses, useShotFrame = false) {
  const len = scenes.length;
  const matrix = new Array(len);
  for (let i = 0; i < matrix.length; i += 1) {
    matrix[i] = new Array(len);
  }

  for (let i = 0; i < len; i += 1) {
    const curFrames = _getFramesInScene(scenes[i], frameMap, useShotFrame);

    for (let j = 0; j < len; j += 1) {
      if (i === j) {
        matrix[i][j] = [1.0, 1.0];
        continue;
      }

      if (j < i) {
        matrix[i][j] = matrix[j][i];
        continue;
      }

      let maxSim = Number.MIN_SAFE_INTEGER;
      let minSim = Number.MAX_SAFE_INTEGER;

      const nexFrames = _getFramesInScene(scenes[j], frameMap, useShotFrame);

      for (const frame of curFrames) {
        for (const frame2 of nexFrames) {
          const sim = cosim(frame.embedding, frame2.embedding);
          maxSim = Math.max(sim, maxSim);
          minSim = Math.min(sim, minSim);
        }
      }
      matrix[i][j] = [minSim, maxSim];
    }
  }

  for (let i = 0; i < len; i += 1) {
    let sum = 0;
    for (let j = 0; j < len; j += 1) {
      // use the highest similarity
      sum += matrix[j][i][1];
    }
    // extract the scene itself
    sum = (sum - 1.0) / (len - 1);
    scenes[i].simInRange = sum;
  }

  const candidates = [];

  for (const scene of scenes) {
    const { pauseInDialogue, timestampRange: [t,] } = scene;
    if (!pauseInDialogue) {
      const pause = _pauseAtT(pauses, t);
      if (pause === undefined) {
        continue;
      }
    }

    candidates.push(scene);
  }

  return candidates;
}

function _printCandidates(candidates, frameMap) {
  let i = 0;
  for (const candidate of candidates) {
    const {
      knownType,
      loudnessProps: {
        label: loudnessLevel,
        minMaxMean: [, , loudnessMean],
        timestampRange: [lmin, lmax],
      },
      pauseInDialogue,
      pauseDuration,
      // transcripts = [],
      timestampRange: [tmin,],
      frameRange: [fmin,],
      segmentType = {},
      weight,
    } = candidate;

    const {
      segment_type,
      sub_segment_type,
    } = segmentType;

    let type = segment_type;
    if (sub_segment_type && sub_segment_type !== 'NA') {
      type = sub_segment_type;
    }

    const frame = frameMap[String(fmin)];
    if (frame === undefined) {
      throw new Error(`Fail to find Frame#${fmin}`);
    }

    let preFrame;
    for (let i = fmin - 1; i >= 0; i -= 1) {
      preFrame = frameMap[String(i)];
      if (preFrame) {
        break;
      }
    }

    const sim = cosim(frame.embedding, preFrame.embedding);
    candidate.similarity = sim;

    console.log(`[${i++}/${candidates.length}]: Scene#${candidate.scene}: ${toHHMMSS(tmin, true)}: ${knownType || '-'},${type || '-'},(${pauseInDialogue || '-'},${pauseDuration || '-'}ms),(${loudnessLevel},${loudnessMean.toFixed(4)},${lmax - lmin}ms),${sim.toFixed(4)} [${weight}]`);
  }

  console.log('------------');

  return candidates;
}

function _getScenesInRange(scenes, range) {
  const [rmin, rmax] = range;

  const scenesInRange = [];
  for (const scene of scenes) {
    const { timestampRange: [smin, smax] } = scene;

    if (smax < rmin) {
      continue;
    }

    if (smin > rmax) {
      break;
    }

    if (timeIntersected([smin, smax], [rmin, rmax])) {
      scenesInRange.push(scene);
    }
  }

  return scenesInRange;
}

function _getPausesInRange(pauseInDialogues, range) {
  const subset = [];
  const rmin = Math.max(range[0] - 200);
  const rmax = range[1];

  for (const pause of pauseInDialogues) {
    const [pmin, pmax] = pause;

    if (pmin > rmax) {
      break;
    }

    if (pmax < rmin) {
      continue;
    }

    if (timeIntersected([pmin, pmax], [rmin, rmax])) {
      subset.push(pause);
    }
  }

  return subset;
}

function _getLoudnessInRange(loudnesses, range) {
  const subset = [];
  const rmin = Math.max(range[0] - 200);
  const rmax = range[1];

  for (const loudness of loudnesses) {
    const { timestampRange: [lmin, lmax] } = loudness;
    if (lmin > rmax) {
      break;
    }
    if (lmax < rmin) {
      continue;
    }

    if (timeIntersected([lmin, lmax], [rmin, rmax])) {
      subset.push(loudness);
    }
  }

  return subset;
}

function _loudnessAtT(loudnesses, t) {
  for (const loudness of loudnesses) {
    const { timestampRange: [lmin, lmax] } = loudness;
    if (t >= lmin && t <= lmax) {
      return loudness;
    }
  }

  if (loudnesses.length === 0) {
    throw new Error(`Fail to loudness for timestamp ${toHHMMSS(t, true)}. loudnesses.length = 0`);
  }

  const {
    timestampRange: [tmin,],
  } = loudnesses[0];
  const {
    timestampRange: [,tmax],
  } = loudnesses[loudnesses.length - 1];

  throw new Error(`Fail to find loudnesses for timestamp ${toHHMMSS(t, true)}. loudnesses = [${toHHMMSS(tmin, true)}, ${toHHMMSS(tmax, true)}]. Size = ${loudnesses.length}`);
}

function _pauseAtT(pauses, t) {
  for (const pause of pauses) {
    const pmin = Math.max(0, pause[0] - 100);
    const pmax = pause[1] + 100;
    if (t >= pmin && t <= pmax) {
      return pause;
    }
  }
  return undefined;
}

function _getFramesInScene(scene, frameMap, useShotFrame = false) {
  const frames = [];

  if (useShotFrame === false) {
    for (const fnum of scene.frameRange) {
      const frame = frameMap[String(fnum)];
      if (frame !== undefined) {
        frames.push(frame);
      }
    }
  } else {
    for (const { frameRange } of scene.shots) {
      for (const fnum of frameRange) {
        const frame = frameMap[String(fnum)];
        if (frame !== undefined) {
          frames.push(frame);
        }
      }
    }
  }

  return frames;
}

function _chooseSceneBySimInRange(scenes, maxSimilarity = 0.80) {
  // choose the lowest similarity based on similarity in range
  scenes.sort((a, b) =>
    a.simInRange - b.simInRange);

  const scene = scenes[0];
  if (scene.simInRange < maxSimilarity) {
    return scene;
  }
  return undefined;
}

function _chooseSceneByPreviousSimRMS(scenes, maxSimilarity = 0.80) {
  // scene #0 will not have simliarity score to the previous scene
  const filtered = scenes.filter((scene) =>
    scene.simToPreviousScene !== undefined);

  if (filtered.length === 0) {
    return undefined;
  }

  // choose the lowest similarity based on similarity in range
  filtered.sort((a, b) =>
    a.simToPreviousScene[2] - b.simToPreviousScene[2]);

  const scene = filtered[0];
  if (scene.simToPreviousScene[2] < maxSimilarity) {
    return scene;
  }
  return undefined;
}

function _chooseSceneByAdjacentFrameSim(scenes, maxSimilarity = 0.80) {
  // scene #0 will not have simliarity score to the previous frame
  const filtered = scenes.filter((scene) =>
    scene.simToPreviousFrame !== undefined);

  if (filtered.length === 0) {
    return undefined;
  }

  // sort by previous frame similarity
  filtered.sort((a, b) =>
    a.simToPreviousFrame - b.simToPreviousFrame);

  const scene = filtered[0];
  if (scene.simToPreviousFrame < maxSimilarity) {
    return scene;
  }
  return undefined;
}

// function _chooseSceneByPreviousSimMax(scenes, maxSimilarity = 0.80) {
//   // choose the lowest similarity based on similarity in range
//   scenes.sort((a, b) =>
//     a.simToPreviousScene[1] - b.simToPreviousScene[1]);

//   const scene = scenes[0];
//   if (scene.simToPreviousScene[1] < maxSimilarity) {
//     return scene;
//   }
//   return undefined;
// }

// function _chooseSceneByOverallSceneSim(scenes, maxSimilarity = 0.80) {
//   if (scenes.length === 0) {
//     return undefined;
//   }
//   if (scenes[0].simToAllScenes === undefined) {
//     return undefined;
//   }

//   scenes.sort((a, b) =>
//     a.simToAllScenes - b.simToAllScenes);

//   const scene = scenes[0];
//   if (scene.simToAllScenes < maxSimilarity) {
//     return scene;
//   }
//   return undefined;
// }

function _chooseSceneByTimestamp(scenes, t, maxSimilarity = 0.80) {
  scenes.sort((a, b) => {
    const { timestampRange: [t0,] } = a;
    const { timestampRange: [t1,] } = b;
    return Math.abs(t0 - t) - Math.abs(t1 - t);
  });

  const scene = scenes[0];
  if (scene.simToPreviousFrame < maxSimilarity) {
    return scene;
  }
  return undefined;
}

function _toRekognitionTechnicalCueType(type, suggestedType, knownType, segmentType) {
  const { segment_type, sub_segment_type } = segmentType || {};

  let technicalCueType = suggestedType || type;
  if (!technicalCueType) {
    if (sub_segment_type && sub_segment_type !== 'NA') {
      technicalCueType = sub_segment_type;
    }
  }

  if (!technicalCueType) {
    technicalCueType = segment_type;
  }

  if (!technicalCueType) {
    technicalCueType = knownType;
  }

  if (!technicalCueType) {
    technicalCueType = TYPE_MAINPROGRAM;
  }

  // map to rekognition technical cue type
  if (technicalCueType === TYPE_COLORBARS) {
    technicalCueType = REK_COLORBARS;
  } else if (technicalCueType === TYPE_BLACKFRAMES) {
    technicalCueType = REK_BLACKFRAMES;
  } else if (technicalCueType === TYPE_OPENINGCREDITS) {
    technicalCueType = REK_OPENINGCREDITS;
  } else if (technicalCueType === TYPE_ENDCREDITS) {
    technicalCueType = REK_ENDCREDITS;
  } else if (technicalCueType === TYPE_TECHNICAL_SLATE) {
    technicalCueType = REK_SLATE;
  } else if (technicalCueType === TYPE_IDENTS) {
    technicalCueType = REK_STUDIOLOGO;
  } else {
    technicalCueType = REK_CONTENT;
  }

  return technicalCueType;
}

module.exports = StateGenerateAdBreaks;
