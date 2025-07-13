// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
  parse,
} = require('node:path');
const {
  StateData: {
    Statuses: {
      Completed,
    },
  },
  FFmpegHelper: {
    createTempDir,
    removeTempDir,
  },
} = require('core-lib');
const {
  mergeAudio,
  mergeVideo,
  remuxAV,
} = require('./mergeHelper');
const BaseState = require('../shared/base');

class StateTranscodeCompleted extends BaseState {
  static opSupported(op) {
    return op === 'StateTranscodeCompleted';
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

  get iterators() {
    return this.data.iterators;
  }

  async process() {
    let tmpDir;

    try {
      tmpDir = await createTempDir(this.uuid);
      console.log(`tmpDir = ${tmpDir}`);

      const audioStreams = [];
      const videoStreams = [];

      for (const stream of this.iterators) {
        const { type } = stream;
        if (type === 'audio') {
          audioStreams.push(stream);
        } else if (type === 'video') {
          videoStreams.push(stream);
        } else {
          throw new Error(`type not defined. ${JSON.stringify(stream)}`);
        }
      }

      let promises = [];
      const bucket = this.proxyBucket;

      audioStreams.sort((a, b) => a.itemId - b.itemId);
      promises.push(mergeAudio(bucket, audioStreams, tmpDir));

      videoStreams.sort((a, b) => a.itemId - b.itemId);
      promises.push(mergeVideo(bucket, videoStreams, tmpDir));

      promises = await Promise.all(promises);

      const prefix = join(this.proxyPrefix, 'transcode/aiml');
      const name = `${parse(this.ingestKey).name}.mp4`;
      const outKey = join(prefix, name);

      const muxed = await remuxAV(promises, tmpDir, bucket, outKey);
      if (!muxed) {
        throw new Error('No output generated');
      }

      this.data.transcode = {
        ...this.data.transcode,
        output: join(this.proxyPrefix, 'transcode'),
      };

      return this.setCompleted();
    } catch (e) {
      console.error(e);
      throw e;
    } finally {
      console.log(`finally: removeTempDir: ${tmpDir}`);
      await removeTempDir(tmpDir);
    }
  }

  setCompleted() {
    this.stateData.status = Completed;
    this.data.transcode.endTime = Date.now();
    delete this.data.iterators;
    return this.stateData;
  }
}

module.exports = StateTranscodeCompleted;
