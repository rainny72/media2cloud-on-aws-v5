// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const mxBaseResponse = require('../shared/mxBaseResponse');

exports.GenericHandler = async (event, context) => {
  class X0 extends mxBaseResponse(class {}) {}
  const x0 = new X0(event, context);

  if (x0.isRequestType('Delete')) {
    x0.storeResponseData('Status', 'SKIPPED');
    return x0.responseData;
  }

  const resource = event.ResourceType.split(':').pop();
  throw Error(`${resource} not implemented`);
};
