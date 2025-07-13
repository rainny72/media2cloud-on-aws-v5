// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const PATH = require('node:path');
const {
  GetSegmentDetectionCommand,
} = require('@aws-sdk/client-rekognition');
const {
  AnalysisTypes: {
    Rekognition: {
      Segment,
    },
  },
  CommonUtils: {
    download,
  },
  TimecodeUtils: {
    framerateToEnum,
    fromTimecode,
    toTimecode,
  },
  JimpHelper: {
    imageFromS3,
    computeBlackLevel,
    distanceToBlack,
  },
  M2CException,
} = require('core-lib');
const BaseCollectResultsIterator = require('../shared/baseCollectResultsIterator');

const NAMED_KEY = 'Segments';
const PREFIX_FRAMECAPTURE = 'transcode/frameCapture';
const JSON_FRAME_HASH = 'frameHash.json';
let TimecodeSettings = {
  enumFPS: undefined,
  dropFrame: undefined,
};

let FilterSettings = {
  BlackFrame: {
    MaxPixelThreshold: 0.2, // default is 0.2
    MinCoveragePercentage: 98, // default is 98%
  },
};

class CollectSegmentIterator extends BaseCollectResultsIterator {
  constructor(stateData) {
    super(stateData, Segment, NAMED_KEY);
    this.$frameHashes = undefined;

    const {
      data,
    } = stateData;

    _setFilterSettings((data[Segment] || {}).filterSettings);
  }

  get [Symbol.toStringTag]() {
    return 'CollectSegmentIterator';
  }

  get frameHashes() {
    return this.$frameHashes;
  }

  set frameHashes(val) {
    this.$frameHashes = val;
  }

  async process() {
    const {
      data: {
        [Segment]: {
          bucket,
          prefix,
          jobId,
        },
      },
    } = this.stateData;

    // see if we have frame hashes output
    if (jobId && bucket && prefix) {
      const framePrefix = PATH.join(prefix, PREFIX_FRAMECAPTURE);
      const key = PATH.join(framePrefix, JSON_FRAME_HASH);

      this.frameHashes = await download(bucket, key)
        .then((res) =>
          JSON.parse(res))
        .catch(() =>
          undefined);
    }

    return super.process();
  }

  getRunCommand(params) {
    return new GetSegmentDetectionCommand(params);
  }

  parseModelMetadata(dataset) {
    return {
      VideoMetadata: dataset.VideoMetadata,
      AudioMetadata: dataset.AudioMetadata,
      SelectedSegmentTypes: dataset.SelectedSegmentTypes,
    };
  }

  getUniqueNames(dataset) {
    const technicalCueSegments = dataset
      .filter((x) =>
        x.TechnicalCueSegment !== undefined)
      .map((x) =>
        x.TechnicalCueSegment.Type);

    const uniques = [
      ...new Set(technicalCueSegments),
    ];

    const shotSegment = dataset
      .find((x) =>
        x.ShotSegment !== undefined);
    if (shotSegment) {
      uniques.push('Shot');
    }

    return uniques;
  }

  async postProcessAllResults(dataset) {
    TimecodeSettings = _setTimecodeSettings(dataset);

    const {
      data: {
        [Segment]: {
          bucket,
          prefix,
        },
      },
    } = this.stateData;

    const framePrefix = PATH.join(prefix, PREFIX_FRAMECAPTURE);

    return _postProcessAllResults(bucket, framePrefix, dataset, this.frameHashes);
  }
}

async function _postProcessAllResults(bucket, framePrefix, dataset, frameHashes) {
  const duped = dataset;

  const {
    technicalCues,
    shotSegments,
  } = _splitSegments(duped);

  await _findFramesInShotSegment(
    bucket,
    framePrefix,
    shotSegments,
    frameHashes
  );

  // add shot segment indices into technical cues
  const unclassified = [];
  let shotIdx = 0;

  for (let i = 0; i < technicalCues.length; i += 1) {
    const technicalCue = technicalCues[i];

    const tsta = technicalCue.StartTimestampMillis;
    const tend = technicalCue.EndTimestampMillis;

    while (shotIdx < shotSegments.length) {
      const shotSegment = shotSegments[shotIdx];
      const ssta = shotSegment.StartTimestampMillis;
      const send = shotSegment.EndTimestampMillis;
      const midpoint = Math.floor((ssta + send) / 2);

      if (midpoint > tend) {
        break;
      }

      if (midpoint < tsta) {
        unclassified.push(shotSegment);
        shotIdx += 1;
        continue;
      }

      // shot segment belongs to this technical cue
      if (technicalCue.ShotSegmentRange === undefined) {
        technicalCue.ShotSegmentRange = [];
      }
      technicalCue.ShotSegmentRange.push(shotSegment.ShotSegment.Index);
      shotIdx += 1;
    }

    if (technicalCue.ShotSegmentRange === undefined) {
      // potentially be inside a content shot segment
      technicalCue.ShotSegmentRange = _searchTechnicalCueInShotSegment(
        technicalCue,
        shotSegments
      );

      if (technicalCue.ShotSegmentRange !== undefined) {
        // indicate the technical cue is partially in a shot segment
        technicalCue.PartialShotSegment = true;
        console.log(`TechincalCue.${technicalCue.TechnicalCueSegment.Type}: ${technicalCue.StartTimecodeSMPTE} -> ${technicalCue.EndTimecodeSMPTE}: found inside shot #${technicalCue.ShotSegmentRange[0]}.`);
      } else {
        console.log(`[WARN]: TechincalCue.${technicalCue.TechnicalCueSegment.Type}: ${technicalCue.StartTimecodeSMPTE} -> ${technicalCue.EndTimecodeSMPTE}: no ShotSegment found.`);
      }
    } else {
      // set shot segment range
      const min = Math.min(...technicalCue.ShotSegmentRange);
      const max = Math.max(...technicalCue.ShotSegmentRange);

      technicalCue.ShotSegmentRange = [min, max];
    }
  }

  duped.Segments = technicalCues.concat(shotSegments);

  // segments doesn't belong to any technical cue
  if (unclassified.length > 0) {
    duped.UnknownSegments = unclassified
      .map((shotSegment) =>
        shotSegment.ShotSegment.Index);
  }

  return duped;
}

function _setTimecodeSettings(segments) {
  const {
    VideoMetadata: [
      {
        FrameRate: frameRate,
      },
    ],
    Segments: [
      {
        StartFrameNumber: frameStart,
        StartTimecodeSMPTE: smpteTimecode,
      },
    ],
  } = segments;

  const enumFPS = framerateToEnum(frameRate);
  const dropFrame = !!(smpteTimecode.lastIndexOf(';') > 0);

  let smpteFrameOffset = fromTimecode(enumFPS, smpteTimecode);
  smpteFrameOffset -= frameStart;

  return {
    enumFPS,
    dropFrame,
    frameRate,
    smpteFrameOffset,
  };
}


function _splitSegments(segments) {
  const shotSegments = [];
  const contents = [];
  const endCredits = [];
  const others = [];

  console.log('TechnicalCues [BEFORE]:');
  for (let i = 0; i < segments.Segments.length; i += 1) {
    const segment = segments.Segments[i];

    if (segment.TechnicalCueSegment) {
      console.log(`[${segment.StartTimecodeSMPTE}] -> [${segment.EndTimecodeSMPTE}] ${segment.TechnicalCueSegment.Type}`);

      if (segment.TechnicalCueSegment.Type === 'Content') {
        contents.push(segment);
      } else if (segment.TechnicalCueSegment.Type === 'EndCredits') {
        endCredits.push(segment);
      } else {
        others.push(segment);
      }
    } else if (segment.ShotSegment) {
      shotSegments.push(segment);
    }
  }

  // check for Contents within EndCredits
  for (let i = 0; i < endCredits.length; i += 1) {
    const {
      StartTimestampMillis: tsta,
      EndTimestampMillis: tend,
    } = endCredits[i];

    contents.forEach((content, idx) => {
      if (content) {
        const {
          StartTimestampMillis: csta,
          EndTimestampMillis: cend,
        } = content;
        if (csta >= tsta && cend <= tend) {
          delete contents[idx];
        }
      }
    });
  }

  const technicalCues = [
    ...others,
    ...contents
      .filter((x) => x),
    ...endCredits,
  ];

  technicalCues
    .sort((a, b) =>
      a.StartTimestampMillis - b.StartTimestampMillis);

  console.log('TechnicalCues [AFTER]:');

  technicalCues.forEach((technicalCue) => {
    console.log(`[${technicalCue.StartTimecodeSMPTE}] -> [${technicalCue.EndTimecodeSMPTE}] ${technicalCue.TechnicalCueSegment.Type}`);
  });

  return {
    technicalCues,
    shotSegments,
  };
}

function _searchTechnicalCueInShotSegment(
  technicalCue,
  shotSegments
) {
  const {
    StartTimestampMillis: cueSta,
    EndTimestampMillis: cueEnd,
  } = technicalCue;

  let shotSegmentRange;
  const timestamp = Math.round((cueSta + cueEnd) / 2);

  for (let i = 0; i < shotSegments.length; i += 1) {
    const {
      StartTimestampMillis: tsta,
      EndTimestampMillis: tend,
    } = shotSegments[i];

    if (timestamp < tsta) {
      break;
    }

    if (timestamp > tend) {
      continue;
    }

    shotSegmentRange = [i, i];
    break;
  }

  return shotSegmentRange;
}

async function _findFramesInShotSegment(
  bucket,
  framePrefix,
  shotSegments,
  frameHashes = []
) {
  if (frameHashes.length === 0) {
    return;
  }
  const {
    enumFPS,
    dropFrame,
  } = TimecodeSettings;

  if (enumFPS === undefined) {
    throw new M2CException('invalid TimecodeSettings');
  }

  let frameIdx = 0;

  for (let i = 0; i < shotSegments.length; i += 1) {
    const shotSegment = shotSegments[i];
    const {
      StartTimestampMillis: tsta,
      EndTimestampMillis: tend,
      StartFrameNumber: frameStart,
      StartTimecodeSMPTE: smpteStart,
    } = shotSegment;

    let frameIndices = [];
    let transitionCandidates = [];

    for (frameIdx; frameIdx < frameHashes.length; frameIdx += 1) {
      const frame = frameHashes[frameIdx];
      const {
        timestamp,
      } = frame;

      if (timestamp < tsta) {
        continue;
      }

      if (timestamp > tend) {
        break;
      }

      // Potentially a black frame?
      const distance = _perceptualDistanceToBlackFrame(frame);
      if (distance >= 0 && distance < 10) {
        transitionCandidates.push({
          ...frame,
          frameIdx,
        });
      }

      frameIndices.push(frameIdx);
    }

    if (transitionCandidates.length > 0) {
      transitionCandidates = await _checkBlackFrames(
        bucket,
        framePrefix,
        transitionCandidates
      );
    }

    if (frameIndices.length > 0) {
      const min = Math.min(...frameIndices);
      const max = Math.max(...frameIndices);

      shotSegment.FrameRange = [min, max];

      if (transitionCandidates.length > 0) {
        const _min = transitionCandidates[0].frameIdx;
        const _max = transitionCandidates[transitionCandidates.length - 1].frameIdx;

        if (_min === min) {
          shotSegment.FadeInBlack = true;
        }

        if (_max === max) {
          shotSegment.FadeOutBlack = true;
        }

        // transitional blackframe
        const {
          frameNo,
          timestamp,
        } = frameHashes[_max];

        if (timestamp > tsta && timestamp < tend) {
          const offset = frameNo - frameStart;
          let frameNum = fromTimecode(enumFPS, smpteStart);
          frameNum += offset;

          const smpteTimecode = toTimecode(enumFPS, frameNum, dropFrame)[0];

          shotSegment.TransitionBlack = {
            TimestampMillis: timestamp,
            FrameNumber: frameNo,
            TimecodeSMPTE: smpteTimecode,
          };
        }
      }

      transitionCandidates = [];
      frameIndices = [];
    }
  }
}

function _perceptualDistanceToBlackFrame(frame) {
  const {
    laplacian,
    hash,
  } = frame;

  // frame contains some details
  if (laplacian >= 4) {
    return -1;
  }

  // perceptual hash provides only indication of whether a frame
  // is perceptually similar to a black frame
  const distance = distanceToBlack(hash) * 100

  return distance;
}

async function _checkBlackFrames(
  bucket,
  prefix,
  candidates
) {
  const minLaplacian = Math.min(
    ...candidates
      .map((x) =>
        x.laplacian)
  );

  const promises = [];
  const blackFrames = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];

    if (candidate.laplacian === minLaplacian) {
      promises.push(_analyseBlackLevel(
        bucket,
        prefix,
        candidate.name
      ).then((res) => {
        if ((res || {}).isBlack) {
          blackFrames.push({
            ...candidate,
            ...res,
          });
        }
      }));
    }
  }

  await Promise.all(promises);

  return blackFrames
    .sort((a, b) =>
      a.frameIdx - b.frameIdx);
}

async function _analyseBlackLevel(
  bucket,
  prefix,
  name
) {
  try {
    const key = PATH.join(prefix, name);
    const image = await imageFromS3(bucket, key);

    const {
      BlackFrame: {
        MaxPixelThreshold: maxPixelThreshold,
        MinCoveragePercentage: minCoveragePercentage,
      },
    } = FilterSettings;

    const options = {
      maxPixelThreshold,
      minCoveragePercentage,
    };

    const stats = computeBlackLevel(image, options);

    // console.log(`_analyseBlackLevel: ${name}`);
    // console.log(JSON.stringify(stats, null, 2));

    return stats;
  } catch (e) {
    console.log(`ERR: _analyseBlackLevel: ${prefix}/${name}`, e);
    return undefined;
  }
}

function _setFilterSettings(userFilterSettings = {}) {
  try {
    const {
      maxPixelThreshold = 0.15,
      minCoveragePercentage = 98,
    } = userFilterSettings;

    let _maxPixelThreshold = Number(maxPixelThreshold);
    let _minCoveragePercentage = Number(minCoveragePercentage);

    if (
      Number.isNaN(_maxPixelThreshold) ||
      Number.isNaN(_minCoveragePercentage)
    ) {
      return;
    }

    _maxPixelThreshold = Math.min(
      Math.max(_maxPixelThreshold, 0),
      0.99
    );

    _minCoveragePercentage = Math.min(
      Math.max(_minCoveragePercentage, 0),
      100
    );

    // apply user defined settings
    FilterSettings = {
      BlackFrame: {
        MaxPixelThreshold: _maxPixelThreshold,
        MinCoveragePercentage: _minCoveragePercentage,
      },
    };
  } catch (e) {
    // do nothing
    e;
  }
}

module.exports = CollectSegmentIterator;
