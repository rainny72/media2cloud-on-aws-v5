// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
} = require('node:path');
const {
  CommonUtils: {
    debugLocally,
    download,
    uploadFile,
  },
  SegmentHelper: {
    loadModelConfigs,
    getPreferredModel,
  }
} = require('core-lib');
const {
  ModelListLocation,
  CustomPromptTemplate,
} = require('./defs');

const THRESHOLD_LAMBDA_TIMEOUT = 2 * 60 * 1000;

class BaseState {
  constructor(event, context) {
    this.$event = event;
    this.$context = context;

    this.$stateData = event;
    if ((event.stateExecution || {}).Input !== undefined) {
      this.$stateData = event.stateExecution.Input;
      this.$stateData.operation = event.operation;
    }

    let fn = () =>
      THRESHOLD_LAMBDA_TIMEOUT * 2;
    if (typeof (context || {}).getRemainingTimeInMillis === 'function') {
      fn = context.getRemainingTimeInMillis;
    }
    this.$fnGetRemainingTime = fn.bind();
  }

  get event() {
    return this.$event;
  }

  get context() {
    return this.$context;
  }

  get stateData() {
    return this.$stateData;
  }

  get input() {
    return this.stateData.input;
  }

  get data() {
    return this.stateData.data;
  }

  get proxyBucket() {
    const { destination: { bucket } } = this.input;
    return bucket;
  }

  get proxyPrefix() {
    const { destination: { prefix } } = this.input;
    return prefix;
  }

  get inputaudio() {
    return this.input.audio;
  }

  get datavideo() {
    return this.data.video;
  }

  get rekognition() {
    return (this.datavideo || {}).rekognition;
  }

  get structural() {
    return (this.rekognition || {}).structural;
  }

  get dataaudio() {
    return this.data.audio;
  }

  async process() {
    return this.stateData;
  }

  getRemainingTime() {
    return this.$fnGetRemainingTime();
  }

  lambdaTimeout() {
    const remainingTime = this.$fnGetRemainingTime();
    return (remainingTime - THRESHOLD_LAMBDA_TIMEOUT) <= 0;
  }

  static opSupported(op) {
    op;
    return false;
  }

  async getUserDefinedTemplate(name, stringOrFunction = '') {
    let defaultTemplate;

    if (typeof stringOrFunction === 'function') {
      defaultTemplate = stringOrFunction();
    } else if (typeof stringOrFunction === 'string') {
      defaultTemplate = stringOrFunction;
    }

    if (debugLocally()) {
      return defaultTemplate;
    }

    const { bucket, prefix } = CustomPromptTemplate;
    let template = await download(bucket, join(prefix, name))
      .catch(() => undefined);

    if (template === undefined && defaultTemplate.length > 0) {
      template = defaultTemplate;
      await uploadFile(bucket, prefix, name, template);
    }

    return template;
  }

  async getModel(name) {
    const { bucket, location } = ModelListLocation;
    await loadModelConfigs(bucket, location);

    return await getPreferredModel(name);
  }
}

module.exports = BaseState;
