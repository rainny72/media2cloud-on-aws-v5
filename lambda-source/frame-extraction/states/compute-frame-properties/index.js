// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
  parse,
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

class StateComputeFrameProperties extends BaseState {
  static opSupported(op) {
    return op === 'StateComputeFrameProperties';
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
        embeddings: embeddingsJson,
        filterSettings: blackFilter,
      } = itemData;

      if (itemData.retries && itemData.retries >= BAILOUT_RETRY) {
        throw new Error('Too many retries');
      }

      const frameEmbeddings = await download(bucket, join(framePrefix, embeddingsJson))
        .then((res) =>
          JSON.parse(res));

      const framesToBeProcessed = frameEmbeddings.frames
        .filter((frame) =>
          frame.hash === undefined || frame.embedding === undefined);

      if (framesToBeProcessed.length === 0) {
        return this.setCompleted();
      }

      // make a local copy
      localCopy = `${randomBytes(16).toString('hex')}-${itemId}.json`;
      localCopy = join(tmpdir(), localCopy);
      writeFileSync(localCopy, JSON.stringify({
        bucket,
        framePrefix,
        blackFilter,
        frames: framesToBeProcessed,
      }));

      const params = {
        jsonFile: localCopy,
      };

      const numThreads = cpus().length;
      console.log(`Threads = ${numThreads}`);

      const workerResponses = await this.spawnWorkerThreads(
        params,
        framesToBeProcessed,
        numThreads
      );

      const numEmbeddings = frameEmbeddings.frames
        .filter((x) =>
          x.embedding !== undefined).length;
      frameEmbeddings.titanApiCount = numEmbeddings;

      // check to see if we have any remaining scenes to processed
      const filtered = framesToBeProcessed
        .filter((frame) =>
          frame.hash === undefined || frame.embedding === undefined);

      // update new hash and embedding results to S3
      await uploadFile(bucket, framePrefix, embeddingsJson, frameEmbeddings);

      if (filtered.length === 0) {
        return this.setCompleted();
      }

      for (const workerResponse of workerResponses) {
        if (workerResponse !== undefined) {
          console.error(workerResponse);
        }
      }

      let percentage = (frameEmbeddings.frames.length - filtered.length) / frameEmbeddings.frames.length;
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

  async createWorkerThread(
    threadId,
    threads,
    data,
    frames
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
        try {
          const {
            idx: frameId, response, error,
          } = message;

          if (error !== undefined) {
            console.error('ERR:', 'tid:', threadId, error);
            workerException = _wrapException(error);
            return;
          }

          // update frameHashes
          if (frameId !== undefined && response !== undefined) {
            for (const [k, v] of Object.entries(response)) {
              frames[frameId][k] = v;
            }
            // console.log(`frame${frameId}:`, JSON.stringify(response));
          }
        } catch (e) {
          console.error(`[FATAL]: createWorkerThread: worker#${threadId}.message: ${JSON.stringify(message)}, ${e.message}`);
          throw e;
        };
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
    frames,
    numThreads
  ) {
    let workerResponses = [];

    for (let idx = 0; idx < numThreads; idx += 1) {
      workerResponses.push(this.createWorkerThread(
        idx,
        numThreads,
        params,
        frames
      ));
    }

    workerResponses = await Promise.all(workerResponses);

    return workerResponses;
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

module.exports = StateComputeFrameProperties;
