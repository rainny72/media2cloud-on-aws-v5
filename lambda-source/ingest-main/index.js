// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  Environment: {
    StateMachines: {
      Ingest,
    },
  },
  StateData,
  IotStatus,
  IngestError,
} = require('core-lib');
const StateCreateRecord = require('./states/create-record');
const StateFixityCompleted = require('./states/fixity-completed');
const StateIndexIngestResults = require('./states/index-ingest-results');
const StateJobCompleted = require('./states/job-completed');
const StateUpdateRecord = require('./states/update-record');

const REQUIRED_ENVS = [
  'ENV_SOLUTION_ID',
  'ENV_RESOURCE_PREFIX',
  'ENV_SOLUTION_UUID',
  'ENV_ANONYMOUS_USAGE',
  'ENV_IOT_HOST',
  'ENV_IOT_TOPIC',
  'ENV_INGEST_BUCKET',
  'ENV_PROXY_BUCKET',
  'ENV_SNS_TOPIC_ARN',
  'ENV_ES_DOMAIN_ENDPOINT',
];

function _parseEvent(event) {
  const { operation, nestedStateOutput } = event;
  if (!nestedStateOutput) {
    return event;
  }

  const { ExecutionArn, Output } = nestedStateOutput;
  if (ExecutionArn) {
    return {
      ...Output,
      operation,
    };
  }

  return {
    ...nestedStateOutput,
    operation,
  };
}

exports.handler = async (event, context) => {
  console.log(`event = ${JSON.stringify(event, null, 2)}; context = ${JSON.stringify(context, null, 2)};`);
  try {
    const missing = REQUIRED_ENVS.filter(x => process.env[x] === undefined);
    if (missing.length) {
      throw new IngestError(`missing enviroment variables, ${missing.join(', ')}`);
    }

    const parsed = _parseEvent(event);
    const stateData = new StateData(Ingest, parsed, context);

    let instance;
    const { operation } = parsed;

    if (StateCreateRecord.opSupported(operation)) {
      instance = new StateCreateRecord(stateData);
    } else if (StateFixityCompleted.opSupported(operation)) {
      instance = new StateFixityCompleted(stateData);
    } else if (StateUpdateRecord.opSupported(operation)) {
      instance = new StateUpdateRecord(stateData);
    } else if (StateIndexIngestResults.opSupported(operation)) {
      instance = new StateIndexIngestResults(stateData);
    } else if (StateJobCompleted.opSupported(operation)) {
      instance = new StateJobCompleted(stateData);
    }

    if (!instance) {
      throw new IngestError(`${event.operation} not supported`);
    }

    await instance.process();
    await IotStatus.publish(stateData.miniJSON());

    return stateData.toJSON();
  } catch (e) {
    console.error(e);
    throw e;
  }
};
