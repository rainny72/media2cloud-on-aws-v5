// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  DB,
  Environment: {
    Solution: {
      Metrics: {
        AnonymousUsage,
      },
    },
    DynamoDB: {
      Ingest: {
        Table,
        PartitionKey,
      },
    },
  },
  StateData,
  Metrics: {
    sendAnonymousData,
  },
  Indexer,
  IngestError,
} = require('core-lib');

const INDEX_CONTENT = Indexer.getContentIndex();
const INGEST_FIELDS = Indexer.getIngestFields();

class StateIndexIngestResults {
  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new IngestError('stateData not StateData object');
    }
    this.$stateData = stateData;
  }

  get [Symbol.toStringTag]() {
    return 'StateIndexIngestResults';
  }

  static opSupported(op) {
    return op === 'StateIndexIngestResults';
  }

  get stateData() {
    return this.$stateData;
  }

  async process() {
    const { uuid, data } = this.stateData;

    const db = new DB({ Table, PartitionKey });
    const result = await db.fetch(uuid, undefined, INGEST_FIELDS);

    const indexer = new Indexer();
    await indexer.indexDocument(INDEX_CONTENT, uuid, result)
      .catch((e) => {
        console.error(
          'ERR:',
          'StateIndexIngestResults.process:',
          'indexer.indexDocument:',
          e.name,
          e.message,
          INDEX_CONTENT,
          uuid,
          JSON.stringify(result)
        );
        throw e;
      });

    await this.sendAnonymous(result);

    const terms = Object.keys(result);
    data.indexer = {
      ...data.indexer,
      terms,
    }

    this.stateData.setCompleted();

    return this.stateData.toJSON();
  }

  async sendAnonymous(data) {
    if (!AnonymousUsage) {
      return undefined;
    }

    const { uuid } = this.stateData;
    const { fileSize, duration = 0, mime } = data;

    const anonymousData = {
      process: 'ingest',
      uuid,
      fileSize,
      duration,
      mime,
    };

    return sendAnonymousData(anonymousData)
      .catch((e) =>
        console.log(`sendAnonymous: ${e.message}`));
  }
}

module.exports = StateIndexIngestResults;
