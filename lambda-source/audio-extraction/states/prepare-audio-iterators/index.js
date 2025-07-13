// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
  parse,
} = require('node:path');
const {
  createReadStream,
} = require('node:fs');
const {
  StateData: {
    Statuses: {
      Completed,
    },
  },
  CommonUtils: {
    listObjects,
    uploadStream,
  },
  FFmpegHelper: {
    createTempDir,
    removeTempDir,
  }
} = require('core-lib');
const {
  extractAudio,
} = require('./audiostream');
const {
  getStreamInfo,
} = require('../shared/streaminfo');
const BaseState = require('../shared/base');

const WHISPER_LANGUAGES = [
  'en', 'fr', 'de', 'es', 'it',
  'ja', 'zh', 'nl', 'uk', 'pt',
  'ar', 'cs', 'ru', 'pl', 'hu',
  'fi', 'fa', 'el', 'tr', 'da',
  'he', 'vi', 'ko', 'ur', 'te',
  'hi', 'ca', 'ml', 'no', 'nn',
  'sk', 'sl', 'hr', 'ro', 'eu',
  'gl', 'ka', 'lv', 'tl',
];

class StatePrepareAudioIterators extends BaseState {
  static opSupported(op) {
    return op === 'StatePrepareAudioIterators';
  }

  get uuid() {
    return this.stateData.uuid;
  }

  get input() {
    return this.stateData.input;
  }

  get ingestBucket() {
    return this.input.bucket;
  }

  get ingestKey() {
    return this.input.key;
  }

  get destination() {
    return this.input.destination;
  }

  get proxyBucket() {
    return this.destination.bucket;
  }

  get proxyPrefix() {
    return this.destination.prefix;
  }

  get aiOptions() {
    return this.input.aiOptions;
  }

  get data() {
    return this.stateData.data;
  }

  get transcode() {
    return this.data.transcode;
  }

  async process() {
    let tmpDir;
    try {
      tmpDir = await createTempDir(this.uuid);
      console.log(`tmpDir = ${tmpDir}`);

      const { bucket, key } = await this.getProxyLocation();

      const streaminfo = await getStreamInfo(bucket, key);
      let { output, command } = await extractAudio(bucket, key, streaminfo, tmpDir);

      // check if we can use Whisper model or Amazon Transcribe
      this.chooseAsrModel(streaminfo);

      const prefix = join(this.proxyPrefix, 'audio/0');
      const name = parse(output).base;
      const outKey = join(prefix, name);

      const stream = createReadStream(output);
      const response = await uploadStream(bucket, outKey, stream);
      console.log('upload completed', response);

      this.data.audioExtractions = [{
        itemId: 0, command, output: outKey,
      }];

      return this.setCompleted();
    } catch (e) {
      console.error(e);
      throw e;

    } finally {
      console.log(`finally: removeTempDir: ${tmpDir}`);
      await removeTempDir(tmpDir);
    }
  }

  async getProxyLocation() {
    const bucket = this.proxyBucket;
    const { output } = this.transcode;

    const response = await listObjects(bucket, output);
    for (const { Key: key } of response.Contents) {
      if (['.mp4', '.mov'].includes(parse(key).ext.toLowerCase())) {
        return { bucket, key };
      }
    }

    throw new Error('No transcoded asset?');
  }

  chooseAsrModel(streaminfo) {
    let asrModel = _chooseAsrModel(this.aiOptions);
    if (streaminfo.audiostreams.length === 0) {
      asrModel = 'undefined';
    }
    this.aiOptions.asrModel = asrModel;
    return asrModel;
  }

  setCompleted() {
    this.stateData.status = Completed;
    return this.stateData;
  }
}

function _chooseAsrModel(aiOptions = {}) {
  const { transcribe, languageCode = '' } = aiOptions;
  if (!transcribe) {
    return 'undefined';
  }

  const code = languageCode.slice(0, 2);
  if (WHISPER_LANGUAGES.includes(code)) {
    return 'whisperx';
  }
  return 'transcribe';
}

module.exports = StatePrepareAudioIterators;
