// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
} = require('node:path');
const {
  readFileSync,
} = require('node:fs');
const {
  workerData,
  parentPort,
} = require('worker_threads');
const {
  CommonUtils: {
    getSignedUrl,
  },
  SegmentHelper: {
    analyzeSceneBoundary,
  },
  TimecodeUtils: {
    framerateToFraction,
  },
  FFmpegHelper: {
    MAXRESOLUTION,
  },
  M2CException,
} = require('core-lib');

async function runWorkerProcess(workerData) {
  const {
    jsonFile,
    startIdx,
    step,
    deadline,
  } = workerData;

  const data = JSON.parse(readFileSync(jsonFile).toString());
  const {
    scenesToBeProcessed,
  } = data;

  const size = scenesToBeProcessed.length;

  for (let i = startIdx; i < size; i += step) {
    const boundary = scenesToBeProcessed[i];

    if (boundary.response !== undefined) {
      continue;
    }

    const response = await _analyzeSceneBoundary(data, boundary);

    // post message to parent
    parentPort.postMessage({
      idx: i,
      response,
    });

    // quit if lambda approaching timeout
    if ((deadline - Date.now()) < 500) {
      break;
    }
  }
}

async function _analyzeSceneBoundary(itemData, boundary) {
  try {
    const {
      bucket,
      framePrefix,
      framerate,
      timeCodeFirstFrame,
      filterSettings,
    } = itemData;

    const {
      frames: [frameFrom, frameTo],
    } = boundary;

    const timeFrom = frameFrom.timestampMillis;
    const timeTo = frameTo.timestampMillis;
    const ffOptions = await _makeFFOptions(itemData, timeFrom, timeTo);
    const framerateFraction = framerateToFraction(framerate);

    const params = {
      ffOptions,
      filterSettings,
      streamInfo: {
        framerateFraction,
        timeCodeFirstFrame,
      },
      output: {
        bucket,
        framePrefix: join(framePrefix, 'b'), // store new frames to 'b' folder
      },
    };

    const response = await analyzeSceneBoundary(params, boundary);

    return response;
  } catch (e) {
    console.error(e);
    throw e;
  }
}

async function _makeFFOptions(itemData, timeFrom, timeTo) {
  const {
    bucket,
    key,
    framerate,
    videoInfo: {
      codedWidth,
      codedHeight,
      pixelAspectRatio,
      progressive,    
    },
    copyFromSource,
    filterSettings: {
      cropX = 0,
      cropY = 0,
    },
  } = itemData;

  const framerateFraction = framerateToFraction(framerate);

  const ffOptions = {};

  // start seek
  if (timeFrom > 0) {
    ffOptions.ss = timeFrom;
  }
  // to
  const to = timeTo + ((1000 * framerateFraction[1]) / framerateFraction[0]);
  ffOptions.to = to;

  // input url
  const url = await getSignedUrl({ bucket, key });
  ffOptions.url = url;

  // video filters
  const vf = [];
  if (!progressive) {
    vf.push('yadif');
  }

  // input cropping
  if (copyFromSource && (cropX || cropY)) {
    vf.push(`crop=in_w-${cropX}:in_h-${cropY}`);
  }

  // scale the output?
  const dspW = (codedWidth * pixelAspectRatio[0]) / pixelAspectRatio[1];
  const dspH = codedHeight;

  let size = MAXRESOLUTION;
  if (dspW === dspH) {
    size = [dspW, dspH];
  } else if (dspH > dspW) {
    // Portrait mode
    size = [MAXRESOLUTION[1], MAXRESOLUTION[0]];
  }

  const factor = Math.min(size[0] / dspW, size[1] / dspH);
  size = [
    (Math.round(dspW * factor) >> 1) << 1,
    (Math.round(dspH * factor) >> 1) << 1,
  ];
  if (size[0] !== codedWidth || size[1] !== codedHeight) {
    vf.push(`scale=${size[0]}x${size[1]}`);
  }
  ffOptions.vf = vf;

  return ffOptions;
}

(async () => {
  try {
    console.log('workerData', JSON.stringify(workerData, null, 2));

    const missing = ['jsonFile', 'startIdx', 'step', 'deadline']
      .filter((x) =>
        workerData[x] === undefined);

    if (missing.length) {
      throw new M2CException(`missing workerData (${missing.join(', ')})`);
    }

    await runWorkerProcess(workerData);
  } catch (e) {
    console.error(e);
    console.log('workerData', JSON.stringify(workerData, null, 2));
    parentPort.postMessage({
      ...workerData,
      error: e.message,
    });
  }
})();
