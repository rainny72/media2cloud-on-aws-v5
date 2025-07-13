// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  parse,
} = require('path');
const {
  AnalysisTypes: {
    Rekognition: {
      Celeb,
      FaceMatch,
    },
  },
  CommonUtils: {
    download,
  },
  M2CException,
} = require('core-lib');
const DetectCelebIterator = require('../detect-celeb');
const DetectFaceMatchIterator = require('../detect-face-match');

class DetectIdentityComboIterator {
  constructor(stateData) {
    const {
      data,
    } = stateData;

    if (!data[Celeb]) {
      throw new M2CException('celeb feature is disabled');
    }

    this.$detections.push({
      instance: new DetectCelebIterator(stateData),
      subCategory: Celeb,
    });

    if (data[FaceMatch]) {
      this.$detections.push({
        instance: new DetectFaceMatchIterator(stateData),
        subCategory: FaceMatch,
      });
    }
  }

  get [Symbol.toStringTag]() {
    return 'DetectIdentityComboIterator';
  }

  get detections() {
    return this.$detections;
  }

  get celebDetection() {
    return (this.detections
      .find((x) =>
        x.subCategory === Celeb) || {})
      .instance;
  }

  get facematchDetection() {
    return (this.detections
      .find((x) =>
        x.subCategory === FaceMatch) || {})
      .instance;
  }

  async process() {
    const instance = this.detections[0].instance;
    const {
      stateData: {
        data: {
          embeddings,
        },
      },
    } = instance;

    let response;

    if (embeddings) {
      response = await this.processWithFrameEmbeddings();
      return response;
    }

    if (instance.stateData.data.framesegmentation) {
      response = await this.processWithFrameSegmentation();
      return response;
    }

    const {
      subCategory,
    } = this.detections[0];

    const {
      stateData: {
        data: {
          [subCategory]: data,
        },
      },
    } = instance;

    const {
      bucket,
      frameCapture: {
        prefix,
        numFrames,
      },
    } = data;

    const startTime = Date.now();
    this.detections.forEach((x) => {
      const subcategory = x.instance.stateData.data[x.subCategory];
      subcategory.startTime = subcategory.startTime || startTime;
    });

    let lambdaTimeout = false;

    const t0 = new Date();
    while (!lambdaTimeout && data.cursor < numFrames) {
      await this.processFrame(
        bucket,
        prefix,
        data.cursor
      );

      this.detections.forEach((x) => {
        const subcategory = x.instance.stateData.data[x.subCategory];
        subcategory.cursor += 1;
      });

      /* make sure we allocate enough time for the next iteration */
      lambdaTimeout = this.quitNow();
    }

    await Promise.all(this.detections
      .map((x) => {
        const xInstance = x.instance;
        const outPrefix = xInstance.makeRawDataPrefix(x.subCategory);
        const dataset = xInstance.dataset;
        xInstance.mapData = xInstance.getUniqueNames(dataset);

        return xInstance.updateOutputs(
          bucket,
          outPrefix
        );
      }));

    const consumed = new Date() - t0;
    const remained = this.getRemainingTime();
    console.log(`COMPLETED: frame #${data.cursor - 1} [Consumed/Remained: ${consumed / 1000}s / ${remained / 1000}s]`);

    return (data.cursor >= numFrames)
      ? this.setCompleted()
      : this.setProgress(Math.round((data.cursor / numFrames) * 100));
  }

  getRemainingTime() {
    const instance = this.detections[0].instance;
    return instance.stateData.getRemainingTime();
  }

  quitNow() {
    const instance = this.detections[0].instance;
    return instance.stateData.quitNow();
  }

  async processFrame(
    bucket,
    prefix,
    idx
  ) {
    const faces = await this.celebDetection.processFrame(
      bucket,
      prefix,
      idx
    ).then(() => {
      const rawResponse = this.celebDetection.originalResponse;
      return this.getFaces(rawResponse);
    });

    /* no face found, skip celeb and facematch */
    if (!faces || !faces.length) {
      return undefined;
    }

    const promises = [];
    if (this.facematchDetection) {
      promises.push(this.facematchDetection.processFrame(
        bucket,
        prefix,
        idx,
        faces
      ));
    }

    return Promise.all(promises);
  }

  getFaces(response) {
    const faces = [];

    for (const unrecognizedFace of (response || {}).UnrecognizedFaces || []) {
      faces.push({
        Face: unrecognizedFace,
      });
    }

    // for (const celebrityFace of (response || {}).CelebrityFaces || []) {
    //   faces.push(celebrityFace);
    // }

    return faces;
  }

  setCompleted() {
    const endTime = Date.now();

    const stateData = this.celebDetection.setCompleted();
    stateData.data[Celeb].endTime = endTime;

    if (this.facematchDetection) {
      this.facematchDetection.setCompleted();
      stateData.data[FaceMatch] =
        this.facematchDetection.stateData.data[FaceMatch];
      stateData.data[FaceMatch].endTime = endTime;
    }

    return stateData;
  }

  setProgress(pencentage) {
    const stateData = this.celebDetection.setProgress(pencentage);

    if (this.facematchDetection) {
      this.facematchDetection.setProgress(pencentage);
      stateData.data[FaceMatch] =
        this.facematchDetection.stateData.data[FaceMatch];
    }

    return stateData;
  }

  async processWithFrameSegmentation() {
    const instance = this.detections[0].instance;
    const subCategory = this.detections[0].subCategory;
    const data = instance.stateData.data[subCategory];

    const bucket = data.bucket;
    const frameSegmentationJson = instance.stateData.data.framesegmentation.key;
    const frameSegmentation = await download(bucket, frameSegmentationJson)
      .then((res) =>
        JSON.parse(res));

    console.log(
      '=== Using processWithFrameSegmentation: numFrames:',
      frameSegmentation.length
    );

    const numFrames = frameSegmentation.length;
    const prefix = parse(frameSegmentationJson).dir;

    const startTime = Date.now();
    this.detections.forEach((x) => {
      const subcategory = x.instance.stateData.data[x.subCategory];
      subcategory.startTime = subcategory.startTime || startTime;
    });

    let lambdaTimeout = false;

    const t0 = new Date();
    while (!lambdaTimeout && data.cursor < numFrames) {
      const frame = frameSegmentation[data.cursor];
      await this.processFrame2(
        bucket,
        prefix,
        frame
      );

      this.detections.forEach((x) => {
        const subcategory = x.instance.stateData.data[x.subCategory];
        subcategory.cursor += 1;
      });

      /* make sure we allocate enough time for the next iteration */
      lambdaTimeout = this.quitNow();
    }

    await Promise.all(this.detections
      .map((x) => {
        const xInstance = x.instance;
        const outPrefix = xInstance.makeRawDataPrefix(x.subCategory);
        const dataset = xInstance.dataset;
        xInstance.mapData = xInstance.getUniqueNames(dataset);

        return xInstance.updateOutputs(
          bucket,
          outPrefix
        );
      }));

    const consumed = new Date() - t0;
    const remained = this.getRemainingTime();
    console.log(`COMPLETED: frame #${data.cursor - 1} [Consumed/Remained: ${consumed / 1000}s / ${remained / 1000}s]`);

    if (data.cursor >= numFrames) {
      return this.setCompleted();
    }

    let percentage = (data.cursor / numFrames) * 100;
    percentage = Math.round(percentage);

    return this.setProgress(percentage);
  }

  async processFrame2(
    bucket,
    prefix,
    frame
  ) {
    const faces = await this.celebDetection.processFrame2(
      bucket,
      prefix,
      frame
    ).then(() => {
      const rawResponse = this.celebDetection.originalResponse;
      return this.getFaces(rawResponse);
    });

    /* no face found, skip celeb and facematch */
    if (!faces || !faces.length) {
      return undefined;
    }

    const promises = [];
    if (this.facematchDetection) {
      promises.push(this.facematchDetection.processFrame2(
        bucket,
        prefix,
        frame,
        faces
      ));
    }

    return Promise.all(promises);
  }
}

module.exports = DetectIdentityComboIterator;
