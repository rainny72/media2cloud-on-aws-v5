// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  StateData,
  IngestError,
  DB,
  Environment: {
    StateMachines: {
      AudioIngest,
      VideoIngest,
      ImageIngest,
      DocumentIngest,
    },
    DynamoDB: {
      Ingest: {
        Table,
        PartitionKey,
      },
    },
  },
  M2CException,
} = require('core-lib');
const {
  MediaInfoCommand,
} = require('mediainfo');

const REGION = process.env.AWS_REGION;

const MEDIATYPE_VIDEO = 'video';
const MEDIATYPE_AUDIO = 'audio';
const MEDIATYPE_IMAGE = 'image';
const MEDIATYPE_DOCUMENT = 'document';

class StateFixityCompleted {
  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new IngestError('stateData not StateData object');
    }
    this.$stateData = stateData;
  }

  get [Symbol.toStringTag]() {
    return 'StateFixityCompleted';
  }

  static opSupported(op) {
    return op === 'StateFixityCompleted';
  }

  get stateData() {
    return this.$stateData;
  }

  /* If type is video, double check to make sure the asset indeed contains video track */
  async confirmMediaType() {
    const {
      input: {
        bucket,
        key,
        type,
      },
    } = this.stateData;

    if (type !== MEDIATYPE_VIDEO) {
      return type;
    }

    const mi = new MediaInfoCommand();
    await mi.analyze({
      Bucket: bucket,
      Key: key,
    });

    if ((mi.video || []).length === 0) {
      return MEDIATYPE_AUDIO;
    }

    return MEDIATYPE_VIDEO;
  }

  async updateMediaType(type) {
    const db = new DB({ Table, PartitionKey });
    return db.update(this.stateData.uuid, undefined, {
      type,
    }, false);
  }

  async process() {
    const { input: { type } } = this.stateData;

    const confirmedType = await this.confirmMediaType();

    if (type !== confirmedType) {
      this.stateData.input.type = confirmedType;
      await this.updateMediaType(confirmedType);
    }

    return this.setCompleted();
  }

  setCompleted() {
    const {
      accountId,
      input: {
        type: mediaType,
      },
      data,
    } = this.stateData;

    let mediaStateMachine;

    if (mediaType === MEDIATYPE_AUDIO) {
      mediaStateMachine = AudioIngest;
    } else if (mediaType === MEDIATYPE_VIDEO) {
      mediaStateMachine = VideoIngest;
    } else if (mediaType === MEDIATYPE_IMAGE) {
      mediaStateMachine = ImageIngest;
    } else if (mediaType === MEDIATYPE_DOCUMENT) {
      mediaStateMachine = DocumentIngest;
    } else {
      throw M2CException(`media type not support, ${mediaType}`);
    }

    data.mediaStateMachineArn = [
      'arn:aws:states',
      REGION,
      accountId,
      'stateMachine',
      mediaStateMachine,
    ].join(':');

    this.stateData.setCompleted();

    return this.stateData.toJSON();
  }
}

module.exports = StateFixityCompleted;
