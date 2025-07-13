// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  ENV_PROXY_BUCKET: ProxyBucket,
  ENV_BEDROCK_MODELLIST_LOCATION: ModelLocations = '_settings/availablemodels.json',
} = process.env;

// model list location
const ModelListLocation = {
  bucket: ProxyBucket,
  location: ModelLocations,
};

// custom prompt template
const CustomPromptTemplate = {
  bucket: ProxyBucket,
  prefix: '_prompt_templates/analysis_post_process',
  programSequence: 'identifyProgramSequence.md',
  programStructure: 'identifyProgramStructure.md',
};

module.exports = {
  ModelListLocation,
  CustomPromptTemplate,
};
