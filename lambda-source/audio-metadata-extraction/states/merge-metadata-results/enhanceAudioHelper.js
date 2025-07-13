// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  tmpdir,
  cpus,
} = require('node:os');
const {
  mkdtemp,
  rm,
} = require('node:fs/promises');
const {
  randomBytes,
} = require('node:crypto');
const {
  createReadStream,
} = require('node:fs');
const {
  spawnSync,
} = require('node:child_process');
const {
  join,
} = require('node:path');
const {
  CommonUtils: {
    getSignedUrl,
    uploadStream,
  },
} = require('core-lib');

const DURATION_PER_ITERATOR = 10 * 60 * 1000; // 12 * 60 * 1000;
const M4AOUT = 'audio_enhanced.m4a';
const DEEPFILTERNET_MODEL = 'deepfilternet';

async function _merge(outBucket, outPrefix, iterators, totalDuration) {
  totalDuration;

  let tmpDir;
  try {
    if (iterators.length === 0) {
      return {};
    }

    tmpDir = await _createTempDir();
    console.log(`tmpDir = ${tmpDir}`);

    const inputs = [];
    for (const iterator of iterators) {
      const {
        bucket, prefix, enhancedAudio, segmentAudio: { itemId }
      } = iterator;
      inputs.push({ itemId, bucket, prefix, enhancedAudio });
    }
    inputs.sort((a, b) => a.itemId - b.itemId);

    let cmdOpts = await _buildCmdOpts(inputs);
    if (cmdOpts === undefined) {
      return {};
    }

    const m4aOut = join(tmpDir, M4AOUT);
    cmdOpts = [
      ...cmdOpts,
      '-c:a',
      'aac',
      m4aOut,
    ];

    // run ffmpeg
    const t0 = Date.now();
    await _encodeAudio(cmdOpts);
    const t1 = Date.now();
    console.log(`_encodeAudio: elapsed = ${t1 - t0}ms`);

    const outKey = join(outPrefix, M4AOUT);
    const stream = createReadStream(m4aOut);

    const response = await uploadStream(outBucket, outKey, stream);
    console.log('upload completed', response);

    return {
      audioenhancement: {
        model: DEEPFILTERNET_MODEL,
        prefix: outPrefix,
        output: M4AOUT,
        startTime: t0,
        endTime: t1,
      },
    };
  } catch (e) {
    console.error(e);
    throw e;
  } finally {
    console.log(`finally: removeTempDir: ${tmpDir}`);
    await _removeTempDir(tmpDir);
  }
}

async function _buildCmdOpts(inputs = []) {
  if (inputs.length === 0) {
    return undefined;
  }

  const urls = [];
  const filterComplexInputs = [];
  let filterComplexOutputs = [];

  const duration = (DURATION_PER_ITERATOR / 1000).toFixed(3);
  for (const input of inputs) {
    const { itemId, bucket, prefix, enhancedAudio } = input;

    const url = await getSignedUrl({ bucket, key: join(prefix, enhancedAudio) });
    urls.push(url);

    filterComplexInputs.push(`[${itemId}:0]atrim=duration=${duration}[a${itemId}]`);
    filterComplexOutputs.push(`[a${itemId}]`);
  }
  filterComplexOutputs = `${filterComplexOutputs.join('')}concat=n=${inputs.length}:v=0:a=1[out]`;
  filterComplexInputs.push(filterComplexOutputs);

  const filterComplex = filterComplexInputs.join(';');


  let options = [];
  for (const url of urls) {
    options.push('-i');
    options.push(url);
  }
  options = [
    ...options,
    '-filter_complex',
    filterComplex,
    '-map',
    '[out]',
  ];

  return options;
}

async function _encodeAudio(params) {
  const numCores = cpus().length;
  const cmdOpts = [
    '-y',
    '-threads',
    numCores,
    '-v',
    'quiet',
    ...params,
  ];
  console.log(`cmdOpts: ${cmdOpts.join(' ')}`)

  const shOptions = {
    cwd: undefined,
    env: process.env,
    maxBuffer: 60 * 1024 * 1024,
  };

  const response = spawnSync('ffmpeg', cmdOpts, shOptions);

  if (response.error !== undefined) {
    console.log(response.error);
    throw new Error(response.error);
  }

  if (response.status !== 0) {
    console.log(response);

    if (response.stdout instanceof Buffer) {
      console.log('stdout:', response.stdout.toString('utf8'));
    } else if (typeof response.stdout === 'string') {
      console.log('stdout:', response.stdout);
    }

    if (response.stderr instanceof Buffer) {
      console.log('stderr:', response.stderr.toString('utf8'));
    } else if (typeof response.stderr === 'string') {
      console.log('stderr:', response.stderr);
    }

    throw new Error(`exitcode not zero: ${response.status}`);
  }

  return response;
}

async function _createTempDir() {
  const random = randomBytes(4).toString('hex');
  const directory = await mkdtemp(join(tmpdir(), random));
  return directory;
}

async function _removeTempDir(directory) {
  if (directory) {
    try {
      await rm(directory, {
        force: true,
        recursive: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    } catch (e) {
      console.error(e);
    }
  }
}

////////////////////////////////////////////////////
// Functions to export
////////////////////////////////////////////////////
async function merge(outBucket, outPrefix, iterators, totalDuration) {
  return _merge(outBucket, outPrefix, iterators, totalDuration);
}

module.exports = {
  merge,
};
