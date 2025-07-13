// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
} = require('node:path');
const {
  StateData: {
    Statuses: { Completed },
  },
} = require('core-lib');
const {
  getStreamInfo,
} = require('./streaminfo');
const {
  buildVideoSegmentCommands,
} = require('./videosegment');
const {
  buildAudioSegmentCommands,
} = require('./audiosegment');
const BaseState = require('../shared/base');

const PREFIXSEGMENTCHUNKS = 'segment_chunks';

class StatePrepareTranscodeIterators extends BaseState {
  static opSupported(op) {
    return op === 'StatePrepareTranscodeIterators';
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

  get mediainfo() {
    return this.data.mediainfo;
  }

  get mediaContainer() {
    return (this.mediainfo || {}).container;
  }

  get mediaVideo() {
    return (this.mediainfo || {}).video;
  }

  get mediaAudio() {
    return (this.mediainfo || {}).audio;
  }

  async process() {
    // Mesh all filter settings
    let filterSettings = {};
    const { filters = {} } = this.aiOptions || {};
    for (const filter of Object.values(filters)) {
      filterSettings = { ...filterSettings, ...filter };
    }

    const bucket = this.ingestBucket;
    const key = this.ingestKey;
    const streaminfo = await getStreamInfo(bucket, key);

    // upload the stream info
    const outBucket = this.proxyBucket;
    const outPrefix = join(this.proxyPrefix, PREFIXSEGMENTCHUNKS);
    await streaminfo.upload(outBucket, outPrefix);

    // handle video and audio separately to avoid incorrect frame number due to misalignment of a/v
    const videoIterators = this.buildVideoSegments(streaminfo, filterSettings);
    const audioIterators = this.buildAudioSegments(streaminfo, filterSettings);

    // if more than 2 hours, use a larger lambda function
    const { invokedFunctionArn } = this.context;
    let functionArn = invokedFunctionArn;
    if (audioIterators.length > 4) {
      functionArn = `${functionArn}-2`;
    }

    this.data.iterators = videoIterators.concat(audioIterators);

    return this.setCompleted(functionArn);
  }

  setCompleted(functionArn) {
    this.stateData.status = Completed;

    this.data.transcode = {
      functionArn,
      encoder: 'openh264',
      startTime: Date.now(),
    };

    if (this.data.iterators === undefined) {
      this.data.iterators = [];
    }
    return this.stateData;
  }

  buildVideoSegments(streaminfo, filterSettings) {
    const { invokedFunctionArn } = this.context;
    const functionArn = invokedFunctionArn;

    const inputSettings = {
      bucket: this.ingestBucket,
      key: this.ingestKey,
    };

    const outBucket = this.proxyBucket;
    const outPrefix = join(this.proxyPrefix, PREFIXSEGMENTCHUNKS);
    const outputSettings = {
      bucket: outBucket,
      prefix: outPrefix,
    };

    let index = 0;
    const iterators = [];

    const { videoCommand, seekCommands } = buildVideoSegmentCommands(streaminfo, filterSettings);
    const { ext } = videoCommand;
    for (const seekCommand of seekCommands) {
      iterators.push({
        functionArn,
        uuid: this.uuid,
        input: inputSettings,
        output: {
          ...outputSettings,
          name: `video_${index++}${ext}`,
        },
        type: 'video',
        videoCommand,
        seekCommand,
      });
    }

    return iterators;
  }

  buildAudioSegments(streaminfo, filterSettings) {
    const { invokedFunctionArn } = this.context;
    const functionArn = invokedFunctionArn;

    const inputSettings = {
      bucket: this.ingestBucket,
      key: this.ingestKey,
    };

    const outBucket = this.proxyBucket;
    const outPrefix = join(this.proxyPrefix, PREFIXSEGMENTCHUNKS);
    const outputSettings = {
      bucket: outBucket,
      prefix: outPrefix,
    };

    let index = 0;
    const iterators = [];

    const { audioCommand, seekCommands } = buildAudioSegmentCommands(streaminfo, filterSettings);
    const { ext } = audioCommand;
    for (const seekCommand of seekCommands) {
      iterators.push({
        functionArn,
        uuid: this.uuid,
        input: inputSettings,
        output: {
          ...outputSettings,
          name: `audio_${index++}${ext}`,
        },
        type: 'audio',
        audioCommand,
        seekCommand,
      });
    }

    return iterators;
  }
}

module.exports = StatePrepareTranscodeIterators;
