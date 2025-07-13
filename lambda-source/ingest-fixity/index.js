// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  Environment: {
    StateMachines: {
      Ingest,
    },
  },
  StateData,
  ChecksumError,
} = require('core-lib');

const StateCheckRestoreStatus = require('./states/check-restore-status');
const StateComputeChecksum = require('./states/compute-checksum');
const StateValidateChecksum = require('./states/validate-checksum');

const REQUIRED_ENVS = [
  'ENV_SOLUTION_ID',
  'ENV_RESOURCE_PREFIX',
  'ENV_IOT_HOST',
  'ENV_IOT_TOPIC',
  'ENV_INGEST_BUCKET',
];

/**
 * @exports handler
 */
exports.handler = async (event, context) => {
  console.log(`event = ${JSON.stringify(event, null, 2)}; context = ${JSON.stringify(context, null, 2)};`);
  try {
    const missing = REQUIRED_ENVS.filter(x => process.env[x] === undefined);
    if (missing.length) {
      throw new ChecksumError(`missing enviroment variables, ${missing.join(', ')}`);
    }

    const stateData = new StateData(Ingest, event, context);

    let instance;
    const { operation } = event;

    if (StateCheckRestoreStatus.opSupported(operation)) {
      instance = new StateCheckRestoreStatus(stateData);
    } else if (StateComputeChecksum.opSupported(operation)) {
      instance = new StateComputeChecksum(stateData);
    } else if (StateValidateChecksum.opSupported(operation)) {
      instance = new StateValidateChecksum(stateData);
    }

    if (!instance) {
      throw new ChecksumError(`${event.operation} not supported`);
    }

    await instance.process();

    return stateData.toJSON();
  } catch (e) {
    console.error(e);
    throw e;
  }
};
