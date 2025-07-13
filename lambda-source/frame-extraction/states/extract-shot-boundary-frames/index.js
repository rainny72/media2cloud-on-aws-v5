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
  ExceptionHelper: {
    nameToException,
  },
  M2CException,
} = require('core-lib');
const BaseState = require('../shared/base');

const WORKER_JS = 'worker.js';
const BAILOUT_RETRY = 10;

class StateExtractShotBoundaryFrames extends BaseState {
  static opSupported(op) {
    return op === 'StateExtractShotBoundaryFrames';
  }

  async process() {
    let localCopy;
    try {
      const {
        itemId,
        itemData,
      } = this.stateData;
      const {
        output: {
          bucket,
          framePrefix,
        },
        shotBoundaryFrames: shotBoundaryFramesJson,
      } = itemData;

      if (shotBoundaryFramesJson === undefined) {
        throw new Error('fail to collect shot boundary frames result');
      }

      if (itemData.retries && itemData.retries >= BAILOUT_RETRY) {
        throw new Error('Too many retries');
      }

      let shotBoundaries;
      let promises = [];

      promises.push(download(bucket, join(framePrefix, shotBoundaryFramesJson))
        .then((res) => {
          shotBoundaries = JSON.parse(res);
        }));

      await Promise.all(promises);

      const shotsToBeProcessed = shotBoundaries
        .filter((x) =>
          x.response === undefined);

      if (shotsToBeProcessed.length === 0) {
        return this.setCompleted();
      }

      // make a local copy
      localCopy = `${randomBytes(16).toString('hex')}-${itemId}.json`;
      localCopy = join(tmpdir(), localCopy);
      writeFileSync(localCopy, JSON.stringify({
        ...itemData,
        shotsToBeProcessed,
      }));

      const params = {
        jsonFile: localCopy,
      };

      const numThreads = cpus().length;
      // const numThreads = 2;
      console.log(`Threads = ${numThreads}`);

      const workerResponses = await this.spawnWorkerThreads(
        params,
        shotsToBeProcessed,
        numThreads
      );

      // check to see if we are done
      const filtered = shotsToBeProcessed
        .filter((boundary) =>
          boundary.response === undefined);

      // update new hash and embedding results to S3
      await uploadFile(bucket, framePrefix, shotBoundaryFramesJson, shotBoundaries);

      if (filtered.length === 0) {
        return this.setCompleted();
      }

      for (const workerResponse of workerResponses) {
        if (workerResponse !== undefined) {
          console.error(workerResponse);
        }
      }

      let percentage = (shotBoundaries.length - filtered.length) / shotBoundaries.length;
      percentage = Math.round(percentage * 100);

      return this.setProgress(percentage);
    } catch (e) {
      console.log(e);
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

  async createWorkerThread(
    threadId,
    threads,
    data,
    shotBoundaries
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
          const boundary = shotBoundaries[idx];

          if (boundary === undefined) {
            const error = new Error(`ERR: tid: ${threadId}: Shot boundary index (${idx}) out of range`);
            workerException = _wrapException(error);
            return;
          }

          let {
            frameFrom: {
              frameNum: fmin,
            },
            frameTo: {
              frameNum: fmax,
            },
          } = boundary;

          fmin = fmin - 1;
          fmax = fmax + 1;

          for (const frame of response.newFrames) {
            if (frame.frameNum < fmin || frame.frameNum > fmax) {
              const error = new Error(`ERR: tid: ${threadId}: Shot boundary frames (${frame.frameNum}) out of range. Expecting [${fmin}, ${fmax}]`);
              workerException = _wrapException(error);
              return;
            }
          }

          shotBoundaries[idx].response = response;
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
    shotBoundaries,
    numThreads
  ) {
    let workerResponses = [];

    for (let idx = 0; idx < numThreads; idx += 1) {
      workerResponses.push(this.createWorkerThread(
        idx,
        numThreads,
        params,
        shotBoundaries
      ));
    }

    workerResponses = await Promise.all(workerResponses);

    return workerResponses;
  }
}

function _wrapException(error) {
  if (typeof error === 'string') {
    return nameToException(error);
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

module.exports = StateExtractShotBoundaryFrames;
