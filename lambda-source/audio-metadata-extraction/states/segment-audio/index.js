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
  createReadStream,
} = require('node:fs');
const {
  join,
} = require('node:path');
const {
  spawnSync,
} = require('node:child_process');
const {
  CommonUtils: {
    getSignedUrl,
    uploadStream,
  },
} = require('core-lib');
const BaseState = require('../shared/base');

const WAV_OUTPUT = 'audio.wav';
const WAV_ENHANCED_OUTPUT = 'audio_enhanced.wav';
const JSON_DIARISATION = 'diarisation.json';
const JSON_TRANSCRIPT = 'whisperx_segments.json';
const JSON_AUDIOTAGS = 'audio_tags.json';

class StateSegmentAudio extends BaseState {
  static opSupported(op) {
    return op === 'StateSegmentAudio';
  }

  get itemId() {
    return this.stateData.itemId;
  }

  get itemData() {
    return this.stateData.itemData;
  }

  get uuid() {
    return this.itemData.uuid;
  }

  get input() {
    return this.itemData.input;
  }

  get inputBucket() {
    return this.input.bucket;
  }

  get inputKey() {
    return this.input.key;
  }

  get output() {
    return this.itemData.output;
  }

  get outBucket() {
    return this.output.bucket;
  }

  get outPrefix() {
    return this.output.prefix;
  }

  async process() {
    let tmpDir;

    try {
      const {
        seek,
        codec,
        durationInOut,
        pyannoteAudioFunc,
        pyannoteAudioFunc2,
        whisperXFunc,
        whisperXFunc2,
        deepFilterNetFunc,
        deepFilterNetFunc2,
        audiosetTaggingFunc,
        audiosetTaggingFunc2,
        languagecode,
      } = this.itemData;

      tmpDir = await _createTempDir(this.uuid);
      console.log(`tmpDir = ${tmpDir}`);

      let cmdOpts = [];
      // fastss: fastseekTime,
      // ss: accurateSeek,
      // t: DURATION_PER_ITERATOR + SLIDING_WINDOW,
      const { fastss, ss, t } = seek;

      // fast seek option
      if (fastss !== undefined) {
        cmdOpts = cmdOpts.concat(['-ss', (fastss / 1000).toFixed(6)]);
      }

      // input file
      const bucket = this.inputBucket;
      const key = this.inputKey;
      const url = await getSignedUrl({
        bucket,
        key,
      });
      cmdOpts = cmdOpts.concat(['-i', url]);

      // accurate seek option
      if (ss !== undefined) {
        cmdOpts = cmdOpts.concat(['-ss', (ss / 1000).toFixed(6)]);
      }

      // t option
      if (t !== undefined) {
        cmdOpts = cmdOpts.concat(['-t', (t / 1000).toFixed(6)]);
      }

      // codec
      if (codec !== undefined) {
        for (const [key, value] of Object.entries(codec)) {
          cmdOpts = cmdOpts.concat([`-${key}`, value]);
        }
      }

      // output
      const wavOut = join(tmpDir, WAV_OUTPUT);
      cmdOpts.push(wavOut);

      // run ffmpeg
      const t0 = Date.now();
      await _extractAudio(cmdOpts);
      const t1 = Date.now();
      console.log(`_extractAudio: elapsed = ${t1 - t0}ms`);

      const outPrefix = join(this.outPrefix, String(this.itemId));
      const outKey = join(outPrefix, WAV_OUTPUT);
      const stream = createReadStream(wavOut);

      const response = await uploadStream(this.outBucket, outKey, stream);
      console.log('upload completed', response);

      // pyannote lambda expected fields
      let responseData = {
        bucket: this.outBucket,
        prefix: outPrefix,
        name: WAV_OUTPUT,
        enhancedAudio: WAV_ENHANCED_OUTPUT,
        output: JSON_DIARISATION,
        transcript: JSON_TRANSCRIPT,
        audioTags: JSON_AUDIOTAGS,
        pyannoteAudioFunc,
        pyannoteAudioFunc2,
        whisperXFunc,
        whisperXFunc2,
        deepFilterNetFunc,
        deepFilterNetFunc2,
        audiosetTaggingFunc,
        audiosetTaggingFunc2,
        languagecode,
      };

      responseData = {
        ...responseData,
        segmentAudio: {
          itemId: this.itemId,
          output: outKey,
          durationInOut,
          startTime: t0,
          endTime: Date.now(),
        },
      };

      return responseData;
    } catch (e) {
      console.error(e);
      throw e;
    } finally {
      console.log(`finally: removeTempDir: ${tmpDir}`);
      await _removeTempDir(tmpDir);
    }
  }
}

async function _extractAudio(params) {
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
  // const response = spawnSync('/opt/bin/ffmpeg', cmdOpts, shOptions);

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

async function _createTempDir(uuid) {
  const directory = await mkdtemp(join(tmpdir(), uuid));
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

module.exports = StateSegmentAudio;
