// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
  parse,
} = require('node:path');
const {
  createReadStream,
  writeFileSync,
  unlinkSync,
} = require('node:fs');
const {
  CommonUtils: {
    getSignedUrl,
    uploadStream,
    copyObject,
  },
} = require('core-lib');
const {
  runFFCommand,
} = require('../shared/ffcomand');

const AAC_CODEC = [
  '-c:a', 'aac',
  '-ac', 2,
  '-ar', 44100,
  '-ab', '96k',
];

async function _streamUpload(file, bucket, key, purge = true) {
  // copy file to bucket
  const stream = createReadStream(file);
  await uploadStream(bucket, key, stream);

  if (purge) {
    unlinkSync(file);
  }

  return  { bucket, key };
}

async function _copyFile(input, outBucket, outKey) {
  const { bucket, key } = input;
  const source = join('/', bucket, key);

  await copyObject(source, outBucket, outKey);

  return { bucket: outBucket, key: outKey };
}

async function _mergeAudio(bucket, iterators, tmpDir) {
  // no audio
  if (iterators.length === 0) {
    return undefined;
  }

  // already compress aac audio, no need to merge and encode
  if (iterators.length === 1 && iterators[0].ext === '.mp4') {
    return { bucket, key: iterators[0].output };
  }

  let cmdOpts = [];
  let index = 0;
  const filterComplex = [];
  for (const { output: key } of iterators) {
    const url = await getSignedUrl({ bucket, key });
    cmdOpts = cmdOpts.concat(['-i', url]);
    filterComplex.push(`[${index++}:a]`);
  }

  const outmap = '[aout]';
  filterComplex.push(`concat=n=${index}:v=0:a=1${outmap}`);

  const name = 'mergeaudio.mp4';
  let output = join(tmpDir, name);

  cmdOpts = cmdOpts.concat([
    '-filter_complex', filterComplex.join(''),
    '-map', outmap,
    ...AAC_CODEC,
    '-movflags', '+faststart',
    output,
  ]);

  // run ffmpeg
  const t0 = Date.now();
  output = await runFFCommand(cmdOpts);
  const t1 = Date.now();
  console.log(`_mergeAudio: elapsed = ${t1 - t0}ms`);

  // upload the file and delete local copy
  const prefix = parse(iterators[0].output).dir;
  return await _streamUpload(output, bucket, join(prefix, name));
}

async function _mergeVideo(bucket, iterators, tmpDir) {
  const urls = [];

  for (const { output: key } of iterators) {
    const url = await getSignedUrl({ bucket, key });
    urls.push(url);
  }

  // create a temporary filelist
  const tmpFile = join(tmpDir, 'videolist.txt');
  const files = urls.map((url) => `file ${url}`).join('\n');
  writeFileSync(tmpFile, `${files}\n`);

  const name = 'mergevideo.mp4';
  let output = join(tmpDir, name);

  // command options
  const cmdOpts = [
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
    '-safe', 0,
    '-f', 'concat',
    '-i', tmpFile,
    '-c', 'copy',
    '-movflags', '+faststart',
    output,
  ];

  // run ffmpeg
  const t0 = Date.now();
  output = await runFFCommand(cmdOpts);
  const t1 = Date.now();
  console.log(`_mergeVideo: elapsed = ${t1 - t0}ms`);

  // upload the file and delete local copy
  const prefix = parse(iterators[0].output).dir;
  return await _streamUpload(output, bucket, join(prefix, name));
}

async function _remuxAV(streams, tmpDir, outBucket, outKey) {
  let cmdOpts = [];

  const filtered = streams.filter((stream) => stream);
  if (filtered.length === 0) {
    return undefined;
  }

  if (filtered.length === 1) {
    return await _copyFile(filtered[0], outBucket, outKey);
  }

  for (const stream of filtered) {
    const url = await getSignedUrl(stream);
    cmdOpts = cmdOpts.concat(['-i', url]);
  }

  cmdOpts = cmdOpts.concat(['-c', 'copy', '-movflags', '+faststart']);

  let output = join(tmpDir, 'remuxed.mp4');
  cmdOpts.push(output);

  const t0 = Date.now();
  output = await runFFCommand(cmdOpts);
  const t1 = Date.now();
  console.log(`_remuxAV: elapsed = ${t1 - t0}ms`);

  return await _streamUpload(output, outBucket, outKey);
}

async function mergeVideo(bucket, iterators, tmpDir) {
  return await _mergeVideo(bucket, iterators, tmpDir);
}

async function mergeAudio(bucket, iterators, tmpDir) {
  return await _mergeAudio(bucket, iterators, tmpDir);
}

async function remuxAV(streams, tmpDir, outBucket, outKey) {
  return await _remuxAV(streams, tmpDir, outBucket, outKey);
}

module.exports = {
  mergeVideo,
  mergeAudio,
  remuxAV,
}