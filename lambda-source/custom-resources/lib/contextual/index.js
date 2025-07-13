// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  PromptHelper: {
    GetBuiltinSystems,
    GetBuiltinTasks,
  },
  CommonUtils: {
    uploadFile,
  },
  M2CException,
} = require('core-lib');

const mxBaseResponse = require('../shared/mxBaseResponse');

class X0 extends mxBaseResponse(class {}) {}

exports.CopyBuiltinTasks = async (event, context) => {
  console.log(`event = ${JSON.stringify(event, null, 2)}`);

  const x0 = new X0(event, context);

  try {
    if (x0.isRequestType('Delete')) {
      x0.storeResponseData('Status', 'SKIPPED');
      return x0.responseData;
    }

    const {
      ResourceProperties: {
        Data: {
          ProxyBucket: bucket,
        },
      },
    } = event;

    if (!bucket) {
      throw new M2CException('missing Data.ProxyBucket');
    }

    let promises = [];

    const systems = GetBuiltinSystems();
    for (const system of systems) {
      const {
        name,
        installPaths,
        system: systemPrompt,
      } = system;

      const systemFile = `${name}.tmpl`;

      console.log(`=== UPLOADING ${systemFile}`);
      for (const installPath of installPaths) {
        promises.push(uploadFile(
          bucket,
          installPath,
          systemFile,
          systemPrompt
        ));
      }
    }

    const tasks = GetBuiltinTasks();
    for (const task of tasks) {
      const {
        name,
        installPaths,
      } = task;

      const taskFile = `${name}.json`;

      console.log(`=== UPLOADING ${taskFile}`);
      for (const installPath of installPaths) {
        promises.push(uploadFile(
          bucket,
          installPath,
          taskFile,
          task
        ));
      }
    }

    promises = await Promise.all(promises);

    x0.storeResponseData('Status', 'SUCCESS');
    return x0.responseData;
  } catch (e) {
    e.message = `CopyBuiltinTasks: ${e.message}`;
    console.error(e);
    x0.storeResponseData('Status', 'FAILED');
    return x0.responseData;
  }
};
