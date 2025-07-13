// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  Environment: {
    StateMachines: {
      Analysis: AnalysisMain,
    },
  },
  IotStatus,
  StateData,
  AnalysisError,
} = require('core-lib');

const StatePrepareAnalysis = require('./states/prepare-analysis');
const StateCollectAnalysisResults = require('./states/collect-analysis-results');
const StateJobCompleted = require('./states/job-completed');

const {
  States: {
    PrepareAnalysis,
    CollectAnalysisResults,
    JobCompleted,
  },
} = StateData;

const REQUIRED_ENVS = [
  'ENV_SOLUTION_ID',
  'ENV_RESOURCE_PREFIX',
  'ENV_IOT_HOST',
  'ENV_IOT_TOPIC',
  'ENV_PROXY_BUCKET',
  'ENV_SNS_TOPIC_ARN',
  'ENV_DEFAULT_AI_OPTIONS',
  'ENV_DEFAULT_MINCONFIDENCE',
];

function _parseEvent(event) {
  const {
    operation,
    stateExecution,
    parallelStateOutputs,
  } = event;

  // parse state execution payload
  if (stateExecution) {
    const {
      Id: executionArn,
      Input,
    } = stateExecution;

    const merged = {
      operation,
      executionArn,
    };

    for (const [key, value] of Object.entries(Input)) {
      merged[key] = value;
    }

    return merged;
  }

  // merge Parallel state outputs
  if (parallelStateOutputs) {
    const merged = event;
    for (const stateOutput of parallelStateOutputs) {
      if (!stateOutput.ExecutionArn) {
        merged.uuid = stateOutput.uuid;
        merged.input = {
          ...merged.input,
          ...stateOutput.input,
        };
        merged.data = {
          ...merged.data,
          ...stateOutput.data,
        };
        continue;
      }

      if (stateOutput.Output) {
        merged.uuid = stateOutput.Output.uuid;
        merged.input = {
          ...merged.input,
          ...stateOutput.Output.input,
        };
        merged.data = {
          ...merged.data,
          ...stateOutput.Output.data,
        };
      }
    }

    delete merged.parallelStateOutputs;
    return merged;
  }

  return event;
}

exports.handler = async (event, context) => {
  console.log(`event = ${JSON.stringify(event, null, 2)}; context = ${JSON.stringify(context, null, 2)};`);
  try {
    const missing = REQUIRED_ENVS.filter(x => process.env[x] === undefined);
    if (missing.length) {
      throw new AnalysisError(`missing enviroment variables, ${missing.join(', ')}`);
    }

    const parsed = _parseEvent(event);
    const stateData = new StateData(AnalysisMain, parsed, context);
    const { operation } = parsed;

    let instance;

    if (operation === PrepareAnalysis) {
      instance = new StatePrepareAnalysis(stateData);
    } else if (operation === CollectAnalysisResults) {
      instance = new StateCollectAnalysisResults(stateData);
    } else if (operation === JobCompleted) {
      instance = new StateJobCompleted(stateData);
    } else {
      throw new AnalysisError(`${operation} not supported`);
    }

    await instance.process();
    await IotStatus.publish(stateData.miniJSON());
    return stateData.toJSON();
  } catch (e) {
    console.error(e);
    throw e;
  }
};
