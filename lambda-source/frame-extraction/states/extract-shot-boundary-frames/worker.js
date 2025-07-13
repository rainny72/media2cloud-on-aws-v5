// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
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
    INFERENCE_CONCURRENCY,
    analyzeFrameBoundary,
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
    shotsToBeProcessed,
  } = data;

  const size = shotsToBeProcessed.length;

  for (let i = startIdx; i < size; i += step) {
    const boundary = shotsToBeProcessed[i];

    if (boundary.response !== undefined) {
      continue;
    }

    // extract frame
    console.log(`Worker#${startIdx}: _extractBoundaryFrames: [${boundary.frameFrom.frameNum} -> ${boundary.frameTo.frameNum}] maxFrames = ${boundary.maxFrames}`);
    const response = await _extractBoundaryFrames(data, boundary);

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

async function _extractBoundaryFrames(itemData, boundary) {
  const {
    input: {
      bucket,
      key,
    },
    output: {
      bucket: proxyBucket,
      framePrefix,
    },
    streamInfo,
    ffOptions: {
      vf: videoFilters,
    },
    filterSettings,
  } = itemData;

  const {
    framerateFraction,
  } = streamInfo;

  // remove the select filter
  let vf = [];
  if (videoFilters !== undefined && videoFilters.length > 0) {
    vf = videoFilters.filter((x) =>
      x.indexOf('select') < 0);
  }

  const url = await getSignedUrl({ bucket, key });

  const {
    frameFrom,
    frameTo,
    maxFrames,
  } = boundary;

  // construct ffmpeg options
  const ffOptions = { url, vf };

  if (frameFrom.timestampMillis > 0) {
    ffOptions.ss = frameFrom.timestampMillis;
  }

  // pad an extra frame
  ffOptions.to = frameTo.timestampMillis + ((1000 * framerateFraction[1]) / framerateFraction[0]);

  const options = {
    output: {
      bucket: proxyBucket,
      framePrefix,
    },
    streamInfo,
    filterSettings,
    ffOptions,
    inferenceConcurrency: INFERENCE_CONCURRENCY,
  };

  const response = await analyzeFrameBoundary(options, [frameFrom, frameTo], maxFrames);

  return response;
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
      error: e.name || e.code || e.message,
    });
  }
})();
