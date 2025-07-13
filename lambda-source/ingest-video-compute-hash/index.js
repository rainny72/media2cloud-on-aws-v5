// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  Environment: {
    StateMachines: {
      Ingest,
    },
  },
  StateData,
  IngestError,
} = require('core-lib');
const StateRunMediaInfo = require('./states/run-mediainfo');
const StateCopySourceVideo = require('./states/copy-source-video');
const StateStartTranscode = require('./states/start-transcode');
const StateIngestVideoCompleted = require('./states/ingest-video-completed');

const REQUIRED_ENVS = [
  'ENV_SOLUTION_ID',
  'ENV_RESOURCE_PREFIX',
  'ENV_SOLUTION_UUID',
  'ENV_ANONYMOUS_USAGE',
  'ENV_IOT_HOST',
  'ENV_IOT_TOPIC',
  'ENV_MEDIACONVERT_HOST',
  'ENV_DATA_ACCESS_ROLE',
  'ENV_INGEST_BUCKET',
  'ENV_PROXY_BUCKET',
];

exports.handler = async (event, context) => {
  console.log(`event = ${JSON.stringify(event, null, 2)}; context = ${JSON.stringify(context, null, 2)};`);
  try {
    const missing = REQUIRED_ENVS.filter(x => process.env[x] === undefined);
    if (missing.length) {
      throw new IngestError(`missing enviroment variables, ${missing.join(', ')}`);
    }

    const stateData = new StateData(Ingest, event, context);

    const { operation } = event;
    let instance;

    if (StateRunMediaInfo.opSupported(operation)) {
      instance = new StateRunMediaInfo(stateData);
    } else if (StateStartTranscode.opSupported(operation)) {
      instance = new StateStartTranscode(stateData);
    } else if (StateCopySourceVideo.opSupported(operation)) {
      instance = new StateCopySourceVideo(stateData);
    } else if (StateIngestVideoCompleted.opSupported(operation)) {
      instance = new StateIngestVideoCompleted(stateData);
    }

    if (!instance) {
      throw new IngestError(`${event.operation} not supported`);
    }

    const response = await instance.process();

    if (response instanceof StateData) {
      return response.toJSON();
    }

    return response;
  } catch (e) {
    console.error(e);
    throw e;
  }
};
