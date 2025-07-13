// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  M2CException,
} = require('core-lib');

const StatePrepareAudioIterators = require('./states/prepare-audio-iterators');
const StateExtractLoudnessLog = require('./states/extract-loudness-log');
const StateRunAmazonTranscribe = require('./states/run-amazon-transcribe');
const StateGetTranscribeResults = require('./states/get-transcribe-results');
const StateJobCompleted = require('./states/job-completed');

exports.handler = async (event, context) => {
  try {
    console.log(JSON.stringify(event, null, 2));
    console.log(JSON.stringify(context, null, 2));

    const {
      operation,
    } = event;

    // routing
    let instance;

    if (StatePrepareAudioIterators.opSupported(operation)) {
      instance = new StatePrepareAudioIterators(event, context);
    } else if (StateExtractLoudnessLog.opSupported(operation)) {
      instance = new StateExtractLoudnessLog(event, context);
    } else if (StateRunAmazonTranscribe.opSupported(operation)) {
      instance = new StateRunAmazonTranscribe(event, context);
    } else if (StateGetTranscribeResults.opSupported(operation)) {
      instance = new StateGetTranscribeResults(event, context);
    } else if (StateJobCompleted.opSupported(operation)) {
      instance = new StateJobCompleted(event, context);
    } else {
      throw new M2CException('invalid state');
    }

    return instance.process();
  } catch (e) {
    console.error(e);
    throw e;
  }
};
