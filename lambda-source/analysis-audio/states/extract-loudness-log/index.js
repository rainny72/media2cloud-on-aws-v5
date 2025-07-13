// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  cpus,
} = require('node:os');
const {
  join,
  parse,
} = require('node:path');
const {
  spawnSync,
} = require('node:child_process');
const {
  StateData,
  AnalysisError,
  CommonUtils: {
    getSignedUrl,
    uploadFile,
  },
  SegmentHelper: {
    GATEDLOUDNESS,
    MAXLOUDNESSDISTANCE,
    JSON_EBUR128,
  },
} = require('core-lib');

class StateExtractLoudnessLog {
  static opSupported(op) {
    return op === 'StateExtractLoudnessLog';
  }

  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new AnalysisError('stateData not StateData object');
    }
    this.$stateData = stateData;
  }

  get [Symbol.toStringTag]() {
    return 'StateExtractLoudnessLog';
  }

  get stateData() {
    return this.$stateData;
  }

  async process() {
    const {
      input: {
        destination: {
          bucket,
        },
        audio: {
          key: audioKey,
        },
      },
    } = this.stateData;

    // input file
    const url = await getSignedUrl({
      bucket,
      key: audioKey,
    });

    // ffmpeg -nostats -i input_file -map a -filter_complex ebur128 -f null -
    const cmdOpts = [
      '-nostats',
      '-i',
      url,
      '-map',
      'a',
      '-filter_complex',
      'ebur128',
      '-f',
      'null',
      '-'
    ];

    // run ffmpeg
    const t0 = Date.now();
    const ebuR128 = await _extractEbuR128Log(cmdOpts);
    const t1 = Date.now();

    const numGroups = ebuR128[ebuR128.length - 1].group + 1;
    // console.log(JSON.stringify(ebuR128, null, 2));
    console.log(`Number of loudness groups = ${numGroups}`);
    console.log(`_extractEbuR128Log: elapsed = ${t1 - t0}ms`);

    const parsed = parse(audioKey);
    const prefix = parsed.dir;
    const key = join(prefix, JSON_EBUR128);

    await uploadFile(bucket, prefix, JSON_EBUR128, ebuR128);

    const responseData = {
      loudness: {
        output: key,
        numGroups,
        startTime: t0,
        endTime: Date.now(),
      },
    };

    return responseData;
  }
}

async function _extractEbuR128Log(params) {
  const numCores = cpus().length;
  const cmdOpts = [
    '-threads',
    numCores,
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

  const logs = response.stderr.toString('utf8').split('\n');
  const ebuR128 = _parseEBUR128Logs(logs);

  return ebuR128;
}

function _parseEBUR128Logs(logs) {
  const loudnesses = [];

  for (const log of logs) {
    if (!log.startsWith('[Parsed_ebur128_0 @ ')) {
      continue;
    }

    const idx = log.indexOf(']') + 1;
    if (idx <= 0) {
      continue;
    }

    let items = log.slice(idx).split(/[\s:]+/);
    items = items.filter((x) =>
      x.length > 0 && x !== 'LUFS' && x !== 'LU');

    if (items.length !== 12) {
      continue;
    }

    const datapoint = {};
    while (items.length) {
      const key = items.shift();
      let value = items.shift();

      // only care about momentary loudness and timestamp
      if (key !== 't' && key !== 'M') {
        continue;
      }

      if (key === 't') {
        value = Math.round(Number(value) * 1000);
      }
      if (Number.isNaN(value)) {
        value = -100.0;
      }
      datapoint[key] = Number(value);
    }

    if (datapoint.t && datapoint.M) {
      loudnesses.push(datapoint);
    }
  }

  const len = loudnesses.length;
  loudnesses[0].group = 0;

  for (let i = 1; i < len; i += 1) {
    const pre = loudnesses[i - 1];
    const cur = loudnesses[i];

    const preM = Math.max(pre.M, GATEDLOUDNESS);
    const curM = Math.max(cur.M, GATEDLOUDNESS);
    if (Math.abs(preM - curM) > MAXLOUDNESSDISTANCE) {
      cur.group = pre.group + 1;
    } else {
      cur.group = pre.group;
    }
  }

  return loudnesses;
}

module.exports = StateExtractLoudnessLog;
