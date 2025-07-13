// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  Environment: {
    DynamoDB: {
      Ingest: {
        Table,
        PartitionKey,
      },
    },
  },
  DB,
  SNS,
  StateData,
  IngestError,
} = require('core-lib');

const {
  Statuses: {
    Processing,
    IngestCompleted,
  },
} = StateData;

class StateJobCompleted {
  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new IngestError('stateData not StateData object');
    }
    this.$stateData = stateData;
  }

  get [Symbol.toStringTag]() {
    return 'StateJobCompleted';
  }

  static opSupported(op) {
    return op === 'StateJobCompleted';
  }

  get stateData() {
    return this.$stateData;
  }

  async process() {
    const { uuid } = this.stateData;
    const overallStatus = Processing;
    const status = IngestCompleted;

    const db = new DB({ Table, PartitionKey });

    await db.update(uuid, undefined, {
      overallStatus,
      status,
    }, false);

    this.stateData.setCompleted(status);

    await SNS.send(`ingest: ${uuid}`, this.stateData.toJSON())
      .catch(() =>
        false);

    return this.stateData.toJSON();
  }
}

module.exports = StateJobCompleted;
