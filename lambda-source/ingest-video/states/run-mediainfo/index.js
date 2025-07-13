// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const PATH = require('path');
const {
  DB,
  CommonUtils,
  Environment: {
    DynamoDB: {
      Ingest: {
        Table: IngestTable,
        PartitionKey: IngestPartitionKey,
      },
    },
  },
  StateData,
  IngestError,
} = require('core-lib');
const {
  MediaInfoCommand,
} = require('mediainfo');

const CATEGORY = 'mediainfo';
const XML_OUTPUT = `${CATEGORY}.xml`;
const JSON_OUTPUT = `${CATEGORY}.json`;

class StateRunMediaInfo {
  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new IngestError('stateData not StateData object');
    }
    this.$stateData = stateData;
  }

  get [Symbol.toStringTag]() {
    return 'StateRunMediaInfo';
  }

  static opSupported(op) {
    return op === 'StateRunMediaInfo';
  }

  get stateData() {
    return this.$stateData;
  }

  async process() {
    const src = this.stateData.input;
    if (!src.destination || !src.destination.bucket || !src.destination.prefix) {
      throw new IngestError('missing destination');
    }
    /* #1: run mediainfo */
    const mi = new MediaInfoCommand();
    const fullData = await mi.analyze({
      Bucket: src.bucket,
      Key: src.key,
    });
    /* #2: store mediainfo.json and mediainfo.xml */
    const mediainfo = await this.uploadMediainfoFiles(src.destination, fullData, mi.rawXml);
    /* #3: update table */
    const parsed = mi.miniData;
    const video = parsed.video[0] || {};
    const container = parsed.container[0] || {};
    const duration = (container.duration || 0) * 1000;
    const framerate = video.frameRate || video.frameRateNominal || container.frameRate;
    let timeCodeFirstFrame = (parsed.timecode || {}).timeCodeFirstFrame;
    if (!timeCodeFirstFrame) {
      timeCodeFirstFrame = '00:00:00:00';
    }

    const db = new DB({
      Table: IngestTable,
      PartitionKey: IngestPartitionKey,
    });

    await db.update(this.stateData.uuid, undefined, {
      mediainfo,
      framerate,
      duration,
      timeCodeFirstFrame,
    }, false);
    /* #4: update state data */
    this.stateData.input.duration = duration;
    this.stateData.input.framerate = framerate;
    this.stateData.input.timeCodeFirstFrame = timeCodeFirstFrame;
    this.stateData.setData(CATEGORY, {
      ...parsed,
      output: mediainfo,
    });
    this.stateData.setCompleted();
    return this.stateData.toJSON();
  }

  async uploadMediainfoFiles(dest, json, xml) {
    const bucket = dest.bucket;
    // eslint-disable-next-line
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const prefix = PATH.join(dest.prefix, CATEGORY);
    return Promise.all([
      CommonUtils.uploadFile(bucket, prefix, JSON_OUTPUT, json)
        .then(() => {
          // eslint-disable-next-line
          // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
          const output = PATH.join(prefix, JSON_OUTPUT);
          return output;
        })
        .catch(e => console.error(e)),
      CommonUtils.uploadFile(bucket, prefix, XML_OUTPUT, xml)
        .then(() => {
          // eslint-disable-next-line
          // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
          const output = PATH.join(prefix, XML_OUTPUT);
          return output;
        })
        .catch(e => console.error(e)),
    ]);
  }
}

module.exports = StateRunMediaInfo;
