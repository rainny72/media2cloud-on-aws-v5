// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  S3Client,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const mxBaseResponse = require('../shared/mxBaseResponse');

const ExpectedBucketOwner = process.env.ENV_EXPECTED_BUCKET_OWNER;

exports.CreateModelList = async (event, context) => {
  try {
    class X0 extends mxBaseResponse(class {}) {}
    const x0 = new X0(event, context);

    if (x0.isRequestType('Delete')) {
      x0.storeResponseData('Status', 'SKIPPED');
      return x0.responseData;
    }

    const {
      ResourceProperties: {
        Data: {
          BedrockModelAcknowledgement = '',
          BedrockSecondaryRegionAccess = '',
          BedrockModelList = [],
          Output = {},
        },
      },
    } = event;

    const acknowledgement = BedrockModelAcknowledgement.toLowerCase();
    if (!['yes', 'true'].includes(acknowledgement)) {
      throw new Error('Bedrock model acknowledgement is missing.');
    }

    if (BedrockSecondaryRegionAccess.length === 0) {
      throw new Error('Bedrock secondary region access is missing.');
    }

    const { Bucket, Key } = Output;
    if (!Bucket || !Key) {
      throw new Error('Output bucket and key are missing.');
    }

    if (BedrockModelList.length === 0) {
      throw new Error('No model is specified');
    }

    const prefix = BedrockSecondaryRegionAccess.split('-')[0];
    const models = [];

    for (const model of BedrockModelList) {
      const {
        useInferenceProfile, modelId, modelPricing, embeddingSize, supportedRegions,
      } = model;

      if (useInferenceProfile === 'true') {
        model.useInferenceProfile = true;
        model.modelId = `${prefix}.${modelId}`;
      } else {
        model.useInferenceProfile = false;
      }
      if (embeddingSize !== undefined) {
        model.embeddingSize = Number(embeddingSize);
      }
      for (const [key, value] of Object.entries(modelPricing)) {
        modelPricing[key] = Number(value);
      }
      model.modelRegion = BedrockSecondaryRegionAccess;

      // (optional) supported regions
      if (supportedRegions !== undefined && supportedRegions.length > 0) {
        let regions = supportedRegions.split(',')
          .filter((x) => x)
          .map((x) => x.trim());
        regions.push(BedrockSecondaryRegionAccess);
        regions = [...new Set(regions)];
        model.supportedRegions = regions;
      }

      models.push(model);
    }

    // Now, upload the available models to proxy bucket
    const s3Client = new S3Client();
    const command = new PutObjectCommand({
      Bucket,
      Key,
      Body: JSON.stringify(models),
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
      ExpectedBucketOwner,
    });
    await s3Client.send(command);

    x0.storeResponseData('BedrockModelListLocation', Key);
    x0.storeResponseData('Status', 'SUCCESS');

    return x0.responseData;
  } catch (e) {
    e.message = `CreateModelList: ${e.message}`;
    throw e;
  }
};
