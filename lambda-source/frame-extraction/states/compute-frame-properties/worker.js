// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  readFileSync,
} = require('node:fs');
const {
  join,
} = require('node:path');
const {
  workerData,
  parentPort,
} = require('worker_threads');
const {
  SegmentHelper: {
    computeFrameProperties,
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
    bucket,
    framePrefix,
    frames,
    blackFilter,
  } = data;

  const size = frames.length;

  for (let i = startIdx; i < size; i += step) {
    let {
      hash,
      laplacian,
      name,
    } = frames[i];

    if (hash !== undefined && laplacian !== undefined) {
      continue;
    }

    const params = {
      bucket,
      key: join(framePrefix, name),
    };
    const response = await computeFrameProperties(params, blackFilter);

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
