// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  parse,
  join,
} = require('node:path');
const {
  StateData,
  IngestError,
  CommonUtils: {
    copyObject,
  },
} = require('core-lib');

const OUTPUT_GROUP = 'transcode/aiml';

class StateCopySourceVideo {
  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new IngestError('stateData not StateData object');
    }
    this.$stateData = stateData;
  }

  get [Symbol.toStringTag]() {
    return 'StateCopySourceVideo';
  }

  get stateData() {
    return this.$stateData;
  }

  static opSupported(op) {
    return op === 'StateCopySourceVideo';
  }

  async process() {
    const {
      input: {
        bucket: srcBucket,
        key: srcKey,
        destination: {
          bucket: dstBucket,
          prefix: dstPrefix,
        },
      },
      data,
    } = this.stateData;

    const startTime = Date.now();

    const source = join('/', srcBucket, srcKey);
    const name = parse(srcKey).base;

    await copyObject(source, dstBucket, join(dstPrefix, OUTPUT_GROUP, name));

    data.transcode = {
      output: join(dstPrefix, 'transcode', '/'),
      copyFromSource: true,
      startTime,
      endTime: Date.now(),
    }

    return this.stateData;
  }
}

module.exports = StateCopySourceVideo;
