// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  Environment: {
    StateMachines: {
      AdvancedVideoAnalysis,
      FaceRecognition: FaceRecognitionFlow,
    },
  },
  StateData,
  AnalysisTypes: {
    Structural,
    FaceRecognition,
  },
  FrameCaptureModeHelper: {
    suggestFrameCaptureRate,
  },
  M2CException,
} = require('core-lib');

const {
  AWS_REGION: Region,
  ENV_EXPECTED_BUCKET_OWNER: ExpectedBucketOwner,
} = process.env;

const StateMachineArn = `arn:aws:states:${Region}:${ExpectedBucketOwner}:stateMachine`;
const AdvancedVideoAnalysisArn = `${StateMachineArn}:${AdvancedVideoAnalysis}`;
const FaceRecognitionArn = `${StateMachineArn}:${FaceRecognitionFlow}`;
const EnableFaceRecognition = true;

class StatePrepareFrameAnalysisIterators {
  static opSupported(op) {
    return op === 'StatePrepareFrameAnalysisIterators';
  }

  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new M2CException('stateData not StateData object');
    }
    this.$stateData = stateData;
  }

  get [Symbol.toStringTag]() {
    return 'StatePrepareFrameAnalysisIterators';
  }

  get stateData() {
    return this.$stateData;
  }

  async process() {
    const { input, data } = this.stateData;

    const {
      destination: {
        bucket: proxyBucket, prefix: proxyPrefix,
      },
      video,
      aiOptions,
      duration,
      framerate,
      request: { timestamp: requestTime },
    } = input;

    const {
      minConfidence, frameCaptureMode,
    } = aiOptions;

    const {
      key: videoKey,
      frameExtraction,
      timeCodeFirstFrame,
      copyFromSource,
    } = video;

    const {
      numFrames, framePrefix,
    } = frameExtraction;

    const [numerator, denominator] = suggestFrameCaptureRate(framerate, frameCaptureMode);

    const frameCapture = {
      prefix: framePrefix,
      numFrames,
      numerator,
      denominator,
    };

    const sampling = Math.round((denominator / numerator) * 1000);

    // flatten all filter settings
    const filterSettings = {};

    if (aiOptions.filters) {
      for (const filterCategory of Object.values(aiOptions.filters)) {
        for (const [key, value] of Object.entries(filterCategory)) {
          filterSettings[key] = value;
        }
      }
    }

    const commonData = {
      bucket: proxyBucket,
      prefix: proxyPrefix,
      key: videoKey,
      duration,
      framerate,
      timeCodeFirstFrame,
      copyFromSource,
      frameExtraction,
      frameCaptureMode,
      requestTime,
      minConfidence,
      frameCapture,
      sampling,
      cursor: 0,
      numOutputs: 0,
      filterSettings,
    };

    let iterators = [];

    // advanced video analysis
    iterators = iterators.concat(this.makeAdvancedVideoAnalysisIterator(commonData, aiOptions));


    // face identification features
    const { celeb, facematch } = aiOptions;
    if (EnableFaceRecognition && (celeb || facematch)) {
      iterators = iterators.concat(this.makeFaceRecognitionFeatureIterators(commonData, aiOptions));
    }

    data.iterators = iterators;

    return this.stateData.toJSON();
  }

  makeFaceRecognitionFeatureIterators(commonData, aiOptions) {
    const {
      uuid, input: { audio },
    } = this.stateData;

    const {
      celeb, facematch, faceCollectionId, autofaceindexer,
    } = aiOptions;
    // optional audio metadata
    let audioData = {};
    if (audio !== undefined) {
      for (const field of ['diarisation']) {
        if (audio[field] !== undefined) {
          audioData[field] = audio[field];
        }
      }
    }

    const iterators = [];

    const iteratorData = {
      featureStateMachineArn: FaceRecognitionArn,
      uuid,
      input: {},
      data: {
        [FaceRecognition]: {
          aiOptions: { celeb, facematch, faceCollectionId, autofaceindexer },
          ...commonData,
          ...audioData,
        },
      },
    };
    iterators.push(iteratorData);

    return iterators;
  }

  makeAdvancedVideoAnalysisIterator(commonData, aiOptions) {
    aiOptions;
    const {
      uuid,
      input: {
        audio,
      }
    } = this.stateData;

    // optional audio metadata
    let audioData = {};
    if (audio !== undefined) {
      for (const field of ['diarisation', 'loudness']) {
        if (audio[field] !== undefined) {
          audioData[field] = audio[field];
        }
      }
    }

    const iterators = [];

    const iteratorData = {
      featureStateMachineArn: AdvancedVideoAnalysisArn,
      uuid,
      input: {},
      data: {
        [Structural]: {
          ...commonData,
          ...audioData,
        },
      },
    };
    iterators.push(iteratorData);

    return iterators;
  }
}

module.exports = StatePrepareFrameAnalysisIterators;
