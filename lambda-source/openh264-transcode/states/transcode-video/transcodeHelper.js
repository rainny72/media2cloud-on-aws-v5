// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
  parse,
} = require('node:path');
const {
  CommonUtils: {
    getSignedUrl,
  },
} = require('core-lib');
const {
  runFFCommand,
} = require('../shared/ffcomand');

async function _buildFFCommands(input, videoCommand = {}, audioCommand = {}, seekCommand = {}, tmpDir = '/tmp') {
  let cmdOpts = [];

  const { fastss, ss, t } = seekCommand;
  if (fastss !== undefined) {
    cmdOpts = cmdOpts.concat(['-ss', fastss]);
  }

  // input option
  const url = await getSignedUrl(input);
  cmdOpts = cmdOpts.concat(['-i', url]);

  // accurate seek option
  if (ss !== undefined) {
    cmdOpts = cmdOpts.concat(['-ss', ss]);
  }

  // duration option
  if (t !== undefined) {
    cmdOpts = cmdOpts.concat(['-t', t]);
  }

  // input mapping
  for (const { inmap } of [videoCommand, audioCommand]) {
    if (inmap !== undefined) {
      cmdOpts = cmdOpts.concat(['-map', inmap]);
    }
  }

  // filter_complex
  let filterComplex = [];
  for (const { filter_complex } of [videoCommand, audioCommand]) {
    if (filter_complex !== undefined) {
      filterComplex.push(filter_complex);
    }
  }

  if (filterComplex.length > 0) {
    filterComplex = filterComplex.join(';');
    cmdOpts = cmdOpts.concat(['-filter_complex', filterComplex]);
  }

  // output mapping
  for (const { outmap } of [videoCommand, audioCommand]) {
    if (outmap !== undefined) {
      cmdOpts = cmdOpts.concat(['-map', outmap]);
    }
  }

  // frame to process
  const { vframes } = seekCommand;
  if (vframes !== undefined) {
    cmdOpts = cmdOpts.concat(['-frames:v', vframes]);
  }

  // force pixel format
  const { pix_fmt } = videoCommand;
  if (pix_fmt !== undefined) {
    cmdOpts = cmdOpts.concat(['-pix_fmt', pix_fmt]);
  }

  // video/audio codec
  for (const { codec = {} } of [videoCommand, audioCommand]) {
    for (const [key, val] of Object.entries(codec)) {
      cmdOpts = cmdOpts.concat([`-${key}`, val]);
    }
  }

  // ignore video output
  if (Object.keys(videoCommand) === 0) {
    cmdOpts.push('-vn');
  }

  // ignore audio output
  if (Object.keys(audioCommand) === 0) {
    cmdOpts.push('-an');
  }

  // fast download
  const ext = videoCommand.ext || audioCommand.ext;
  if (ext === '.mp4') {
    cmdOpts = cmdOpts.concat(['-movflags', '+faststart']);
  }

  // intermediate output
  let output = join(tmpDir, `out${ext}`);
  cmdOpts.push(output);

  return cmdOpts;
}

async function _transcode(input, videoCommand = {}, audioCommand = {}, seekCommand = {}, tmpDir = '/tmp') {
  const cmdOpts = await _buildFFCommands(input, videoCommand, audioCommand, seekCommand, tmpDir);

  // run transcode process
  let t0 = Date.now();
  let output = await runFFCommand(cmdOpts);
  let t1 = Date.now();

  console.log(`_transcode: elapsed = ${t1 - t0}ms`);


  // restamp pts
  const { ext } = parse(output);
  if (ext === '.mp4') {
    output = await _restampAV(output, tmpDir);
  }

  return output;
}

async function _restampAV(input, tmpDir) {
  const { ext } = parse(input);
  let output = join(tmpDir, `restamped${ext}`);

  const cmdOpts = [
    '-i', input,
    '-c', 'copy',
    '-fflags', '+genpts',
    '-reset_timestamps', 1,
    output,
  ];

  // run transcode process
  let t0 = Date.now();
  output = await runFFCommand(cmdOpts);
  let t1 = Date.now();

  console.log(`_restampAV: elapsed = ${t1 - t0}ms`);
  return output;
}

async function transcode(input, videoCommand, audioCommand, seekCommand, tmpDir) {
  return await _transcode(input, videoCommand, audioCommand, seekCommand, tmpDir);
}

module.exports = {
  transcode,
};
