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
  SegmentHelper: {
    createSequenceImage,
  },
  CommonUtils: {
    freeHeapMemory,
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
    prefix,
    frameEmbeddings,
    sceneShots,
    ids,
  } = data;

  const sceneMap = {};
  const frameMap = {};

  for (const scene of sceneShots) {
    sceneMap[String(scene.scene)] = scene;
  }

  for (const frame of frameEmbeddings.frames) {
    frameMap[String(frame.frameNum)] = frame;
  }

  // avoid out of memory issue
  delete frameEmbeddings.frames;

  const size = ids.length;

  for (let i = startIdx; i < size; i += step) {
    freeHeapMemory();

    const { scene: sceneId } = ids[i];

    const sequenceFrames = [];

    const { frameRange: [fmin, fmax] } = sceneMap[String(sceneId)];
    for (let i = fmin; i <= fmax; i += 1) {
      const sequenceFrame = frameMap[String(i)];
      if (sequenceFrame) {
        sequenceFrames.push(sequenceFrame);
      }
    }

    // create sequence image
    const response = await createSequenceImage(bucket, prefix, ids[i], sequenceFrames)

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
      error: e.message,
    });
  }
})();
