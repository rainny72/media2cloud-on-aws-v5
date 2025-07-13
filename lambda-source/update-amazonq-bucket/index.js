// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const StateUpdateAmazonQBucket = require('./states/update-amazonq-bucket');

exports.handler = async (event, context) => {
  console.log(`event = ${JSON.stringify(event, null, 2)};`);
  console.log(`context = ${JSON.stringify(context, null, 2)};`);

  try {
    const parsed = _parseEvent(event);
    const op = parsed.operation;

    let instance;
    if (StateUpdateAmazonQBucket.canHandle(op)) {
      instance = new StateUpdateAmazonQBucket(parsed, context);
    } else {
      throw new Error(`${op} not implemented`);
    }

    const responseData = await instance.process();

    console.log('responseData', JSON.stringify(responseData, null, 2));
    return responseData;
  } catch (e) {
    console.log(e);
    throw e;
  }
};

function _parseEvent(event) {
  if (event.detail === undefined) {
    return event;
  }

  // call from Amazon EventBridge, parse the output from dynamic frame segmentation state machine
  const parsed = JSON.parse(event.detail.output);

  // default to the first state of the state machine
  parsed.operation = 'StateUpdateAmazonQBucket';

  return parsed;
}
