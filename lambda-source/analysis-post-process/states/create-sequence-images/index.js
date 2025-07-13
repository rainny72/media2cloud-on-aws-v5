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
  CommonUtils: {
    download,
    freeHeapMemory,
  },
  M2CException,
} = require('core-lib');
const BaseState = require('../shared/base');

const WORKER_JS = 'worker.js';

class StateCreateSequenceImages extends BaseState {
  static opSupported(op) {
    return op === 'StateCreateSequenceImages';
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
        prefix,
        shotsToScenes: sceneKey,
        embeddings: embeddingsKey,
        ids,
      } = itemData;

      let frameEmbeddings = await download(bucket, join(prefix, embeddingsKey))
        .then((res) =>
          JSON.parse(res));

      let sceneShots = await download(bucket, join(prefix, sceneKey))
        .then((res) =>
          JSON.parse(res));

      // make a local copy
      localCopy = `${randomBytes(16).toString('hex')}-${itemId}.json`;
      localCopy = join(tmpdir(), localCopy);

      writeFileSync(localCopy, JSON.stringify({
        ...itemData,
        frameEmbeddings,
        sceneShots,
        ids,
      }));

      // free up the heap memory
      frameEmbeddings = undefined;
      sceneShots = undefined;
      freeHeapMemory();

      const params = {
        jsonFile: localCopy,
      };

      const numThreads = cpus().length;
      console.log(`Threads = ${numThreads}`);

      const workerResponses = await this.spawnWorkerThreads(
        params,
        ids,
        numThreads
      );

      for (const workerResponse of workerResponses) {
        if (workerResponse !== undefined) {
          console.log(`workerResponse = ${JSON.stringify(workerResponse)}`);
          throw workerResponse;
        }
      }

      return ids;
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
    ids
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
          const scene = ids[idx];

          if (scene === undefined) {
            const error = new Error(`ERR: tid: ${threadId}: scene index (${idx}) out of range`);
            workerException = _wrapException(error);
            return;
          }

          if (scene.scene !== response.scene) {
            const error = new Error(`ERR: tid: ${threadId}: mismatch scene index [${scene.scene}, ${response.scene}]`);
            workerException = _wrapException(error);
            return;
          }

          scene.frameSequences = response.frameSequences;
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
    ids,
    numThreads
  ) {
    let workerResponses = [];

    for (let idx = 0; idx < numThreads; idx += 1) {
      workerResponses.push(this.createWorkerThread(
        idx,
        numThreads,
        params,
        ids
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

module.exports = StateCreateSequenceImages;
