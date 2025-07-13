// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  JimpHelper: {
    compareHashes,
  },
} = require('core-lib');

// ColorBars | EndCredits | BlackFrames | OpeningCredits | StudioLogo | Slate | Content
const TYPE_STEADY = ['ColorBars', 'BlackFrames', 'StudioLogo', 'Slate'];
const TYPE_CREDITS = ['EndCredits'];
const TYPE_OPENING = ['OpeningCredits'];
const TYPE_CONTENT = ['Content', 'undefined'];
const HAMMING_DISTANCE_THRESHOLD = 0.85;
const SPLIT_INTERVAL = 2 * 60 * 1000; // 2min
const SAMPLING_INTERVAL = 4 * 1000; // 4s
const SCAN_MODE = {
  Forward: 0,
  Backward: 1,
};
const KNOWN_HASHES = [
  '00000000000', // BlackFrames
  '820w820w800', // EBU Color Bars
];

class SelectionHelper {
  static selectFrames(frameHashes, segments) {
    let selected = [];

    if (segments !== undefined) {
      selected = _withShotSegment(frameHashes, segments);
    } else {
      selected = _withHammingDistance(frameHashes);
    }
    console.log(`== [SelectionHelper][selectFrames]: ${frameHashes.length} -> ${selected.length} frames`);
    return selected;
  }
}

function _withShotSegment(frameHashes, segments) {
  const technicalCues = [];
  const shotSegments = [];

  // split technical cues and shots
  segments.Segments
    .forEach((segment) => {
      if (segment.Type === 'TECHNICAL_CUE') {
        technicalCues.push(segment);
      } else if (segment.Type === 'SHOT') {
        shotSegments.push(segment);
      }
    });

  // special case: potentially short form video. Fake the technicalCue.
  if (technicalCues.length === 0) {
    shotSegments.forEach((shotSegment) => {
      technicalCues.push({
        ShotSegmentRange: [shotSegment.ShotSegment.Index, shotSegment.ShotSegment.Index],
        TechnicalCueSegment: {
          Type: 'undefined',
        },
      });
    });
  }

  let selected = [];
  let shotIdx = 0;

  for (let i = 0; i < technicalCues.length; i += 1) {
    const technicalCue = technicalCues[i];

    if (technicalCue.ShotSegmentRange && !technicalCue.PartialShotSegment) {
      const [min, max] = technicalCue.ShotSegmentRange;

      while (shotIdx < shotSegments.length) {
        const shotSegment = shotSegments[shotIdx];

        if (shotSegment.ShotSegment.Index > max) {
          break;
        }

        if (shotSegment.ShotSegment.Index < min) {
          shotIdx += 1;
          continue;
        }

        const selectedFrames = _selectFromShotSegment(
          shotSegment,
          frameHashes,
          technicalCue.TechnicalCueSegment.Type
        );

        if (selectedFrames.length > 0) {
          selected = selected
            .concat(selectedFrames);
        }

        shotIdx += 1;
      }
    }
  }

  // special case: unknown type shot segments
  if ((segments.UnknownSegments || []).length > 0) {
    console.log(`[INFO]: found ${segments.UnknownSegments.length} unknown shot segments.`);

    segments.UnknownSegments
      .forEach((idx) => {
        const shotSegment = shotSegments
          .find((x) =>
            x.ShotSegment.Index === idx);

        if (shotSegment) {
          const extra = _selectFromUnknownShotSegment(
            shotSegment,
            frameHashes
          );

          if (extra.length > 0) {
            selected = selected.concat(extra);
          }
        }
      });
  }

  selected
    .sort((a, b) =>
      a.timestamp - b.timestamp);

  return selected;
}

function _withHammingDistance(frameHashes) {
  let selected = [];

  if (frameHashes.length === 0) {
    selected = [];
  } else if (frameHashes.length < 2) {
    selected = _selectByLaplacian(frameHashes, 1);
  } else {
    const interval = frameHashes[1].timestamp - frameHashes[0].timestamp;
    const numItems = Math.floor(SPLIT_INTERVAL / interval);
    const maxFrames = Math.max(
      Math.round(SPLIT_INTERVAL / SAMPLING_INTERVAL),
      1
    );

    while (frameHashes.length > 0) {
      const frames = frameHashes
        .splice(0, numItems);

      const scanned = _selectByScanning(frames, maxFrames);

      selected = selected
        .concat(scanned);
    }
  }

  return selected;
}

function _selectFromShotSegment(
  shotSegment,
  frameHashes,
  technicalCueType
) {
  const {
    StartTimestampMillis: ssta,
    EndTimestampMillis: send,
    ShotSegment: {
      Index: shotIdx,
    },
    FrameRange: frameRange,
  } = shotSegment;

  const shotSegmentFrames = _framesInRange(frameHashes, frameRange);

  let selected = [];

  // #1: too short of the segment, skip frame
  // #2: short segment or irrelevant type such as BlackFrames, return 1 frame only
  // #3: for end credits, fixed rate of 3s
  // #4: content / opening
  if (shotSegmentFrames.length < 2) {
    selected = _selectAtmostOne(shotSegmentFrames);
  } else if (TYPE_STEADY.includes(technicalCueType)) {
    selected = _selectByLaplacian(shotSegmentFrames, 1);
  } else if (TYPE_CREDITS.includes(technicalCueType)) {
    selected = _selectByFixedRate(shotSegmentFrames, SAMPLING_INTERVAL);
  } else if (TYPE_OPENING.includes(technicalCueType) || TYPE_CONTENT.includes(technicalCueType)) {
    // budget frames to atmost 1 frame every 3 seconds
    const maxFrames = Math.max(Math.round((send - ssta) / SAMPLING_INTERVAL), 1);
    selected = _selectByScanning(shotSegmentFrames, maxFrames);
  } else {
    console.log(`[INFO]: [#${shotIdx}]: ${technicalCueType}: not supported`);
  }

  selected.sort((a, b) =>
    a.timestamp - b.timestamp);

  for (const frame of selected) {
    frame.shotIdx = shotIdx;
    frame.technicalCueType = technicalCueType;
  }

  return selected;
}

function _selectFromUnknownShotSegment(
  shotSegment,
  frameHashes
) {
  const {
    StartTimestampMillis: ssta,
    EndTimestampMillis: send,
    ShotSegment: {
      Index: shotIdx,
    },
    FrameRange: frameRange,
  } = shotSegment;

  const shotSegmentFrames = _framesInRange(frameHashes, frameRange);

  const maxFrames = Math.round((send - ssta) / SAMPLING_INTERVAL);
  const selected = _selectByScanning(shotSegmentFrames, maxFrames);

  for (const frame of selected) {
    frame.shotIdx = shotIdx;
    frame.technicalCueType = 'undefined';
  }

  return selected;
}

function _framesInRange(frameHashes, range = []) {
  const frames = [];

  const [min, max] = range;
  if (
    (typeof min !== 'undefined') &&
    (typeof max !== 'undefined')
  ) {
    for (let i = min; i <= max; i += 1) {
      const frame = frameHashes[i];

      if (frame !== undefined) {
        frames.push(frame);
      }
    }
  }

  return frames;
}

function _selectAtmostOne(frames) {
  if (frames.length) {
    return [frames[0]];
  }
  return [];
}

function _selectByFixedRate(frames, sampling = SAMPLING_INTERVAL) {
  if (frames.length === 0) {
    return [];
  }

  if (frames.length < 2) {
    return [
      frames[0],
    ];
  }

  const selected = [];

  let prev = frames[0];
  selected.push(prev);

  for (let i = 1; i < frames.length; i += 1) {
    const cur = frames[i];

    if ((cur.timestamp - prev.timestamp) >= sampling) {
      selected.push(cur);
      prev = cur;
    }
  }

  return selected;
}

function _selectByLaplacian(frames, numItems = 1) {
  frames
    .sort((a, b) =>
      b.laplacian - a.laplacian);

  return frames.splice(0, numItems);
}

function _selectByScanning(frames, maxFrames) {
  let boundaryFrames = [];

  if (frames.length === 0) {
    return boundaryFrames;
  }

  const numFrames = frames.length;

  // collect frames at the boundary
  boundaryFrames.push(frames.shift());
  if (frames.length > 1){
    boundaryFrames.push(frames.pop());
  }

  if (frames.length <= 2) {
    return boundaryFrames;
  }

  const extraFrames = maxFrames - 2;
  if (extraFrames <= 0) {
    return boundaryFrames;
  }

  // still have more frames, scan frames and return
  // atmost maxFrames
  const stats = _computeStatistics(frames.map((x) => x.laplacian));

  const startIdx = stats.maxIdx;
  if (startIdx < 0) {
    return boundaryFrames;
  }

  let selected = [];
  selected.push(frames[startIdx]);

  let scanned = _scanFrames(frames, startIdx, SCAN_MODE.Forward);
  selected = selected.concat(scanned);

  scanned = _scanFrames(frames, startIdx, SCAN_MODE.Backward);
  selected = selected.concat(scanned);

  if (selected.length > extraFrames) {
    selected.sort((a, b) =>
      b.laplacian - a.laplacian);

    selected = selected.slice(0, extraFrames);
  }

  selected = selected.concat(boundaryFrames)
    .sort((a, b) =>
      a.timestamp - b.timestamp);

  console.log(`[INFO]: _selectByScanning: ${selected.length} / ${numFrames} [dropping ${numFrames - selected.length} frames]`);

  return selected;
}

function _scanFrames(frames, startIdx, mode, distance = HAMMING_DISTANCE_THRESHOLD) {
  const selected = [];

  let prev = frames[startIdx];
  if (mode === SCAN_MODE.Forward) {
    if (startIdx >= (frames.length - 1)) {
      return selected;
    }

    for (let i = startIdx + 1; i < frames.length; i += 1) {
      const cur = frames[i];

      const _distance = _compareHash(prev.hash, cur.hash);
      if (_distance > distance) {
        selected.push(cur);
        prev = cur;
      }
    }
    return selected;
  }

  if (startIdx === 0) {
    return selected;
  }

  for (let i = startIdx - 1; i >= 0; i -= 1) {
    const cur = frames[i];

    const _distance = _compareHash(prev.hash, cur.hash);
    if (_distance > distance) {
      selected.push(cur);
      prev = cur;
    }
  }

  return selected;
}

function _compareHash(hash1, hash2) {
  if (
    (typeof hash1 === 'undefined') ||
    (typeof hash2 === 'undefined')
  ) {
    return 0;
  }

  // filter out blackframe and EBU colorbars
  for (let i = 0; i < KNOWN_HASHES.length; i += 1) {
    const dist = Math.round(
      Math.abs(compareHashes(hash2, KNOWN_HASHES[i]) * 100)
    );

    if (dist < 15) {
      return 0;
    }
  }

  return compareHashes(hash1, hash2) * 100;
}

function _computeStatistics(items = [], withSD = false) {
  let max = Number.MIN_SAFE_INTEGER;
  let min = Number.MAX_SAFE_INTEGER;
  let maxIdx = -1;
  let minIdx = -1;
  let sum = 0;
  let mean = 0;
  let sd = 0;

  for (let i = 0; i < items.length; i += 1) {
    if (items[i] > max) {
      max = items[i];
      maxIdx = i;
    }

    if (items[i] < min) {
      min = items[i];
      minIdx = i;
    }

    sum += items[i];
  }

  if (items.length === 0) {
    mean = sum;
  } else {
    mean = sum / items.length;
  }

  const stats = {
    max,
    min,
    sum,
    mean,
    minIdx,
    maxIdx,
  };

  if (withSD && items.length > 1) {
    items.forEach((x) => {
      sd += (x - mean) ** 2;
    });

    sd = (sd / (items.length - 1)) ** 0.5;
    stats.sd = sd;
  }

  return stats;
}

module.exports = SelectionHelper;
