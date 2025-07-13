// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  LambdaClient,
  ListLayerVersionsCommand,
} = require('@aws-sdk/client-lambda');
const mxBaseResponse = require('../shared/mxBaseResponse');

const FFMPEG_AGREE_AND_PROCEED = 'Yes, I understand and proceed';

exports.ConfirmFFmpegAgreeAndProceed = async (event, context) => {
  try {
    class X0 extends mxBaseResponse(class {}) {}
    const x0 = new X0(event, context);

    if (x0.isRequestType('Delete')) {
      x0.storeResponseData('Status', 'SKIPPED');
      return x0.responseData;
    }

    const {
      AgreeAndProceed,
      ResourcePrefix,
      FFmpegProjectName,
      FFmpegVersion,
      Runtime,
    } = event.ResourceProperties.Data;

    if (AgreeAndProceed !== FFMPEG_AGREE_AND_PROCEED) {
      throw new Error(AgreeAndProceed);
    }

    x0.storeResponseData('AgreeAndProceed', AgreeAndProceed);
    x0.storeResponseData('FFmpegProjectName', FFmpegProjectName);
    x0.storeResponseData('FFmpegVersion', FFmpegVersion);
    x0.storeResponseData('FFmpegLayerArn', '');

    const lambdaClient = new LambdaClient();

    const command = new ListLayerVersionsCommand({
      LayerName: `${ResourcePrefix}-${FFmpegProjectName}`,
      CompatibleRuntime: Runtime,
    });

    await lambdaClient.send(command)
      .then((res) => {
        if ((res.LayerVersions || []).length > 0) {
          res.LayerVersions.sort((a, b) =>
            b.Version - a.Version);

          const {
            Description = '',
            LayerVersionArn,
          } = res.LayerVersions[0]

          const matched = Description.match(/Version=([a-zA-Z0-9.]+)/);

          if (matched && matched[1] === FFmpegVersion) {
            x0.storeResponseData('FFmpegLayerArn', LayerVersionArn);
          }
        }
      })
      .catch(() =>
        undefined);

    x0.storeResponseData('Status', 'SUCCESS');

    return x0.responseData;
  } catch (e) {
    e.message = `FFmpegAgreeAndProceed: ${e.message}`;
    throw e;
  }
};
