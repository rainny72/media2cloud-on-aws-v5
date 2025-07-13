// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  Environment: {
    StateMachines: {
      AudioAnalysis,
    },
  },
  StateData,
  AnalysisError,
} = require('core-lib');
/* transcribe */
const StateStartTranscribe = require('./states/start-transcribe');
const StateCollectTranscribeResults = require('./states/collect-transcribe-results');
const StateIndexTranscribeResults = require('./states/index-transcribe-results');
/* comprehend entity */
const StateStartEntity = require('./states/start-entity');
const StateIndexEntityResults = require('./states/index-entity-results');
/* comprehend keyphrase */
const StateStartKeyphrase = require('./states/start-keyphrase');
const StateIndexKeyphraseResults = require('./states/index-keyphrase-results');
/* comprehend sentiment */
const StateStartSentiment = require('./states/start-sentiment');
const StateIndexSentimentResults = require('./states/index-sentiment-results');
/* comprehend custom entity */
const StateCheckCustomEntityCriteria = require('./states/check-custom-entity-criteria');
const StateStartCustomEntity = require('./states/start-custom-entity');
const StateCheckCustomEntityStatus = require('./states/check-custom-entity-status');
const StateCreateCustomEntityTrack = require('./states/create-custom-entity-track');
const StateIndexCustomEntityResults = require('./states/index-custom-entity-results');
// comprehend analysis
const StatePrepareComprehendIterators = require('./states/prepare-comprehend-iterators');
const StateComprehendAnalysisCompleted = require('./states/comprehend-analysis-completed');
// job completed
const StateJobCompleted = require('./states/job-completed');

const REQUIRED_ENVS = [
  'ENV_SOLUTION_ID',
  'ENV_RESOURCE_PREFIX',
  'ENV_SOLUTION_UUID',
  'ENV_ANONYMOUS_USAGE',
  'ENV_IOT_HOST',
  'ENV_IOT_TOPIC',
  'ENV_PROXY_BUCKET',
  'ENV_DATA_ACCESS_ROLE',
  'ENV_ES_DOMAIN_ENDPOINT',
];

function _parseEvent(event, context) {
  const {
    operation,
    stateExecution,
    previousStateOutput,
  } = event;

  let merged = {
    ...event,
  };

  // parse state execution payload
  if (stateExecution) {
    const {
      Id: executionArn,
      StartTime,
      Input,
    } = stateExecution;

    merged = {
      ...merged,
      operation,
      executionArn,
      executionStartTime: new Date(StartTime).getTime(),
    };

    for (const [key, value] of Object.entries(Input)) {
      merged[key] = value;
    }
  }

  // data from previous state
  if (previousStateOutput !== undefined) {
    const {
      data = {},
    } = merged;

    for (const [key, value] of Object.entries(previousStateOutput)) {
      data[key] = {
        ...data[key],
        ...value,
      };
    }
  }

  delete merged.stateExecution;
  delete merged.previousStateOutput;

  return new StateData(AudioAnalysis, merged, context);
}

exports.handler = async (event, context) => {
  console.log(`event = ${JSON.stringify(event, null, 2)}; context = ${JSON.stringify(context, null, 2)};`);

  try {
    const missing = REQUIRED_ENVS.filter(x => process.env[x] === undefined);
    if (missing.length) {
      throw new AnalysisError(`missing enviroment variables, ${missing.join(', ')}`);
    }
    const stateData = _parseEvent(event, context);

    const { operation } = stateData;

    /* state routing */
    let instance;

    switch (operation) {
      /* transcribe */
      case StateData.States.StartTranscribe:
        instance = new StateStartTranscribe(stateData);
        break;
      case StateData.States.CollectTranscribeResults:
        instance = new StateCollectTranscribeResults(stateData);
        break;
      case StateData.States.IndexTranscribeResults:
        instance = new StateIndexTranscribeResults(stateData);
        break;
      /* comprehend */
      case StateData.States.StartEntity:
        instance = new StateStartEntity(stateData);
        break;
      case StateData.States.IndexEntityResults:
        instance = new StateIndexEntityResults(stateData);
        break;
      case StateData.States.StartKeyphrase:
        instance = new StateStartKeyphrase(stateData);
        break;
      case StateData.States.IndexKeyphraseResults:
        instance = new StateIndexKeyphraseResults(stateData);
        break;
      case StateData.States.StartSentiment:
        instance = new StateStartSentiment(stateData);
        break;
      case StateData.States.IndexSentimentResults:
        instance = new StateIndexSentimentResults(stateData);
        break;
      case StateData.States.CheckCustomEntityCriteria:
        instance = new StateCheckCustomEntityCriteria(stateData);
        break;
      case StateData.States.StartCustomEntity:
        instance = new StateStartCustomEntity(stateData);
        break;
      case StateData.States.CheckCustomEntityStatus:
        instance = new StateCheckCustomEntityStatus(stateData);
        break;
      case StateData.States.CreateCustomEntityTrack:
        instance = new StateCreateCustomEntityTrack(stateData);
        break;
      case StateData.States.IndexCustomEntityResults:
        instance = new StateIndexCustomEntityResults(stateData);
        break;
      default:
        break;
    }

    if (!instance) {
      if (StatePrepareComprehendIterators.opSupported(operation)) {
        instance = new StatePrepareComprehendIterators(stateData);
      } else if (StateComprehendAnalysisCompleted.opSupported(operation)) {
        instance = new StateComprehendAnalysisCompleted(stateData);
      } else if (StateJobCompleted.opSupported(operation)) {
        instance = new StateJobCompleted(stateData);
      }
    }

    if (!instance) {
      throw new AnalysisError(`${event.operation} not supported`);
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
