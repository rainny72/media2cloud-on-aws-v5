// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  cpus,
} = require('node:os');
const {
  parse,
} = require('node:path');
const {
  spawnSync,
} = require('node:child_process');
const {
  CommonUtils: {
    getSignedUrl,
    uploadFile,
  },
  SegmentHelper: {
    JSON_EBUR128,
    JSON_LOUDNESSGROUP,
    MAXLOUDNESSDISTANCE,
    // level of loudness
    LUFS_ABSOLUTESILENT,
    LUFS_VERYQUIET,
    LUFS_QUIET,
    LUFS_MODERATE,
    LUFS_LOUD,
    // tags
    TAG_ABSOLUTESILENT,
    TAG_VERYQUIET,
    TAG_QUIET,
    TAG_MODERATE,
    TAG_LOUD,
    TAG_VERYLOUD,
  },
  SimpleMath: {
    min,
    max,
    rms,
  },
} = require('core-lib');
const BaseState = require('../shared/base');

class StateExtractLoudnessLog extends BaseState {
  static opSupported(op) {
    return op === 'StateExtractLoudnessLog';
  }

  get input() {
    return this.stateData.input;
  }

  get destination() {
    return this.input.destination;
  }

  get proxyBucket() {
    return this.destination.bucket;
  }

  get data() {
    return this.stateData.data;
  }

  get audioExtractions() {
    return this.data.audioExtractions;
  }

  async process() {
    const audioExtractions = this.audioExtractions;

    // input file
    const bucket = this.proxyBucket;
    const { output: audioKey } = audioExtractions[0];
    const url = await getSignedUrl({ bucket, key: audioKey });

    const cmdOpts = [
      '-nostats',
      '-i', url,
      '-map', 'a',
      '-filter_complex', 'ebur128',
      '-f', 'null',
      '-'
    ];

    // run ffmpeg
    const t0 = Date.now();
    const [ebuR128, loudnessGroups] = await _extractEbuR128Log(cmdOpts);
    const t1 = Date.now();

    // padding the loudness log
    const { input: { duration } } = this.stateData;
    _applyPaddingToLoudnessLogs(ebuR128, loudnessGroups, duration);

    const numGroups = loudnessGroups.length;
    // console.log(JSON.stringify(ebuR128, null, 2));
    console.log(`Number of loudness groups = ${numGroups}`);
    console.log(`_extractEbuR128Log: elapsed = ${t1 - t0}ms`);

    const parsed = parse(audioKey);
    const prefix = parsed.dir;

    const promises = [];
    for (const [name, data] of [[JSON_EBUR128, ebuR128], [JSON_LOUDNESSGROUP, loudnessGroups]]) {
      promises.push(uploadFile(bucket, prefix, name, data));
    }
    await Promise.all(promises);

    const responseData = {
      audioExtractions,
      loudness: {
        prefix,
        output: JSON_LOUDNESSGROUP,
        ebuR128: JSON_EBUR128,
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

  return _parseEBUR128Logs(logs);
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
      if (Number.isNaN(value) || value === 'nan') {
        value = -100.0;
      }
      datapoint[key] = Number(value);
    }

    if (datapoint.t && datapoint.M) {
      loudnesses.push(datapoint);
    }
  }

  const groups = _classifyLoudnessLevels(loudnesses);

  return [loudnesses, groups];
}

function _classifyLoudnessLevels(loudnesses) {
  const absoluteSilent = [];
  const veryQuiet = [];
  const quiet = [];
  const moderate = [];
  const loud = [];
  const veryLoud = [];

  for (let i = 3; i < loudnesses.length; i += 1) {
    const loudness = loudnesses[i];
    if (loudness.M <= LUFS_ABSOLUTESILENT) {
      absoluteSilent.push(loudness);
      continue;
    }

    if (loudness.M <= LUFS_VERYQUIET) {
      veryQuiet.push(loudness);
      continue;
    }

    if (loudness.M <= LUFS_QUIET) {
      quiet.push(loudness);
      continue;
    }

    if (loudness.M <= LUFS_MODERATE) {
      moderate.push(loudness);
      continue;
    }

    if (loudness.M <= LUFS_LOUD) {
      loud.push(loudness);
      continue;
    }

    veryLoud.push(loudness);
  }

  const taggedGroups = [
    [TAG_ABSOLUTESILENT, absoluteSilent],
    [TAG_VERYQUIET, veryQuiet],
    [TAG_QUIET, quiet],
    [TAG_MODERATE, moderate],
    [TAG_LOUD, loud],
    [TAG_VERYLOUD, veryLoud],
  ];

  let groups = [];

  for (const [, items] of taggedGroups) {
    if (items.length === 0) {
      continue;
    }

    let curGroup = [items[0]];
    for (let i = 1; i < items.length; i += 1) {
      const pre = curGroup[curGroup.length - 1];
      const cur = items[i];

      if (Math.abs(pre.t - cur.t) > 100) {
        groups.push(curGroup);
        curGroup = [cur];
        continue;
      }

      curGroup.push(cur);
    }

    if (curGroup.length > 0) {
      groups.push(curGroup);
      curGroup = [];
    }
  }
  groups.sort((a, b) => a[0].t - b[0].t);

  // reduction
  const reduction = [groups[0]];
  for (let i = 1; i < groups.length; i += 1) {
    const pre = reduction[reduction.length - 1];
    const cur = groups[i];
    const nex = groups[i + 1];

    // group longer than 500ms, let it be
    if (cur.length > 5) {
      reduction.push(cur);
      continue;
    }

    // absolute silent group, let it be
    if (cur[0].M <= LUFS_ABSOLUTESILENT) {
      reduction.push(cur);
      continue;
    }

    const diffA = Math.abs(pre[pre.length - 1].M - cur[0].M);
    let diffB = Number.MAX_SAFE_INTEGER;
    if (nex) {
      diffB = Math.abs(cur[cur.length - 1].M - nex[0].M);
    }

    // join previous group
    if (diffA < diffB && diffA <= MAXLOUDNESSDISTANCE) {
      reduction[reduction.length - 1] = pre.concat(cur);
      continue;
    }

    // join next group
    if (diffB < diffA && diffB <= MAXLOUDNESSDISTANCE) {
      groups[i + 1] = cur.concat(nex);
      continue;
    }

    reduction.push(cur);
  }

  console.log(`Reduction of groups: ${groups.length} -> ${reduction.length}`);

  groups = [];
  for (const group of reduction) {
    const Ms = group.map((x) => x.M);
    const minVal = min(Ms);
    const maxVal = max(Ms);
    const meanVal = rms(Ms);
    const avgVal = (maxVal + minVal) / 2;

    let label = TAG_VERYLOUD;
    if (avgVal <= LUFS_ABSOLUTESILENT) {
      label = TAG_ABSOLUTESILENT;
    } else if (avgVal <= LUFS_VERYQUIET) {
      label = TAG_VERYQUIET;
    } else if (avgVal <= LUFS_QUIET) {
      label = TAG_QUIET;
    } else if (avgVal <= LUFS_MODERATE) {
      label = TAG_MODERATE;
    } else if (avgVal <= LUFS_LOUD) {
      label = TAG_LOUD;
    }

    // loudness timestamps are discrete by 100ms gap. Pad the timestamps.
    const timestampRange = [
      Math.max(0, (group[0].t - 300) - 50),
      Math.max(0, (group[group.length - 1].t - 300) + 49),
    ];

    groups.push({
      label,
      timestampRange,
      minMaxMean: [minVal, maxVal, meanVal],
    });
  }

  return groups;
}

function _applyPaddingToLoudnessLogs(ebuR128, loudnessGroups, contentDuration) {
  let padding;

  // pad the first and last loudness timestamp to match the content duration
  if (Array.isArray(ebuR128) && ebuR128.length > 0) {
    padding = ebuR128[0];
    if (padding.t > 0) {
      ebuR128.unshift({ t: 0, M: padding.M });
    }
    padding = ebuR128[ebuR128.length - 1];
    if (padding.t < contentDuration) {
      ebuR128.push({ t: contentDuration, M: padding.M });
    }
  }

  // stretch the timestampRange to cover 0s and up to the content duration
  if (Array.isArray(loudnessGroups) && loudnessGroups.length > 0) {
    padding = loudnessGroups[0];
    if (padding.timestampRange[0] > 0) {
      padding.timestampRange[0] = 0;
    }
    padding = loudnessGroups[loudnessGroups.length - 1];
    if (padding.timestampRange[1] < contentDuration) {
      padding.timestampRange[1] = contentDuration;
    }
  }
}

module.exports = StateExtractLoudnessLog;
