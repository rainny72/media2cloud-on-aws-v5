// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  parse,
  join,
} = require('node:path');
const {
  StateData: {
    Statuses: {
      Completed,
    },
  },
  CommonUtils: {
    listObjects,
  },
} = require('core-lib');
const BaseState = require('../shared/base');

const {
  ENV_PYANNOTE_AUDIO_FUNC: PyannoteAudioFunc,
  ENV_WHISPERX_FUNC: WhisperXFunc,
  ENV_DEEPFILTERNET_FUNC: DeepFilterNetFunc,
  ENV_AUDIOSET_TAGGING_FUNC: AudiosetTaggingFunc,
  ENV_MODEL_ARTEFACTS_PREFIX: ModelPrefix = '_model_artefacts',
} = process.env;

const CODEC = {
  'c:a': 'pcm_s16le',
  ar: 16000,
  ac: 1,
};

const DURATION_PER_ITERATOR = 600000; // 10mins
const MINDURATION = 60000; // 1min
const FASTSEEKPAD = 3000; // 3s
const SLIDING_WINDOW = 6000; // overlap 6s

class StatePrepareMetadataIterators extends BaseState {
  static opSupported(op) {
    return op === 'StatePrepareMetadataIterators';
  }

  get uuid() {
    return this.stateData.uuid;
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

  get aiOptions() {
    return this.input.aiOptions;
  }

  get data() {
    return this.stateData.data;
  }

  get audioExtractions() {
    return this.data.audioExtractions;
  }

  get inputaudio() {
    return this.input.audio;
  }

  get duration() {
    return this.input.duration;
  }

  async process() {
    try {
      const audioExtractions = this.audioExtractions;

      let audioKey = (this.inputaudio || {}).key;
      if (audioKey === undefined) {
        audioKey = audioExtractions[0].output;
      }

      if (!audioKey) {
        return this.setCompleted();
      }

      const { languageCode, asrModel } = this.aiOptions || {};

      const whisperXFunc = WhisperXFunc;
      const pyannoteAudioFunc = PyannoteAudioFunc;
      const deepFilterNetFunc = DeepFilterNetFunc;
      const audiosetTaggingFunc = AudiosetTaggingFunc;

      // prepare ffmpeg command options
      // ffmpeg -y -ss 1440.000 -to 2190.000 -i audio.wav -c copy test0-1440_2190.wav
      // ffmpeg -y -ss 1440.000 -to 2190.000 -i input_video -vn -c:a pcm_s16le -ab 96k -ar 16000 -ac 1 output_audio
      const uuid = this.uuid;
      const proxyBucket = this.proxyBucket;
      const totalDuration = this.duration;
      const parsed = parse(audioKey);
      const prefix = join(parsed.dir, 'metadata');
      const codec = CODEC;

      const commonSpec = {
        uuid,
        input: {
          bucket: proxyBucket,
          key: audioKey,
        },
        output: {
          bucket: proxyBucket,
          prefix,
        },
        codec,
      };

      if (languageCode) {
        commonSpec.languagecode = languageCode.slice(0, 2);
      }

      if (asrModel === 'whisperx' && whisperXFunc) {
        commonSpec.whisperXFunc = whisperXFunc;
        commonSpec.whisperXFunc2 = `${whisperXFunc}-2`;
        // check if we need to download whisper and alignment model artefacts from huggingface
        // and store them to s3 bucket.
        await this.checkModelArtefactsAvailability(commonSpec.languagecode);
      }

      const modelSpecs = [
        ['pyannoteAudioFunc', pyannoteAudioFunc],
        ['deepFilterNetFunc', deepFilterNetFunc],
        ['audiosetTaggingFunc', audiosetTaggingFunc],
      ];
      for (const [field, funcName] of modelSpecs) {
        if (funcName) {
          commonSpec[field] = funcName;
          commonSpec[`${field}2`] = `${funcName}-2`;
        }
      }

      let startTime = 0;
      const iterators = [];
      while (startTime < totalDuration) {
        const iterator = JSON.parse(JSON.stringify(commonSpec));
        const fastseekTime = Math.max(startTime - FASTSEEKPAD, 0);
        const accurateSeek = startTime - fastseekTime;
        iterator.seek = {
          fastss: fastseekTime,
          ss: accurateSeek,
          t: DURATION_PER_ITERATOR + SLIDING_WINDOW,
        };
        iterator.durationInOut = [startTime, startTime + DURATION_PER_ITERATOR];
        iterators.push(iterator);
        startTime += DURATION_PER_ITERATOR;
      }

      // merge the last iterator to the previous if is less than 3 minutes!
      if (iterators.length > 1) {
        let lastIterator = iterators[iterators.length - 1];
        let duration = totalDuration - lastIterator.seek.fastss;
        if (duration <= MINDURATION) {
          iterators.pop();
          // merge to previous
          lastIterator = iterators[iterators.length - 1];
          duration = Number(lastIterator.seek.t) + MINDURATION;
          lastIterator.seek.t = duration;
        }
      }
      iterators[iterators.length - 1].durationInOut[1] = totalDuration;
      this.data.iterators = iterators;

      return this.setCompleted();
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  async checkModelArtefactsAvailability(languagecode = '') {
    const {
      input: {
        destination: { bucket },
      },
      data,
    } = this.stateData;

    if (languagecode.length === 0) {
      return;
    }

    // ensure whisper model and language specific alignment model exist
    let hasWhisper = false;
    let hasAlignment = false

    // check whisper model
    let prefix = join(ModelPrefix, 'whisper', 'medium');
    let contents = await listObjects(bucket, prefix)
      .then((res) => res.Contents || [])
      .catch(() => ([]));

    for (const { Key } of contents) {
      const extension = parse(Key).ext;
      if (['.pth', '.safetensors', '.bin'].includes(extension)) {
        hasWhisper = true;
        break;
      }
    }

    // check alignment model
    prefix = join(ModelPrefix, 'alignment', languagecode);
    contents = await listObjects(bucket, prefix)
      .then((res) => res.Contents || [])
      .catch(() => ([]));

    for (const { Key } of contents) {
      const extension = parse(Key).ext;
      if (['.pth', '.safetensors', '.bin'].includes(extension)) {
        hasAlignment = true;
        break;
      }
    }

    if (!hasWhisper || !hasAlignment) {
      data.copy_model = {
        bucket,
        prefix: ModelPrefix,
      };

      // need whisper model
      if (!hasWhisper) {
        data.copy_model.whisper = 'medium';
      }

      // need language specific alignment model
      if (!hasAlignment) {
        data.copy_model.alignment = languagecode;
      }
    }
  }

  setCompleted() {
    this.stateData.status = Completed;
    if (this.data.iterators === undefined) {
      this.data.iterators = [];
    }
    return this.stateData;
  }
}

module.exports = StatePrepareMetadataIterators;
