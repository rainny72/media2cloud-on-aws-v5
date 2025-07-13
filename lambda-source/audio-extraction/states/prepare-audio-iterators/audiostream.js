// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
} = require('node:path');
const {
  CommonUtils: {
    getSignedUrl,
  },
} = require('core-lib');
const {
  runFFCommand,
} = require('../shared/ffcomand');

const CODEC = {
  // 'c:a': 'pcm_s16le',
  'ac': 1,
  'ar': 16000,
  'c:a': 'flac',
  'sample_fmt': 's16',
};

function _mapChannels(tracks) {
  if (tracks.length === 1) {
    const { mapId: inmap } = tracks[0];
    return { inmap };
  }

  // multi-mono tracks
  const l = tracks[0];
  const r = tracks[1];
  let inmap = [l, r].map((trk) => `[${trk.mapId}]`);
  inmap = inmap.join('');

  const outmap = '[stereo]';
  const filter_complex = `${inmap}amerge=inputs=2${outmap}`;

  return { filter_complex, outmap };
}

function _getAudioMapping(streaminfo) {
  let mapping;
  const codec = CODEC;

  let tracks = streaminfo.getAudioByCodecName('aac');
  if (tracks.length === 0) {
    tracks = streaminfo.getMultiChannelTracks();
  }

  if (tracks.length > 0) {
    tracks = [tracks[0]];
  } else {
    // mono tracks
    tracks = streaminfo.getMonoTracks();
    tracks = tracks.slice(0, 2);
  }

  mapping = _mapChannels(tracks);
  return { codec, ...mapping };
}

async function _extractAudio(bucket, key, streaminfo, tmpDir) {
  const { inmap, filter_complex, outmap, codec } = _getAudioMapping(streaminfo);
  const url = await getSignedUrl({ bucket, key });

  let cmdOpts = ['-i', url];
  if (inmap) {
    cmdOpts = cmdOpts.concat(['-map', inmap]);
  }
  if (filter_complex) {
    cmdOpts = cmdOpts.concat(['-filter_complex', filter_complex]);
  }
  if (outmap) {
    cmdOpts = cmdOpts.concat(['-map', outmap]);
  }

  for (const [key, val] of Object.entries(codec)) {
    cmdOpts = cmdOpts.concat([`-${key}`, val]);
  }

  cmdOpts.push('-vn');

  // output
  let ext = '.wav';
  if (codec['c:a'] === 'flac') {
    ext = '.flac';
  }
  const name = `audio${ext}`;
  let output = join(tmpDir, name);
  cmdOpts.push(output);

  const t0 = Date.now();
  output = await runFFCommand(cmdOpts);
  const t1 = Date.now();
  console.log(`_extractAudion: elapsed = ${t1 - t0}ms`);

  return { output, command: { inmap, filter_complex, outmap, codec } };
}

async function extractAudio(bucket, key, streaminfo, tmpDir) {
  return await _extractAudio(bucket, key, streaminfo, tmpDir);
}

module.exports = {
  extractAudio,
};
