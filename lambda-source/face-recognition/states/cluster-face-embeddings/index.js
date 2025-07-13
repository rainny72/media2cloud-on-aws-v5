// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
} = require('node:path');
const {
  randomBytes,
} = require('node:crypto');
const {
  RekognitionClient,
  SearchFacesByImageCommand,
} = require('@aws-sdk/client-rekognition');
const {
  Environment: {
    Solution: { Metrics: { CustomUserAgent } },
  },
  StateData: {
    Statuses: { Completed },
  },
  CommonUtils: {
    download,
    uploadFile,
    debugLocally,
    freeHeapMemory,
  },
  AnalysisTypes: {
    AutoFaceIndexer,
  },
  SimpleMath: {
    cosdist,
    // normalize,
  },
  JimpHelper: {
    MIME_JPEG,
    imageFromS3,
    imageFromScratch,
    cropFace,
  },
  FaceIndexer,
  xraysdkHelper,
  retryStrategyHelper,
  Tsne,
} = require('core-lib');
const BaseState = require('../shared/base');

const {
  createExternalImageId,
} = FaceIndexer;

const JSON_FACEGROUP = 'facegroup.json';
const MAXFACESPERINDEX = 100;
const HEADSHOTDIMENSION = [144, 192];
const STOREDDIMENSION = [640, 480];
const PREFIX_FULLIMAGE = 'fullimage';
const TSNE_ITERATIONS = 500;
const MIN_PITCH = 26;
const MIN_ROLL = 26;
const MIN_YAW = 26;

let _rekognitionClient;


class StateClusterFaceEmbeddings extends BaseState {
  constructor(event, context) {
    super(event, context);
    this.$faceIndexer = new FaceIndexer();
  }

  static opSupported(op) {
    return op === 'StateClusterFaceEmbeddings';
  }

  get faceIndexer() {
    return this.$faceIndexer;
  }

  get data() {
    return this.stateData.data;
  }

  get facerecognition() {
    return this.data.facerecognition;
  }

  get uuid() {
    return this.stateData.uuid;
  }

  async process() {
    try {
      const facerecognition = this.facerecognition;

      const output = await this.downloadOutputs();
      const {
        celebrityApiCount, faceGridImages,
        startTime, endTime,
      } = output;

      facerecognition.celebrityApiCount = celebrityApiCount;
      facerecognition.faceGridImages = faceGridImages;
      facerecognition.startTime = startTime;
      facerecognition.endTime = endTime;

      const {
        aiOptions: { facematch, faceCollectionId, autofaceindexer },
      } = facerecognition;

      // nothing to do
      let searchFaceApiCount = 0;
      let indexFaceApiCount = 0;

      if (!(facematch || faceCollectionId)) {
        facerecognition.searchFaceApiCount = searchFaceApiCount;
        facerecognition.indexFaceApiCount = indexFaceApiCount;
        return this.setCompleted();
      }

      const { celebrityFaceMap } = output;

      let apiCount = await this.matchCelebrityFaces(celebrityFaceMap);
      searchFaceApiCount += apiCount;

      if (autofaceindexer) {
        apiCount = await this.indexCelebrityFaces(celebrityFaceMap);
        indexFaceApiCount += apiCount;
      }

      // Now, process unrecognized faces
      const { unrecognizedFaceMap } = output;

      apiCount = await this.matchUnrecognizedFaces(unrecognizedFaceMap);
      searchFaceApiCount += apiCount;

      if (autofaceindexer) {
        apiCount = await this.indexUnrecognizedFaces(unrecognizedFaceMap);
        indexFaceApiCount += apiCount;
      }
      facerecognition.searchFaceApiCount = searchFaceApiCount;
      facerecognition.indexFaceApiCount = indexFaceApiCount;


      const data = this.rebuildFaceOutput(output);

      data.usage = {
        indexFaceApiCount,
        celebrityApiCount,
        searchFaceApiCount,
      };
      data.faceGridImages = faceGridImages;

      const {
        bucket, frameExtraction: { framePrefix },
      } = facerecognition;

      const name = JSON_FACEGROUP;
      await uploadFile(bucket, framePrefix, name, data);

      facerecognition.framePrefix = framePrefix;
      facerecognition.output = name;

      return this.setCompleted();
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  setCompleted() {
    this.stateData.status = Completed;
    delete this.data.iterators;
    return this.stateData;
  }

  async downloadOutputs() {
    const { iterators } = this.data;
    const { bucket } = this.facerecognition;

    let startTime = Number.MAX_SAFE_INTEGER;
    let endTime = Number.MIN_SAFE_INTEGER;

    let promises = [];
    for (const iterator of iterators) {
      const {
        prefix, faceGroupOutput, startTime: t0, endTime: t1,
      } = iterator;

      if (!faceGroupOutput) {
        continue;
      }

      startTime = Math.min(startTime, t0);
      endTime = Math.max(endTime, t1);

      promises.push(download(bucket, join(prefix, faceGroupOutput))
        .then((res) => JSON.parse(res)));
    }
    promises = await Promise.all(promises);

    let totalCelebApiCount = 0;
    let totalFaceGridImages = [];

    const celebrityFaceMap = {};
    const unrecognizedFaceMap = {};
    const misclassifiedFaces = [];

    for (const promise of promises) {
      const { celebApiCount, faceGridImages, faceGroups } = promise;
      if (typeof celebApiCount === 'number') {
        totalCelebApiCount += celebApiCount;
      }
      if (faceGridImages) {
        totalFaceGridImages = totalFaceGridImages.concat(faceGridImages);
      }

      for (const faceGroup of faceGroups) {
        for (const face of faceGroup) {
          const { celebrityFace, unrecognizedFace, misclassified } = face;
          if (misclassified === true) {
            misclassifiedFaces.push(face);
            continue;
          }

          if (unrecognizedFace !== undefined) {
            const { temporaryId } = face;
            if (unrecognizedFaceMap[temporaryId] === undefined) {
              unrecognizedFaceMap[temporaryId] = [];
            }
            unrecognizedFaceMap[temporaryId].push(face);
            continue;
          }

          if (celebrityFace !== undefined) {
            const { name } = celebrityFace;
            if (celebrityFaceMap[name] === undefined) {
              celebrityFaceMap[name] = [];
            }
            celebrityFaceMap[name].push(face);
            continue;
          }

          throw new Error('SHOULD NOT BE HERE!');
        }
      }
    }

    for (const k of Object.keys(celebrityFaceMap)) {
      celebrityFaceMap[k].sort((a, b) => a.timestampMillis - b.timestampMillis);
    }

    for (const k of Object.keys(unrecognizedFaceMap)) {
      unrecognizedFaceMap[k].sort((a, b) => a.timestampMillis - b.timestampMillis);
    }

    return {
      celebrityApiCount: totalCelebApiCount,
      faceGridImages: totalFaceGridImages,
      celebrityFaceMap,
      unrecognizedFaceMap,
      misclassifiedFaces,
      startTime, endTime,
    };
  }

  async matchCelebrityFaces(celebrityFaceMap) {
    let searchFaceApi = 0;

    const {
      bucket,
      minConfidence,
      frameExtraction: { framePrefix },
      aiOptions: { faceCollectionId: collectionId },
    } = this.facerecognition;

    const inCollection = [];

    for (const [name, faces] of Object.entries(celebrityFaceMap)) {
      const face = _findBestFace(faces, true);
      if (face === undefined) {
        continue;
      }

      const image = await imageFromS3(bucket, join(framePrefix, face.name));
      const cropped = cropFace(image, face.box);

      const response = await _searchFace(cropped, collectionId, minConfidence);
      searchFaceApi += 1;

      if (response === undefined) {
        continue;
      }

      const matched = (response.FaceMatches || [])[0];
      if (matched === undefined) {
        continue;
      }

      const { Face: { FaceId: faceId } } = matched;
      inCollection.push({ faceId, name });
    }

    const faceIds = inCollection.map((x) => x.faceId);
    await this.faceIndexer.batchGet(faceIds);

    for (const { name, faceId } of inCollection) {
      if (celebrityFaceMap[name] === undefined) {
        continue;
      }

      const matched = this.faceIndexer.lookup(faceId);
      if (matched === undefined) {
        continue;
      }

      for (const face of celebrityFaceMap[name]) {
        face.facematch = { ...matched };
      }
    }

    freeHeapMemory();
    return searchFaceApi;
  }

  async indexCelebrityFaces(celebrityFaceMap) {
    let indexFaceApi = 0;

    // look for celebrity that are not in collection
    let qualified = [];

    for (const faces of Object.values(celebrityFaceMap)) {
      if (faces[0].facematch !== undefined) {
        continue;
      }
      const face = _findBestFace(faces);
      if (face === undefined) {
        continue;
      }
      qualified.push(face);
    }

    // filter faces that have low quality
    qualified = await this.filterQualified(qualified);
    if (qualified.length === 0) {
      return indexFaceApi;
    }

    const uuid = this.uuid;
    const {
      aiOptions: { faceCollectionId: collectionId },
    } = this.facerecognition;

    const externalImageId = createExternalImageId(uuid, 0);
    while (qualified.length) {
      const facesPerIndex = qualified.splice(0, MAXFACESPERINDEX);

      let gridImage = await this.createGridImage(facesPerIndex);
      const dimGrid = [gridImage.bitmap.width, gridImage.bitmap.height];

      gridImage = await gridImage.getBufferAsync(MIME_JPEG);
      const response = await this.faceIndexer.indexFaces(collectionId, externalImageId, gridImage, MAXFACESPERINDEX);

      if (response === undefined) {
        continue;
      }
      indexFaceApi += 1;

      await this.tagFaceRecordToFace(facesPerIndex, response, dimGrid);

      for (const face of facesPerIndex) {
        const registered = await this.registerFace(uuid, collectionId, face);
        face.facematch = registered;
        // clean up temporarily data
        delete face.tempData;

        // update the group
        const { celebrityFace: { name } } = face;
        if (celebrityFaceMap[name]) {
          for (const item of celebrityFaceMap[name]) {
            item.facematch = registered;
          }
        }
      }
      freeHeapMemory();
    }

    return indexFaceApi;
  }

  async matchUnrecognizedFaces(unrecognizedFaceMap) {
    let searchFaceApi = 0;

    const {
      bucket,
      minConfidence,
      frameExtraction: { framePrefix },
      aiOptions: { faceCollectionId: collectionId },
    } = this.facerecognition;

    const inCollection = [];

    for (const [name, faces] of Object.entries(unrecognizedFaceMap)) {
      const face = _findBestFace(faces, true);
      if (face === undefined) {
        continue;
      }

      const image = await imageFromS3(bucket, join(framePrefix, face.name));
      const cropped = cropFace(image, face.box);

      const response = await _searchFace(cropped, collectionId, minConfidence);
      searchFaceApi += 1;

      if (response === undefined) {
        continue;
      }

      const matched = (response.FaceMatches || [])[0];
      if (matched === undefined) {
        continue;
      }

      const { Face: { FaceId: faceId } } = matched;
      inCollection.push({ faceId, name });
    }

    const faceIds = inCollection.map((x) => x.faceId);
    await this.faceIndexer.batchGet(faceIds);

    for (const { name, faceId } of inCollection) {
      if (unrecognizedFaceMap[name] === undefined) {
        continue;
      }

      const matched = this.faceIndexer.lookup(faceId);
      if (matched === undefined) {
        continue;
      }

      for (const face of unrecognizedFaceMap[name]) {
        face.facematch = { ...matched };
      }
    }

    freeHeapMemory();
    return searchFaceApi;
  }

  async indexUnrecognizedFaces(unrecognizedFaceMap) {
    let indexFaceApi = 0;

    // look for faces that are not in collection
    let qualified = [];

    for (const faces of Object.values(unrecognizedFaceMap)) {
      if (faces[0].facematch !== undefined) {
        continue;
      }
      const face = _findBestFace(faces);
      if (face === undefined) {
        continue;
      }
      qualified.push(face);
    }

    // filter faces that have low quality
    qualified = await this.filterQualified(qualified);
    if (qualified.length === 0) {
      return indexFaceApi;
    }

    const uuid = this.uuid;
    const {
      aiOptions: { faceCollectionId: collectionId },
    } = this.facerecognition;

    const externalImageId = createExternalImageId(uuid, 0);
    while (qualified.length) {
      const facesPerIndex = qualified.splice(0, MAXFACESPERINDEX);

      let gridImage = await this.createGridImage(facesPerIndex);
      const dimGrid = [gridImage.bitmap.width, gridImage.bitmap.height];

      gridImage = await gridImage.getBufferAsync(MIME_JPEG);
      const response = await this.faceIndexer.indexFaces(collectionId, externalImageId, gridImage, MAXFACESPERINDEX);
      if (response === undefined) {
        continue;
      }
      indexFaceApi += 1;

      await this.tagFaceRecordToFace(facesPerIndex, response, dimGrid);

      for (const face of facesPerIndex) {
        const registered = await this.registerFace(uuid, collectionId, face);
        face.facematch = registered;
        // clean up temporarily data
        delete face.tempData;

        // update the group
        const { temporaryId } = face;
        if (unrecognizedFaceMap[temporaryId]) {
          for (const item of unrecognizedFaceMap[temporaryId]) {
            item.facematch = registered;
          }
        }
      }
      freeHeapMemory();
    }

    return indexFaceApi;
  }

  rebuildFaceOutput(output) {
    const {
      celebrityFaceMap, unrecognizedFaceMap, misclassifiedFaces,
    } = output;

    const centroids = [];
    const recognizedFaces = [];
    const unrecognizedFaces = [];

    for (const faces of Object.values(celebrityFaceMap)) {
      for (const face of faces) {
        recognizedFaces.push(face);
        if (face.isCentroid) {
          centroids.push(face);
        }
      }
    }

    for (const faces of Object.values(unrecognizedFaceMap)) {
      for (const face of faces) {
        if (face.facematch) {
          recognizedFaces.push(face);
        } else {
          unrecognizedFaces.push(face);
        }
        if (face.isCentroid) {
          centroids.push(face);
        }
      }
    }

    recognizedFaces.sort((a, b) =>
      a.timestampMillis - b.timestampMillis);

    unrecognizedFaces.sort((a, b) =>
      a.timestampMillis - b.timestampMillis);

    // t-SNE
    _tagTSNECoord(centroids);

    return { recognizedFaces, unrecognizedFaces, misclassifiedFaces };
  }

  async matchFace(face) {
    const {
      bucket,
      minConfidence,
      frameExtraction: { framePrefix },
      aiOptions: { faceCollectionId: collectionId },
    } = this.facerecognition;

    const { name, box } = face;

    let image = await imageFromS3(bucket, join(framePrefix, name));
    image = cropFace(image, box);

    return await _searchFace(image, collectionId, minConfidence);
  }

  async registerFace(uuid, collectionId, face) {
    const { tempData: { cropped, scaled, faceRecord } } = face;

    if (faceRecord === undefined) {
      return undefined;
    }

    const {
      Face: {
        FaceId: faceId, UserId: userId, Confidence: confidence, ExternalImageId: externalImageId,
      },
      FaceDetail: faceDetail = {},
    } = faceRecord;

    const { box: { l, t, w, h } } = face;
    const coord = `${l.toFixed(4)},${t.toFixed(4)},${w.toFixed(4)},${h.toFixed(4)}`;

    const fields = {
      uuid,
      collectionId,
      externalImageId,
      userId,
      coord,
      confidence: Math.round(confidence),
      key: undefined,
      fullImageKey: undefined,
    };

    if ((face.celebrityFace || {}).name && face.celebrityFace.confidence > 98.0) {
      fields.celeb = face.celebrityFace.name;
    }

    // optional fields
    const { Gender: gender = {}, AgeRange: ageRange = {} } = faceDetail;
    if (gender.Confidence !== undefined && gender.Confidence >= 90.0) {
      fields.gender = gender.Value;
    }
    if (ageRange.Low !== undefined && ageRange.High !== undefined) {
      fields.ageRange = [ageRange.Low, ageRange.High].join(',');
    }

    let promises = [];
    const { bucket } = this.facerecognition;

    // store thumbnail image
    promises.push(_storeFaceThumbnail(bucket, collectionId, faceId, cropped)
      .then((res) =>
        fields.key = res));

    // store full image
    const name = fields.celeb || faceId;
    promises.push(_storeFaceFullImage(bucket, collectionId, name, scaled)
      .then((res) =>
        fields.fullImageKey = res));

    promises = await Promise.all(promises);

    // now register to db
    return await this.faceIndexer.registerFace(faceId, fields);
  }

  async createGridImage(facesPerIndex) {
    const { bucket, frameExtraction: { framePrefix } } = this.facerecognition;

    const dimHeadshot = HEADSHOTDIMENSION;
    const [nRow, nCol] = _getGridLayout(facesPerIndex.length);
    // create the base image
    const dimGrid = [nCol * dimHeadshot[0], nRow * dimHeadshot[1]];
    let gridImage = await imageFromScratch(dimGrid[0], dimGrid[1]);

    const duped = facesPerIndex.slice();

    for (let row = 0; row < nRow; row += 1) {
      for (let col = 0; col < nCol; col += 1) {
        const face = duped.shift();
        if (face === undefined) {
          break;
        }

        const { scaled, cropped } = await _prepareImageVariants(bucket, framePrefix, face);

        const l = col * dimHeadshot[0];
        const t = row * dimHeadshot[1];
        const [w, h] = dimHeadshot;
        gridImage.blit(cropped, l, t);

        const relativeCoord = { l, t, w, h };
        face.tempData = { relativeCoord, scaled, cropped };
      }
    }

    if (debugLocally()) {
      const randomId = randomBytes(4).toString('hex');
      await gridImage.writeAsync(join('_faceindexer', `grid_${randomId}.jpg`));
    }

    return gridImage;
  }

  async filterQualified(faces = []) {
    const qualified = [];

    if (faces.length === 0) {
      return qualified;
    }

    const {
      bucket,
      frameExtraction: { framePrefix },
      filterSettings,
    } = this.facerecognition;

    const image = await imageFromS3(bucket, join(framePrefix, faces[0].name));
    const imgW = image.bitmap.width;
    const imgH = image.bitmap.height;

    const {
      minFaceW = 64,
      minFaceH = 64,
      maxPitch = 0,
      maxRoll = 0,
      maxYaw = 0,
      minBrightness = 0,
      minSharpness = 0,
      minCelebConfidence = 100,
    } = filterSettings || {};

    for (const face of faces) {
      const { box: { w, h }, celebrityFace, unrecognizedFace } = face;
      const faceW = w * imgW;
      const faceH = h * imgH;

      if (faceW < minFaceW || faceH < minFaceH) {
        continue;
      }

      const data = celebrityFace || unrecognizedFace;
      if (data) {
        const { confidence, faceDetails } = data;
        if (confidence > minCelebConfidence) {
          continue;
        }

        // awkward pose?
        const { pitch = 0, roll = 0, yaw = 0 } = faceDetails;
        if (pitch > 0 && maxPitch > 0 && Math.abs(pitch) > maxPitch) {
          continue;
        }
        if (roll > 0 && maxRoll > 0 && Math.abs(roll) > maxRoll) {
          continue;
        }
        if (yaw > 0 && maxYaw > 0 && Math.abs(yaw) > maxYaw) {
          continue;
        }

        // poor image quality
        const { brightness = 0, sharpness = 0 } = faceDetails;
        if (brightness > 0 && minBrightness > 0 && brightness < minBrightness) {
          continue;
        }
        if (sharpness > 0 && minSharpness > 0 && sharpness < minSharpness) {
          continue;
        }
      }

      qualified.push(face);
    }

    return qualified;
  }

  async tagFaceRecordToFace(faces, results, dimension) {
    const [imgW, imgH] = dimension;

    const nFaceRecords = results.FaceRecords.length;
    const nFaces = faces.length;

    if (nFaceRecords !== nFaces) {
      console.log(`Mismatch of Face Indexing: ${nFaceRecords} / ${nFaces}`);
    }

    const faceIdsToBeRemoved = [];

    for (const faceRecord of results.FaceRecords) {
      const {
        Face: {
          FaceId: faceId,
          BoundingBox: { Left, Top, Width, Height },
        },
      } = faceRecord;

      const coord = {
        l: (Left * imgW), t: (Top * imgH), w: (Width * imgW), h: (Height * imgH),
      };

      const matched = _findFaceInGrid(faces, coord);
      if (!matched) {
        console.log(`Cannot find face in the index grid image: ${faceId}...`);
        faceIdsToBeRemoved.push(faceId);
        continue;
      }
      // store the faceRecord temporarily
      matched.tempData.faceRecord = faceRecord;
    }

    // Now, check the Unindexed
    for (const faceRecord of results.UnindexedFaces) {
      const {
        FaceDetail: { BoundingBox: { Left, Top, Width, Height } },
        Reasons,
      } = faceRecord;
      const coord = {
        l: (Left * imgW), t: (Top * imgH), w: (Width * imgW), h: (Height * imgH),
      };

      const matched = _findFaceInGrid(faces, coord);
      if (!matched) {
        const errorMessage = `Fail to index ${matched.name}. Reasons: ${Reasons.join(',')}`;
        console.log(errorMessage);
        matched.tempData.errorMessage = errorMessage;
      }
    }

    // remove FaceIds that we can't find in the grid image...
    if (faceIdsToBeRemoved.length > 0) {
      const {
        aiOptions: { faceCollectionId: collectionId },
      } = this.facerecognition;
      await this.faceIndexer.deleteFaces(collectionId, faceIdsToBeRemoved);
    }

    return results;
  }

}

function _getRekognitionClient() {
  if (_rekognitionClient === undefined) {
    _rekognitionClient = xraysdkHelper(new RekognitionClient({
      customUserAgent: CustomUserAgent,
      retryStrategy: retryStrategyHelper(),
    }));
  }

  return _rekognitionClient;
}

async function _searchFace(image, collectionId, minConfidence = 80) {
  const buf = await image.clone().getBufferAsync(MIME_JPEG);

  const params = {
    CollectionId: collectionId,
    Image: { Bytes: buf },
    MaxFaces: 1,
    FaceMatchThreshold: minConfidence,
    QualityFilter: 'LOW',
  };

  const rekognitionClient = _getRekognitionClient();
  const command = new SearchFacesByImageCommand(params);
  const response = await rekognitionClient.send(command)
    .catch((e) => {
      // No face in the image
      if (e.name === 'InvalidParameterException') {
        return undefined;
      }
      console.log(e);
      throw e;
    });

  return response;
}

function _findBestFace(faces = [], skipPoseFiltering = false) {
  if (faces.length === 0) {
    return undefined;
  }

  const centroids = faces.filter((face) =>
    face.isCentroid === true);

  // filter out awkward pose
  let qualified = [];
  for (const centroid of centroids) {
    const { faceDetails } = centroid.celebrityFace || centroid.unrecognizedFace || {};
    if (!faceDetails) {
      continue;
    }
    const { pitch = 0, roll = 0, yaw = 0 } = faceDetails;
    if (Math.abs(pitch) > MIN_PITCH || Math.abs(roll) > MIN_ROLL || Math.abs(yaw) > MIN_YAW) {
      continue;
    }
    qualified.push(centroid);
  }

  // no qualified face 
  if (qualified.length === 0 && skipPoseFiltering === true) {
    qualified = centroids;
  }

  qualified.sort((a, b) => {
    const scoreA = ((a.celebrityFace || a.unrecognizedFace) || {}).confidence || 0;
    const scoreB = ((b.celebrityFace || b.unrecognizedFace) || {}).confidence || 0;
    return scoreB - scoreA;
  });

  return qualified[0];
}

async function _storeFaceThumbnail(bucket, collectionId, faceId, image) {
  let scaled = image;
  if (image.bitmap.width > 64) {
    const factor = 64 / image.bitmap.width;
    scaled = image.scale(factor);
  }
  const thumbnail = await scaled.getBufferAsync(MIME_JPEG);

  const prefix = join(AutoFaceIndexer, collectionId);
  let name = faceId.replaceAll('-', '');
  name = `${name}.jpg`;

  if (debugLocally()) {
    await scaled.writeAsync(join('_faceindexer', `${faceId} thumbnail.jpg`));
  }

  await uploadFile(bucket, prefix, name, thumbnail);

  return join(prefix, name);
}

async function _storeFaceFullImage(bucket, collectionId, celeb, image) {
  let scaled = image;
  if (image.bitmap.width > 640) {
    const factor = 640 / image.bitmap.width;
    scaled = image.scale(factor);
  }
  const fullImage = await scaled.getBufferAsync(MIME_JPEG);

  const prefix = join(AutoFaceIndexer, collectionId, PREFIX_FULLIMAGE);
  const name = `${celeb}.jpg`;

  if (debugLocally()) {
    await scaled.writeAsync(join('_faceindexer', `${celeb} fullimage.jpg`));
  }

  await uploadFile(bucket, prefix, name, fullImage);

  return join(prefix, name);
}

function _getGridLayout(size) {
  const nRow = Math.round(size ** 0.5);
  let nCol = nRow;
  if ((nRow ** 2) < size) {
    nCol += 1;
  }
  return [nRow, nCol];
}

async function _prepareImageVariants(bucket, framePrefix, face, dimHeadshot = HEADSHOTDIMENSION) {
  const { name, box } = face;

  const image = await imageFromS3(bucket, join(framePrefix, name));

  // scale down the original image
  const factor = STOREDDIMENSION[0] / image.bitmap.width;
  const scaled = image.clone().scale(factor);

  // cropped
  const cropped = cropFace(image, box, dimHeadshot);

  return { scaled, cropped };
}

function _pointInBox(coord, xy) {
  const { l, t, w, h } = coord;
  const [cx, cy] = xy;

  if (l < cx && cx < (l + w) && t < cy && cy < (t + h)) {
    return true;
  }

  return false;
}

// function _intersected(a, b) {
//   const { t: aT, l: aL, w: aW, h: aH } = a.box || a;
//   const aCx = aL + (aW / 2);
//   const aCy = aT + (aH / 2);

//   const { t: bT, l: bL, w: bW, h: bH } = b.box || b;
//   const bCx = bL + (bW / 2);
//   const bCy = bT + (bH / 2);

//   if ((aCx > bL && aCx < (bL + bW)) && (aCy > bT && aCy < (bT + bH))) {
//     return true;
//   }

//   if ((bCx > aL && bCx < (aL + aW)) && (bCy > aT && bCy < (aT + aH))) {
//     return true;
//   }

//   return false;
// }

function _findFaceInGrid(faces, coord) {
  const { l, t, w, h } = coord;
  const cx = Math.round(l + (w / 2));
  const cy = Math.round(t + (h / 2));

  for (const face of faces) {
    const { tempData: { relativeCoord } } = face;
    if (_pointInBox(relativeCoord, [cx, cy])) {
      return face;
    }
    // if (_intersected(coord, relativeCoord)) {
    //   return face;
    // }
  }

  return undefined;
}

function _tagTSNECoord(faces = []) {
  if (faces.length === 0) {
    return;
  }

  let dataset = faces.map((x) => x.embedding);
  // dataset = normalize(dataset);

  const perplexity = Math.floor(dataset.length ** 0.333);
  const tsne = new Tsne({
    epsilon: 10,
    perplexity,
    dim: 2,
    distanceFn: cosdist,
  });

  // debugger;

  tsne.initDataRaw(dataset);
  for (let i = 0; i < TSNE_ITERATIONS; i += 1) {
    tsne.step();
  }
  const Y = tsne.getSolution();

  for (let i = 0; i < faces.length; i += 1) {
    faces[i].tsne = Y[i];
  }
}

module.exports = StateClusterFaceEmbeddings;
