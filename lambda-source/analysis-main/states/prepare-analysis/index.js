// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  parse,
} = require('node:path');
const {
  RekognitionClient,
  ListFacesCommand,
  DescribeProjectVersionsCommand,
} = require('@aws-sdk/client-rekognition');
const {
  TranscribeClient,
  DescribeLanguageModelCommand,
  GetVocabularyCommand,
} = require('@aws-sdk/client-transcribe');
const {
  ComprehendClient,
  DescribeEntityRecognizerCommand,
} = require('@aws-sdk/client-comprehend');
const {
  aimlGetPresets,
  DB,
  CommonUtils: {
    download,
    headObject,
    makeSafeOutputPrefix,
  },
  StateData,
  Environment: {
    Solution: {
      Metrics: {
        CustomUserAgent,
      },
    },
    StateMachines: {
      AudioAnalysis,
      VideoAnalysis,
      ImageAnalysis,
      DocumentAnalysis,
    },
    DynamoDB: {
      Ingest: {
        Table: IngestTable,
        PartitionKey: IngestPartitionKey,
      },
    },
    Proxy: {
      Bucket: ProxyBucket,
    },
  },
  AnalysisTypes: {
    Rekognition: {
      Celeb,
      Face,
      FaceMatch,
      Label,
      Moderation,
      Text,
      CustomLabel,
      Person,
      Segment,
    },
    Transcribe,
    Comprehend: {
      Keyphrase,
      Entity,
      Sentiment,
      CustomEntity,
    },
    Textract,
    AutoFaceIndexer,
    Scene,
  },
  AnalysisError,
  ServiceAvailability,
  FrameCaptureMode,
  xraysdkHelper,
  retryStrategyHelper,
} = require('core-lib');

const DEFAULT_AI_OPTIONS = process.env.ENV_DEFAULT_AI_OPTIONS;
const AI_OPTIONS_S3KEY = process.env.ENV_AI_OPTIONS_S3KEY;

const TYPE_REKOGNITION_IMAGE = [
  Celeb,
  Face,
  FaceMatch,
  Label,
  Moderation,
  Text,
  CustomLabel,
  Scene,
];
const TYPE_REKOGNITION = [
  ...TYPE_REKOGNITION_IMAGE,
  Person,
  Segment,
];
const TYPE_TRANSCRIBE = [
  Transcribe,
];
const TYPE_COMPREHEND = [
  ...TYPE_TRANSCRIBE,
  Keyphrase,
  Entity,
  Sentiment,
  CustomEntity,
];
const TYPE_TEXTRACT = [
  Textract,
];
const PROJECT_VERSIONS_INVALID_STATUS = [
  'TRAINING_FAILED',
  'FAILED',
  'DELETING',
];
const DISABLE_ANALYSIS = {
  enabled: false,
};
const {
  Statuses: {
    Processing,
    AnalysisStarted,
  },
} = StateData;

const REGION = process.env.AWS_REGION;
const FIELDS_TO_FETCH = [
  'type',
  'key',
  'aiOptions',
  'proxies',
  'framerate',
  'duration',
  'docinfo',
  'frameExtraction',
  'timeCodeFirstFrame',
  'copyFromSource',
  'diarisation',
  'audioenhancement',
  'audiotagging',
  'loudness',
  'transcribe',
];

class StatePrepareAnalysis {
  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new AnalysisError('stateData not StateData object');
    }

    // remove some necessary fields
    const { data } = stateData;
    if (data !== undefined) {
      for (const key of ['restore', 'mediainfo', 'startTime', 'endTime', 'indexer']) {
        delete data[key];
      }
    }

    this.$stateData = stateData;
    this.$timestamp = ((this.stateData.input || {}).request || {}).timestamp
      || (new Date()).getTime();
  }

  get [Symbol.toStringTag]() {
    return 'StatePrepareAnalysis';
  }

  get stateData() {
    return this.$stateData;
  }

  get timestamp() {
    return this.$timestamp;
  }

  async process() {
    const {
      accountId,
      uuid,
      input,
      event: {
        executionArn,
      },
    } = this.stateData;

    // check analysis options
    const db = new DB({
      Table: IngestTable,
      PartitionKey: IngestPartitionKey,
    });
    const fetched = await db.fetch(uuid, undefined, FIELDS_TO_FETCH);

    let aiOptions = {
      ...fetched.aiOptions,
      ...input.aiOptions,
    }
    aiOptions = await this.parseAIOptions(aiOptions);

    const [
      video,
      audio,
      image,
      document,
    ] = await Promise.all([
      this.prepareVideoAnalysis(fetched, aiOptions),
      this.prepareAudioAnalysis(fetched, aiOptions),
      this.prepareImageAnalysis(fetched, aiOptions),
      this.prepareDocumentAnalysis(fetched, aiOptions),
    ]);

    // set destination
    const destination = {
      bucket: ProxyBucket,
      prefix: makeSafeOutputPrefix(uuid, fetched.key),
      ...input.destination,
    };

    // set dynamodb table
    const overallStatus = Processing;
    const status = AnalysisStarted;

    const fieldsToUpdate = {
      overallStatus,
      status,
      executionArn,
      aiOptions,
    };
    await db.update(uuid, undefined, fieldsToUpdate, false);

    const {
      framerate,
      duration,
      frameExtraction,
      timeCodeFirstFrame,
      copyFromSource,
      diarisation,
      audioenhancement,
      audiotagging,
      loudness,
      transcribe,
    } = fetched;

    // prepare iterators
    const iterators = [];

    const inputData = {
      aiOptions,
      destination,
      duration,
      framerate,
      video: {
        ...video,
        frameExtraction,
        timeCodeFirstFrame,
        copyFromSource,
      },
      audio: {
        ...audio,
        diarisation,
        audioenhancement,
        audiotagging,
        loudness,
        transcribe,
      },
      image,
      document,
      request: {
        timestamp: this.timestamp,
      },
      metrics: {
        duration: fetched.duration || 0,
        requestTime: this.timestamp,
        startTime: (new Date()).getTime(),
      },
    };

    const stateMachineArn = [
      'arn:aws:states',
      REGION,
      accountId,
      'stateMachine',
    ].join(':');

    for (const iterator of [video, audio, image, document]) {
      const {
        stateMachineName,
      } = iterator;

      if (!stateMachineName) {
        continue;
      }

      iterators.push({
        analysisStateMachineArn: `${stateMachineArn}:${stateMachineName}`,
        uuid,
        input: inputData,
        data: this.stateData.data || {},
      });
    }

    this.stateData.data = {
      ...this.stateData.data,
      iterators,
    };

    this.stateData.input = inputData;
    this.stateData.setCompleted(status);
    return this.stateData.toJSON();
  }

  async getDefaultAIOptions() {
    // global options from stored by webapp (admin)
    const bucket = ProxyBucket;
    const key = AI_OPTIONS_S3KEY;
    const globalOptions = await download(bucket, key)
      .then((x) =>
        JSON.parse(x))
      .catch(() =>
        undefined);

    if (globalOptions !== undefined) {
      return globalOptions;
    }

    // environment options during stack creation
    return aimlGetPresets(DEFAULT_AI_OPTIONS);
  }

  async parseAIOptions(requested) {
    const aiOptions = requested || {};
    const defaultAIOptions = await this.getDefaultAIOptions();

    for (const [key, value] of Object.entries(defaultAIOptions)) {
      if (aiOptions[key] === undefined) {
        aiOptions[key] = value;
      }
    }

    return this.mergeServiceOptions(aiOptions);
  }

  async mergeServiceOptions(options) {
    /* checking service availability to enable/disable aiml option */
    const [
      rekognition,
      comprehend,
      transcribe,
      textract,
    ] = await Promise.all([
      'rekognition',
      'comprehend',
      'transcribe',
      'textract',
    ].map((x) =>
      this.checkService(x)));

    let disabled = [];

    if (!rekognition) {
      disabled = disabled.concat(TYPE_REKOGNITION);
    } else if (!options[AutoFaceIndexer]) {
      // if autofaceindexer is enabled, we don't care if there are faces in the collection or not.
      const hasFaces = await this.checkFacesInCollection(options.faceCollectionId);
      if (!hasFaces) {
        disabled.push(FaceMatch);
      }
    }

    if (!transcribe) {
      disabled = disabled.concat(TYPE_TRANSCRIBE);
    }
    if (!comprehend || !transcribe) {
      disabled = disabled.concat(TYPE_COMPREHEND);
    }
    if (!textract) {
      disabled = disabled.concat(TYPE_TEXTRACT);
    }
    let aiOptions = options;
    disabled = Array.from(new Set(disabled));
    disabled.forEach(x => aiOptions[x] = false);
    // check framebased/frameCaptureMode settings
    aiOptions = this.checkFrameBasedAnalysis(aiOptions);
    // check rekognition/transcribe/comprehend custom settings
    if (rekognition) {
      aiOptions = await this.checkRekognitionCustomLabels(aiOptions);
    }
    if (transcribe) {
      aiOptions = await this.checkTranscribeCustomSettings(aiOptions);
    }
    if (comprehend) {
      aiOptions = await this.checkComprehendCustomSettings(aiOptions);
    }
    return aiOptions;
  }

  async checkService(service) {
    const supported = await ServiceAvailability.probe(service)
      .catch(() =>
        false);

    if (!supported) {
      console.log(`checkService: '${service}' not available in '${process.env.AWS_REGION}' region`);
    }
    return supported;
  }

  async checkFacesInCollection(collectionId) {
    if (!collectionId) {
      return false;
    }

    const rekognitionClient = xraysdkHelper(new RekognitionClient({
      customUserAgent: CustomUserAgent,
      retryStrategy: retryStrategyHelper(),
    }));

    const command = new ListFacesCommand({
      CollectionId: collectionId,
      MaxResults: 2,
    });
    return rekognitionClient.send(command)
      .then((res) =>
        (res.Faces || []).length > 0)
      .catch(() =>
        false);
  }

  async checkRekognitionCustomLabels(options) {
    /* make sure customlabel and customLabelModels are set */
    if (!options[CustomLabel] || !options.customLabelModels) {
      return options;
    }
    /* make sure frameCaptureMode was enabled */
    if (Object.values(FrameCaptureMode).indexOf(options.frameCaptureMode) < 0
    || options.frameCaptureMode === FrameCaptureMode.MODE_NONE) {
      options[CustomLabel] = false;
      options.customLabelModels = undefined;
      return options;
    }
    const projectArns = (await Promise.all([].concat(options.customLabelModels)
      .map((x) =>
        this.getRunnableProjectVersion(x))))
      .filter((x) =>
        x);
    options.customLabelModels = (projectArns.length > 0)
      ? projectArns
      : undefined;
    return options;
  }

  async getRunnableProjectVersion(model) {
    const projectArn = [
      'arn:aws:rekognition',
      process.env.AWS_REGION,
      this.stateData.accountId,
      `project/${model}`,
    ].join(':');

    const rekognitionClient = xraysdkHelper(new RekognitionClient({
      customUserAgent: CustomUserAgent,
      retryStrategy: retryStrategyHelper(),
    }));

    /* make sure there are runnable project versions */
    const command = new DescribeProjectVersionsCommand({
      ProjectArn: projectArn,
      MaxResults: 100,
    });

    return rekognitionClient.send(command)
      .then((res) => {
        const modelCanUse = res.ProjectVersionDescriptions
          .find((x0) =>
            PROJECT_VERSIONS_INVALID_STATUS.includes(x0.Status) !== true);
        if (modelCanUse !== undefined) {
          return model;
        }
        return undefined;
      })
      .catch(() =>
        undefined);
  }

  async checkTranscribeCustomSettings(options) {
    return this.checkCustomVocabulary(await this.checkCustomLanguageModel(options));
  }

  async checkCustomLanguageModel(options) {
    if (!options.customLanguageModel) {
      return options;
    }

    const transcribeClient = xraysdkHelper(new TranscribeClient({
      customUserAgent: CustomUserAgent,
      retryStrategy: retryStrategyHelper(),
    }));

    const command = new DescribeLanguageModelCommand({
      ModelName: options.customLanguageModel,
    });

    const response = await transcribeClient.send(command)
      .then((res) => ({
        name: res.LanguageModel.ModelName,
        languageCode: res.LanguageModel.LanguageCode,
        canUse: res.LanguageModel.ModelStatus === 'COMPLETED',
      }))
      .catch(() =>
        undefined);

    /* CLM not ready to use */
    if (!response || !response.canUse) {
      options.customLanguageModel = undefined;
      return options;
    }
    /* incompatible languageCode settings between lanaguageCode & CLM */
    /* languageCode takes priority and disable CLM */
    if (options.languageCode && options.languageCode !== response.languageCode) {
      options.customLanguageModel = undefined;
      return options;
    }
    options.languageCode = response.languageCode;
    return options;
  }

  async checkCustomVocabulary(options) {
    if (!options.customVocabulary) {
      return options;
    }

    const transcribeClient = xraysdkHelper(new TranscribeClient({
      customUserAgent: CustomUserAgent,
      retryStrategy: retryStrategyHelper(),
    }));

    const command = new GetVocabularyCommand({
      VocabularyName: options.customVocabulary,
    });

    const response = await transcribeClient.send(command)
      .then((res) => ({
        name: res.VocabularyName,
        languageCode: res.LanguageCode,
        canUse: res.VocabularyState === 'READY',
      }))
      .catch(() =>
        undefined);

    /* CV not ready to use */
    if (!response || !response.canUse) {
      options.customVocabulary = undefined;
      return options;
    }

    /* incompatible languageCode settings between lanaguageCode & CV */
    /* languageCode takes priority and disable CV */
    if (options.languageCode && options.languageCode !== response.languageCode) {
      options.customVocabulary = undefined;
      return options;
    }

    options.languageCode = response.languageCode;
    return options;
  }

  async checkComprehendCustomSettings(options) {
    return this.checkCustomEntityRecognizer(options);
  }

  async checkCustomEntityRecognizer(options) {
    if (!options[CustomEntity] || !options.customEntityRecognizer) {
      return options;
    }
    const arn = [
      'arn:aws:comprehend',
      process.env.AWS_REGION,
      this.stateData.accountId,
      `entity-recognizer/${options.customEntityRecognizer}`,
    ].join(':');

    const comprehendClient = xraysdkHelper(new ComprehendClient({
      customUserAgent: CustomUserAgent,
      retryStrategy: retryStrategyHelper(),
    }));

    const command = new DescribeEntityRecognizerCommand({
      EntityRecognizerArn: arn,
    });

    const response = await comprehendClient.send(command)
      .then((res) => ({
        arn: res.EntityRecognizerProperties.EntityRecognizerArn,
        languageCode: res.EntityRecognizerProperties.LanguageCode,
        canUse: res.EntityRecognizerProperties.Status === 'TRAINED'
          || res.EntityRecognizerProperties.Status === 'STOPPED',
      }))
      .catch(() =>
        undefined);

    /* CER not ready to use */
    if (!response || !response.canUse) {
      options[CustomEntity] = false;
      options.customEntityRecognizer = undefined;
      return options;
    }

    /* incompatible languageCode settings between lanaguageCode & CER */
    /* languageCode takes priority and disable CER */
    if (options.languageCode
      && options.languageCode.split('-')[0] !== response.languageCode) {
      options[CustomEntity] = false;
      options.customEntityRecognizer = undefined;
      return options;
    }

    return options;
  }

  async prepareVideoAnalysis(asset, options) {
    /* no video analysis options are enabled */
    if (!_hasAnalysis(options, TYPE_REKOGNITION)) {
      return DISABLE_ANALYSIS;
    }

    const video = (asset.proxies || [])
      .filter((x) =>
        x.type === 'video')
      .shift();

    if (!video || !video.key) {
      return DISABLE_ANALYSIS;
    }

    /* make sure video file exists */
    const keyExist = await headObject(
      ProxyBucket,
      video.key
    ).then(() =>
      true)
      .catch(() =>
        false);

    if (!keyExist) {
      return DISABLE_ANALYSIS;
    }

    return {
      enabled: true,
      key: video.key,
      stateMachineName: VideoAnalysis,
    };
  }

  async prepareAudioAnalysis(asset, options) {
    /* no audio analysis options are enabled */
    const fields = [
      ...TYPE_TRANSCRIBE,
      ...TYPE_COMPREHEND,
    ];
    if (!_hasAnalysis(options, fields)) {
      return DISABLE_ANALYSIS;
    }

    const audio = (asset.proxies || [])
      .filter((x) =>
        x.type === 'audio')
      .shift();

    if (!audio || !audio.key) {
      return DISABLE_ANALYSIS;
    }

    /* make sure audio file exists */
    const keyExist = await headObject(
      ProxyBucket,
      audio.key
    ).then(() =>
      true)
      .catch(() =>
        false);

    if (!keyExist) {
      return DISABLE_ANALYSIS;
    }

    return {
      enabled: true,
      key: audio.key,
      stateMachineName: AudioAnalysis,
    };
  }

  async prepareImageAnalysis(asset, options) {
    if (asset.type !== 'image' || !_hasAnalysis(options, TYPE_REKOGNITION_IMAGE)) {
      return DISABLE_ANALYSIS;
    }

    const proxy = (asset.proxies || [])
      .reduce((acc, cur) =>
        ((acc && acc.fileSize >= cur.fileSize) ? acc : cur), undefined);

    if (!proxy || !proxy.key) {
      return DISABLE_ANALYSIS;
    }

    /* make sure image file exists */
    const keyExist = await headObject(
      ProxyBucket,
      proxy.key
    ).then(() =>
      true)
      .catch(() =>
        false);

    if (!keyExist) {
      return DISABLE_ANALYSIS;
    }

    return {
      enabled: true,
      key: proxy.key,
      stateMachineName: ImageAnalysis,
    };
  }

  async prepareDocumentAnalysis(asset, options) {
    /* no document analysis options are enabled */
    if (asset.type !== 'document' || !_hasAnalysis(options, TYPE_TEXTRACT)) {
      return DISABLE_ANALYSIS;
    }

    return {
      enabled: true,
      prefix: parse(asset.proxies[0].key).dir,
      numPages: asset.docinfo.numPages,
      stateMachineName: DocumentAnalysis,
    };
  }

  checkFrameBasedAnalysis(options) {
    if (options.framebased === true
    && options.frameCaptureMode === FrameCaptureMode.MODE_NONE) {
      options.framebased = false;
    }
    return options;
  }
}

function _hasAnalysis(options, fields = []) {
  for (const field of fields) {
    const value = options[field];
    if (value !== undefined && value !== false) {
      return true;
    }
  }

  return false;
}

module.exports = StatePrepareAnalysis;
