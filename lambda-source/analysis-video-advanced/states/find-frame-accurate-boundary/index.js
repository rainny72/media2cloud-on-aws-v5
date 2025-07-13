// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  parse,
  join,
} = require('node:path');
const {
  tmpdir,
  cpus,
} = require('node:os');
const {
  writeFileSync,
  unlinkSync,
} = require('node:fs');
const {
  randomBytes,
} = require('node:crypto');
const {
  Worker,
  SHARE_ENV,
} = require('node:worker_threads');
const {
  StateData: {
    Statuses: {
      Completed,
      InProgress,
    },
  },
  CommonUtils: {
    download,
    uploadFile,
  },
  M2CException,
} = require('core-lib');
const BaseState = require('../shared/base');

const WORKER_JS = 'worker.js';
const BAILOUT_RETRY = 10;

class StateFindFrameAccurateBoundary extends BaseState {
  static opSupported(op) {
    return op === 'StateFindFrameAccurateBoundary';
  }

  async process() {
    let localCopy;
    try {
      const {
        itemId,
        itemData,
      } = this.stateData;
      const {
        bucket,
        framePrefix,
      } = itemData;

      if (itemData.retries && itemData.retries >= BAILOUT_RETRY) {
        throw new Error('Too many retries');
      }

      const sceneBoundaries = await this.downloadOrCreateSceneBoundaries();

      const scenesToBeProcessed = sceneBoundaries
        .filter((x) =>
          x.response === undefined);

      if (scenesToBeProcessed.length === 0) {
        return this.setCompleted();
      }

      // make a local copy
      localCopy = `${randomBytes(16).toString('hex')}-${itemId}.json`;
      localCopy = join(tmpdir(), localCopy);
      writeFileSync(localCopy, JSON.stringify({
        ...itemData,
        scenesToBeProcessed,
      }));

      const params = {
        jsonFile: localCopy,
      };

      const numThreads = cpus().length;
      // const numThreads = 2;
      console.log(`Threads = ${numThreads}`);

      const workerResponses = await this.spawnWorkerThreads(
        params,
        scenesToBeProcessed,
        numThreads
      );

      for (const workerResponse of workerResponses) {
        if (workerResponse !== undefined) {
          console.log(`workerResponse = ${JSON.stringify(workerResponse)}`);
        }
      }

      // check to see if we are done
      const filtered = scenesToBeProcessed
        .filter((boundary) =>
          boundary.response === undefined);

      // update new hash and embedding results to S3
      const name = `scene_boundary_${itemId}.json`;

      await uploadFile(bucket, framePrefix, name, sceneBoundaries);
      itemData.sceneBoundary = name;

      if (filtered.length === 0) {
        return this.setCompleted();
      }

      let percentage = (sceneBoundaries.length - filtered.length) / sceneBoundaries.length;
      percentage = Math.round(percentage * 100);

      return this.setProgress(percentage);
    } catch (e) {
      console.error(e);
      throw e;
    } finally {
      if (localCopy) {
        unlinkSync(localCopy);
      }
    }
  }

  setCompleted() {
    this.stateData.itemData.status = Completed;
    return this.stateData;
  }

  setProgress(progress) {
    const {
      itemData,
    } = this.stateData;

    itemData.status = InProgress;
    itemData.progress = progress;

    if (itemData.retries === undefined) {
      itemData.retries = 0;
    }
    itemData.retries += 1;

    return this.stateData;
  }

  async downloadOrCreateSceneBoundaries() {
    const {
      itemId,
      itemData,
    } = this.stateData;
    const {
      bucket,
      framePrefix,
      shotsToScenes: shotsToScenesJson,
      embeddings: embeddingsJson,
      nIterations,
    } = itemData;

    let sceneBoundaries = [];

    if (itemData.sceneBoundary) {
      sceneBoundaries = await download(bucket, join(framePrefix, itemData.sceneBoundary))
        .then((res) =>
          JSON.parse(res))
        .catch(() => ([]));
    }

    if (sceneBoundaries.length > 0) {
      return sceneBoundaries;
    }

    let promises = [];
    for (const name of [embeddingsJson, shotsToScenesJson]) {
      promises.push(download(bucket, join(framePrefix, name))
        .then((res) =>
          JSON.parse(res)));
    }
    promises = await Promise.all(promises);

    const [frameEmbeddings, shotsToScenes] = promises;

    const frameMap = {};
    for (const frame of frameEmbeddings.frames) {
      frameMap[String(frame.frameNum)] = frame;
    }

    for (let i = 0; i < shotsToScenes.length; i += 1) {
      if ((i % nIterations) !== itemId) {
        continue;
      }

      const cur = shotsToScenes[i];
      const nex = shotsToScenes[i + 1];
      if (nex === undefined) {
        continue;
      }

      // skip if it is already adjacent frames
      let frameFrom = cur.frameRange[1];
      let frameTo = nex.frameRange[0];
      if ((frameTo - frameFrom) <= 1) {
        continue;
      }

      if (frameMap[String(frameFrom)] === undefined) {
        throw new Error(`Frame#${frameFrom} not found`);
      }
      if (frameMap[String(frameTo)] === undefined) {
        throw new Error(`Frame#${frameTo} not found`);
      }

      frameFrom = frameMap[String(frameFrom)];
      frameTo = frameMap[String(frameTo)];
      sceneBoundaries.push({
        from: cur,
        to: nex,
        frames: [frameFrom, frameTo],
      });
    }

    return sceneBoundaries;
  }

  async createWorkerThread(
    threadId,
    threads,
    data,
    sceneBoundaries
  ) {
    const remaining = this.getRemainingTime();
    const bufferTime = 60 * 1000;
    const curTime = Date.now();
    const deadline = curTime + (remaining - bufferTime);

    let workerException;

    let workerThread = new Promise((resolve) => {
      console.log(`WorkerThread #${threadId}`);

      const parsed = parse(__filename);
      const file = join(parsed.dir, WORKER_JS);

      const worker = new Worker(file, {
        env: SHARE_ENV,
        workerData: {
          ...data,
          startIdx: threadId,
          step: threads,
          deadline,
        },
      });

      worker.on('message', (message) => {
        const {
          idx,
          response,
          error,
        } = message;

        if (error !== undefined) {
          console.error('ERR:', 'tid:', threadId, error);
          workerException = _wrapException(error);
          return;
        }

        // update frameHashes
        if (idx !== undefined && response !== undefined) {
          const boundary = sceneBoundaries[idx];

          if (boundary === undefined) {
            const error = new Error(`ERR: tid: ${threadId}: Shot boundary index (${idx}) out of range`);
            workerException = _wrapException(error);
            return;
          }

          const {
            frames: [frameFrom, frameTo],
          } = boundary;

          const fmin = frameFrom.frameNum - 1;
          const fmax = frameTo.frameNum + 1;

          for (const frame of response.newFrames) {
            if (frame.frameNum < fmin || frame.frameNum > fmax) {
              // debugger;
              const error = new Error(`ERR: tid: ${threadId}: Shot boundary frames (${frame.frameNum}) out of range. Expecting [${fmin}, ${fmax}]`);
              workerException = _wrapException(error);
              return;
            }
          }

          sceneBoundaries[idx].response = response;
        }
      });

      worker.on('error', (error) => {
        console.log(`[ERR]: WorkerThread #${threadId}: ${error.code} ${error.message}`);
        if (workerException === undefined) {
          workerException = _wrapException(error);
        }
        resolve(workerException);
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          console.log(`[ERR]: WorkerThread #${threadId}: exitCode: ${code}`);
          if (workerException === undefined) {
            workerException = _wrapException(`WorkerThread #${threadId}: exitCode: ${code}`);
          }
        }
        console.log(`WorkerThread #${threadId} [RETURNED]`);
        resolve(workerException);
      });
    });

    workerThread = await workerThread;

    return workerThread;
  }

  async spawnWorkerThreads(
    params,
    sceneBoundaries,
    numThreads
  ) {
    let workerResponses = [];

    for (let idx = 0; idx < numThreads; idx += 1) {
      workerResponses.push(this.createWorkerThread(
        idx,
        numThreads,
        params,
        sceneBoundaries
      ));
    }

    workerResponses = await Promise.all(workerResponses);

    return workerResponses;
  }
}

function _wrapException(error) {
  if (typeof error === 'string') {
    return new M2CException(error);
  }

  if (error.name) {
    return error;
  }

  const exception = new M2CException(error.message);
  if (error.code !== undefined) {
    exception.code = error.code;
  }

  return exception;
}

module.exports = StateFindFrameAccurateBoundary;
