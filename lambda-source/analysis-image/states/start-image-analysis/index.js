// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  join,
} = require('node:path');
const {
  RekognitionClient,
  RecognizeCelebritiesCommand,
  DetectFacesCommand,
  DescribeCollectionCommand,
  SearchFacesByImageCommand,
  DetectLabelsCommand,
  DetectModerationLabelsCommand,
  DetectTextCommand,
  DescribeProjectVersionsCommand,
  DetectCustomLabelsCommand,
} = require('@aws-sdk/client-rekognition');
const {
  Environment: {
    Solution: { Metrics: { CustomUserAgent } },
  },
  AnalysisTypes: {
    Rekognition: { Celeb, Face, FaceMatch, Label, Moderation, Text, CustomLabel },
  },
  StateData,
  CommonUtils: {
    download,
    uploadFile,
    toISODateTime,
  },
  JimpHelper: {
    MIME_JPEG,
    imageFromS3,
  },
  FaceIndexer,
  xraysdkHelper,
  retryStrategyHelper,
  M2CException,
  SegmentHelper: {
    loadModelConfigs,
    getPreferredModel,
  },
} = require('core-lib');

const {
  ENV_PROXY_BUCKET: ProxyBucket,
  ENV_BEDROCK_MODELLIST_LOCATION: ModelListLocation = '_settings/availablemodels.json',
} = process.env;

const OUTPUT = {
  description: {
    text: 'Specify the detail description of the photo',
    score: '0 to 100',
  },
  altText: {
    text: 'Specify the one-line ALT-TEXT',
    score: '0 to 100',
  },
  fileName: {
    text: 'photo-of-someone-doing-something',
    score: '0 to 100',
  },
  location: {
    text: 'Specify the location.',
    score: '0 to 100',
  },
  tags: [
    {
      text: 'Tag1',
      score: '0 to 100',
    },
    {
      text: 'Tag2',
      score: '0 to 100',
    },
  ],
};

const INSTRUCTIONS = `
## Task
You are a journalist responsible for reviewing photos and provide detail information of the photos.
You may optionally be provided with additional information such as known people, texts, and GPS longitude and latitude.
Your task is to write a detail description of the photo, provide a one line ATL-TEXT for SEO purpose, suggest a descriptive file name for the photo, and top 5 tags or keywords of the photo for search purpose.

## Instructions
1. Carefully examine the provided image along with the additional information if is provided:
### Image
{{image}}

2. Describe the photo in details.
3. Suggest a one-line ATL-TEXT for Search Engine Optimization purpose. 
4. Suggest a descriptive filename for the photo
5. Specify the location where the photo may be taken from. If GPS location is provided, locate the country, city, place. Otherwise, look for landmarks in the photo for clues. If unsure, respond 'None'.
6. Suggest five most relevant tags that best describes the photo.
7. Assign a confidence score from 0 to 100 to each of the result.
8. Do not contain any PII information in your response.
9. Provide your response immediately in the following JSON format without any preamble or additional information:

### Response example 1
${JSON.stringify(OUTPUT)}
`;

const MAX_W = 960;
const MAX_H = MAX_W;

const {
  Statuses: {
    Completed,
  },
} = StateData;

const ANALYSIS_TYPE = 'image';
const CATEGORY = 'rekog-image';
const MIN_CONFIDENCE = 80;
const OUTPUT_JSON = 'output.json';
const CAPTION = 'caption';

class StateStartImageAnalysis {
  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new M2CException('stateData not StateData object');
    }
    this.$stateData = stateData;
    this.$faceIndexer = new FaceIndexer();
  }

  get [Symbol.toStringTag]() {
    return 'StateStartImageAnalysis';
  }

  get stateData() {
    return this.$stateData;
  }

  get faceIndexer() {
    return this.$faceIndexer;
  }

  async process() {
    const {
      input: {
        aiOptions,
      },
    } = this.stateData;

    let results = [];

    results.push(this.startCeleb(aiOptions));
    results.push(this.startFace(aiOptions));
    results.push(this.startFaceMatch(aiOptions));
    results.push(this.startLabel(aiOptions));
    results.push(this.startModeration(aiOptions));
    results.push(this.startText(aiOptions));
    results.push(this.startCustomLabels(aiOptions));

    results = await Promise.all(results);

    results = results
      .filter((x) =>
        x)
      .reduce((acc, cur) => ({
        ...acc,
        ...cur,
      }), {});

    const caption = await this.generateCaption(results);

    results = {
      ...results,
      ...caption,
    };

    // clean up the results
    Object.keys(results)
      .forEach((key) => {
        delete results[key].response;
      });

    this.stateData.setData(ANALYSIS_TYPE, {
      status: Completed,
      [CATEGORY]: results,
    });
    this.stateData.setCompleted();
    return this.stateData.toJSON();
  }

  async startCeleb(aiOptions) {
    if (!aiOptions.celeb) {
      return undefined;
    }

    const params = this.makeParams();
    const command = new RecognizeCelebritiesCommand(params);

    return this.startFn(Celeb, command);
  }

  async startFace(aiOptions) {
    if (!aiOptions.face) {
      return undefined;
    }
    const params = {
      ...this.makeParams(),
      Attributes: [
        'ALL',
      ],
    };
    const command = new DetectFacesCommand(params);

    return this.startFn(Face, command);
  }

  async startFaceMatch(aiOptions) {
    if (!aiOptions[FaceMatch] || !aiOptions.faceCollectionId) {
      return undefined;
    }

    let command;

    const rekognitionClient = xraysdkHelper(new RekognitionClient({
      customUserAgent: CustomUserAgent,
      retryStrategy: retryStrategyHelper(),
    }));

    /* ensure face collection exists and has faces */
    command = new DescribeCollectionCommand({
      CollectionId: aiOptions.faceCollectionId,
    });

    const valid = await rekognitionClient.send(command)
      .then((res) =>
        res.FaceCount > 0)
      .catch(() =>
        false);

    if (!valid) {
      return undefined;
    }

    const params = {
      ...this.makeParams(),
      CollectionId: aiOptions.faceCollectionId,
      FaceMatchThreshold: aiOptions.minConfidence || MIN_CONFIDENCE,
    };
    command = new SearchFacesByImageCommand(params);

    return this.startFn(FaceMatch, command);
  }

  async startLabel(aiOptions) {
    if (!aiOptions.label) {
      return undefined;
    }

    const params = {
      ...this.makeParams(),
      MinConfidence: aiOptions.minConfidence || MIN_CONFIDENCE,
    };
    const command = new DetectLabelsCommand(params);

    return this.startFn(Label, command);
  }

  async startModeration(aiOptions) {
    if (!aiOptions.moderation) {
      return undefined;
    }

    const params = {
      ...this.makeParams(),
      MinConfidence: aiOptions.minConfidence || MIN_CONFIDENCE,
    };
    const command = new DetectModerationLabelsCommand(params);

    return this.startFn(Moderation, command);
  }

  async startText(aiOptions) {
    if (!aiOptions.text) {
      return undefined;
    }

    const params = this.makeParams();
    const command = new DetectTextCommand(params);

    return this.startFn(Text, command);
  }

  makeParams() {
    const bucket = this.stateData.input.destination.bucket;
    const key = this.stateData.input.image.key;
    if (!bucket || !key) {
      throw new M2CException('bucket or key is missing');
    }
    return {
      Image: {
        S3Object: {
          Bucket: bucket,
          Name: key,
        },
      },
    };
  }

  async startFn(subCategory, command, model) {
    const t0 = new Date().getTime();

    let response;
    try {
      const rekognitionClient = xraysdkHelper(new RekognitionClient({
        customUserAgent: CustomUserAgent,
        retryStrategy: retryStrategyHelper(),
      }));

      response = await rekognitionClient.send(command)
        .then((res) => ({
          ...res,
          $metadata: undefined,
        }));
    } catch (e) {
      console.error(
        'WARN:',
        'StateStartImageAnalysis.startFn:',
        `${command.constructor.name}:`,
        e.$metadata.httpStatusCode,
        e.name,
        e.message
      );

      return {
        [subCategory]: {
          errorMessage: [
            `${command.constructor.name}:`,
            e.$metadata.httpStatusCode,
            e.name,
            e.message,
          ].join(' '),
        },
      };
    }

    const bucket = this.stateData.input.destination.bucket;
    const prefix = this.makeOutputPrefix(subCategory, model);
    const output = join(prefix, OUTPUT_JSON);

    if (subCategory === FaceMatch) {
      response = await this.amendSearchFacesByImageResponse(response);
    }

    await uploadFile(bucket, prefix, OUTPUT_JSON, response);

    return {
      [subCategory]: {
        output,
        startTime: t0,
        endTime: new Date().getTime(),
        model,
        response,
      },
    };
  }

  makeOutputPrefix(subCategory, optionalPath = '') {
    const timestamp = toISODateTime((this.stateData.input.request || {}).timestamp);
    return join(
      this.stateData.input.destination.prefix,
      'raw',
      timestamp,
      CATEGORY,
      subCategory,
      optionalPath,
      '/'
    );
  }

  async startCustomLabels(aiOptions) {
    if (!aiOptions.customlabel
      || !(aiOptions.customLabelModels || []).length) {
      return undefined;
    }
    let responses = await Promise.all(aiOptions.customLabelModels
      .map((model) =>
        this.startCustomLabel(model)));
    responses = responses
      .filter((x) =>
        x);
    if (responses.length === 0) {
      return undefined;
    }
    return {
      [CustomLabel]: responses,
    };
  }

  async startCustomLabel(model) {
    const projectVersionArn = await this.checkProjectVersionStatus(model);
    if (!projectVersionArn) {
      return undefined;
    }

    const params = {
      ...this.makeParams(),
      ProjectVersionArn: projectVersionArn,
    };
    const command = new DetectCustomLabelsCommand(params);

    return this.startFn(
      CustomLabel,
      command,
      model
    ).then((res) =>
      res[CustomLabel]);
  }

  async checkProjectVersionStatus(model) {
    let projectArn = model;
    if (projectArn.indexOf('arn:aws:rekognition:') !== 0) {
      projectArn = `arn:aws:rekognition:${process.env.AWS_REGION}:${this.stateData.accountId}:project/${model}`;
    }

    let response;
    do {
      const rekognitionClient = xraysdkHelper(new RekognitionClient({
        customUserAgent: CustomUserAgent,
        retryStrategy: retryStrategyHelper(),
      }));

      const command = new DescribeProjectVersionsCommand({
        ProjectArn: projectArn,
        NextToken: (response || {}).NextToken,
      });

      try {
        response = await rekognitionClient.send(command);
      } catch (e) {
        console.error(
          'ERR:',
          'StateStartImageAnalysis.checkProjectVersionStatus:',
          'DescribeProjectVersionsCommand:',
          model,
          e.$metadata.httpStatusCode,
          e.name,
          e.message
        );
        return undefined;
      }

      const runningModel = response.ProjectVersionDescriptions
        .find((x) =>
          x.Status === 'RUNNING');

      if (runningModel !== undefined) {
        return runningModel.ProjectVersionArn;
      }
    } while ((response || {}).NextToken);

    /* cannot find any running model */
    return undefined;
  }

  async amendSearchFacesByImageResponse(response) {
    // lookup faceId <-> celeb
    const facesToGet = [];

    response.FaceMatches
      .forEach((faceMatch) => {
        const face = faceMatch.Face;
        const found = this.faceIndexer.lookup(face.FaceId);

        if (face === undefined) {
          return;
        }
        if (found === undefined) {
          facesToGet.push(face);
        } else if (found && found.celeb) {
          face.Name = found.celeb;
        }
      });

    if (facesToGet.length > 0) {
      const faceIds = facesToGet
        .map((x) =>
          x.FaceId);

      await this.faceIndexer.batchGet(faceIds)
        .then((res) => {
          // try look up again!
          if (res.length > 0) {
            facesToGet.forEach((face) => {
              const found = this.faceIndexer.lookup(face.FaceId);
              if (found && found.celeb) {
                face.Name = found.celeb;
              } else {
                // do not return external image id if it can't resolve the name!
                face.Name = FaceIndexer.resolveExternalImageId(
                  face.ExternalImageId,
                  false
                );
              }
            });
          }
          return res;
        });
    }

    return response;
  }

  async generateCaption(data) {
    const startTime = Date.now();

    await loadModelConfigs(ProxyBucket, ModelListLocation);
    const model = await getPreferredModel(['nova-pro', 'nova-lite', 'sonnet', 'haiku']);

    // download imageinfo to check if we have GPS info
    const {
      input: {
        destination: { bucket: proxyBucket, prefix: proxyPrefix },
        image: { key: imageKey },
      },
    } = this.stateData;

    let imageinfo = join(proxyPrefix, 'imageinfo', 'imageinfo.json');
    imageinfo = await download(proxyBucket, imageinfo)
      .then((res) =>
        JSON.parse(res));

    const {
      GPSLatitude: latitude, GPSLongitude: longitude,
    } = imageinfo || {};

    // only interestd in celeb, facematch, text
    let knownFaces = [];
    const {
      CelebrityFaces: celebrityFaces = [],
    } = (data[Celeb] || {}).response || {};
    celebrityFaces.forEach((face) => {
      if (face.MatchConfidence > 90) {
        knownFaces.push(face.Name);
      }
    });

    const {
      FaceMatches: faceMatches = [],
    } = (data[FaceMatch] || {}).response || {};
    faceMatches.forEach((face) => {
      if (face.Similarity > 90 && face.Face.Name) {
        knownFaces.push(face.Face.Name);
      }
    });

    knownFaces = [...new Set(knownFaces)];

    // load image
    let image = await imageFromS3(proxyBucket, imageKey)
      .then((img) => {
        const scaleW = MAX_W / img.bitmap.width;
        const scaleH = MAX_H / img.bitmap.height;
        const factor = Math.min(scaleW, scaleH);

        let downscaled = img;
        if (factor < 1.0) {
          downscaled = img.scale(factor);
        }

        return downscaled.quality(80);
      });
    image = await image.getBufferAsync(MIME_JPEG);

    const messages = [];

    const texts = INSTRUCTIONS.split(/{{image}}/);
    if (texts.length !== 2) {
      console.log(INSTRUCTIONS);
      throw new Error('Instruction missing {{image}} parameter');
    }

    // instruction before image
    messages.push({ text: texts[0] });

    // load the image
    messages.push({ image });

    let additional = '';
    if (knownFaces.length > 0) {
      additional = `${additional} These known people seem to appear in the photo: ${knownFaces.join(', ')}.`;
    }
    if (latitude && longitude) {
      additional = `${additional} The photo appears to be taken at this GPS location: longitude (${longitude}) and latitude (${latitude}).`;
    }

    // add any additional information
    if (additional.length > 0) {
      additional = `### Additional information\n${additional}`;
      messages.push({ text: additional });
    }

    // instruction after image
    messages.push({ text: texts[1] });

    const response = await model.inference(undefined, messages);

    const prefix = this.makeOutputPrefix(CAPTION);
    const output = join(prefix, OUTPUT_JSON);
    await uploadFile(proxyBucket, prefix, OUTPUT_JSON, response);

    const endTime = Date.now();
    return {
      [CAPTION]: { output, startTime, endTime },
    };
  }
}

module.exports = StateStartImageAnalysis;
