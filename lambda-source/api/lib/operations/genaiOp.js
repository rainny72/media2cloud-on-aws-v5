// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  ApiOps: {
    Tokenize,
  },
  SegmentHelper: {
    loadModelConfigs,
    getPreferredModel,
  },
  M2CException,
} = require('core-lib');
const {
  messageBuilder,
} = require('./genai/messageBuilder');
const BaseOp = require('./baseOp');

const {
  ENV_PROXY_BUCKET: ProxyBucket,
  ENV_BEDROCK_MODELLIST_LOCATION: ModelListLocation = '_settings/availablemodels.json',
} = process.env;

const SUBOP_TOKENIZE = Tokenize.split('/')[1];

class GenAIOp extends BaseOp {
  async onPOST() {
    const op = this.request.pathParameters.uuid;

    // special case: tokenizing the text
    if (op === SUBOP_TOKENIZE) {
      const tokens = await this.onTokenize();
      return super.onPOST(tokens);
    }

    const params = this.request.body || {};

    if (params.model === undefined
    || params.model.length === 0) {
      throw new M2CException('model name is missing');
    }

    if (params.prompt === undefined
    || params.prompt.length === 0) {
      throw new M2CException('prompt is missing');
    }

    if (params.text_inputs === undefined
    || params.text_inputs.length === 0) {
      throw new M2CException('text input is missing');
    }

    await loadModelConfigs(ProxyBucket, ModelListLocation);
    const model = await getPreferredModel([params.model]);

    const messages = await messageBuilder(op, params);
    const { response } = await model.inference(undefined, messages);

    return super.onPOST(response);
  }

  async onTokenize() {
    throw new M2CException('tokenize operation no longer supported');
  }
}

module.exports = GenAIOp;
