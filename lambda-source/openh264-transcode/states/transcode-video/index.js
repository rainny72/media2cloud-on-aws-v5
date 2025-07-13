// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  createReadStream,
} = require('node:fs');
const {
  join,
  parse,
} = require('node:path');
const {
  CommonUtils: {
    uploadStream,
  },
  FFmpegHelper: {
    createTempDir,
    removeTempDir,
  },
} = require('core-lib');
const {
  transcode,
} = require('./transcodeHelper');
const BaseState = require('../shared/base');

class StateTranscodeVideo extends BaseState {
  static opSupported(op) {
    return op === 'StateTranscodeVideo';
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

  get proxyBucket() {
    return this.output.bucket;
  }

  get proxyPrefix() {
    return this.output.prefix;
  }

  get proxyName() {
    return this.output.name;
  }

  get type() {
    return this.itemData.type;
  }

  get seekCommand() {
    return this.itemData.seekCommand || {};
  }

  get audioCommand() {
    return this.itemData.audioCommand || {};
  }

  get videoCommand() {
    return this.itemData.videoCommand || {};
  }

  async process() {
    let tmpDir;

    try {
      tmpDir = await createTempDir(this.uuid);
      console.log(`tmpDir = ${tmpDir}`);

      const output = await transcode(this.input, this.videoCommand, this.audioCommand, this.seekCommand, tmpDir);

      // upload stream
      const { bucket, prefix, name } = this.output;
      const outKey = join(prefix, name);
      const stream = createReadStream(output);

      const response = await uploadStream(bucket, outKey, stream);
      console.log('upload completed', response);

      const { ext } = parse(output);

      return { itemId: this.itemId, output: outKey, type: this.type, ext };
    } catch (e) {
      console.error(e);
      throw e;
    } finally {
      console.log(`finally: removeTempDir: ${tmpDir}`);
      await removeTempDir(tmpDir);
    }
  }
}

module.exports = StateTranscodeVideo;
