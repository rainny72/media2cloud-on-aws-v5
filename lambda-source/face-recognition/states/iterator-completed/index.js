// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  RekognitionClient,
  RecognizeCelebritiesCommand,
} = require('@aws-sdk/client-rekognition');
const {
  join,
  parse,
} = require('node:path');
const {
  agnes,
} = require('core-lib/node_modules/ml-hclust');
const {
  Environment: {
    Solution: { Metrics: { CustomUserAgent } },
  },
  CommonUtils: {
    download,
    uploadFile,
    debugLocally,
  },
  JimpHelper: {
    MIME_JPEG,
    imageFromScratch,
    imageFromS3,
    drawBorder,
    cropFace,
    drawGrid,
  },
  SimpleMath: {
    cosim,
    cosdist,
    centroid,
    // euclidean,
  },
  xraysdkHelper,
  retryStrategyHelper,
} = require('core-lib');
const BaseState = require('../shared/base');

const PREFIX_FACESINGROUPS = '_facesInGroups';
const NAME_PREFIX = 'facegroup';
const HEADSHOT_DIMENSION = [120, 160]; // [96, 128];
// https://docs.aws.amazon.com/rekognition/latest/APIReference/API_RecognizeCelebrities.html#:~:text=Amazon%20Rekognition%20can%20detect%20a%20maximum%20of%2064%20celebrities%20in%20an%20image.
const MAX_FACES_PER_GRID = 8 * 8; // 64 faces atmost

const EnableAgnesClustering = false;

class StateIteratorCompleted extends BaseState {
  static opSupported(op) {
    return op === 'StateIteratorCompleted';
  }

  get itemData() {
    return this.event.itemData;
  }

  async process() {
    try {
      const {
        itemId,
        bucket, prefix,
        faceEmbeddings,
        aiOptions = {},
        startTime, tsta,
        endTime, tend,
      } = this.itemData;

      const responseData = {
        itemId,
        bucket,
        prefix,
        faceEmbeddings,
        startTime: startTime || tsta,
        endTime: endTime || tend,
        faceGroupOutput: undefined,
        celebApiCount: 0,
      };

      const faceData = await download(bucket, join(prefix, faceEmbeddings))
        .then((res) => JSON.parse(res));

      if (((faceData || {}).frames || []).length === 0) {
        return responseData;
      }

      const faceGroups = await this.clusterFaces(bucket, prefix, faceData.frames);
      if (faceGroups.length === 0) {
        return responseData;
      }

      for (const faceGroup of faceGroups) {
        const temporaryId = faceGroup[0].temporaryId;
        await _storeGroupFace(bucket, prefix, faceGroup, temporaryId, '_clusters');
      }

      // get the best representative face from the each group
      const groupOfRepresentableFaces = [];
      for (const faceGroup of faceGroups) {
        const bestFace = _representableFaceInGroup(faceGroup);
        if (bestFace) {
          bestFace.isCentroid = true;
          groupOfRepresentableFaces.push(bestFace);
        }
      }

      const faceGridGroup = await _storeGroupOfRepresentableFaces(bucket, prefix, itemId, groupOfRepresentableFaces);

      let celebApiCount = 0;
      if (aiOptions.celeb) {
        const responses = await _runCelebrityRecognition(bucket, prefix, faceGridGroup);
        celebApiCount = responses.length;
        _tagCelebrityToFaceGroups(responses, faceGroups);
      }

      const faceGridImages = faceGridGroup.map((x) => x.relativePath);

      const data = {
        prefix,
        faceGridImages,
        faceGroups,
        celebApiCount,
      };

      const name = `${NAME_PREFIX}_${itemId}.json`;
      await uploadFile(bucket, prefix, name, data);

      responseData.faceGroupOutput = name;
      responseData.celebApiCount = celebApiCount;

      return responseData;
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  async clusterFaces(bucket, prefix, faceEmbeddings) {
    if (EnableAgnesClustering) {
      return await _clusterFacesByAgnesAlgoritm(bucket, prefix, faceEmbeddings);
    }
    return await _clusterFacesByFrameShots(bucket, prefix, faceEmbeddings);
  }
}

async function _drawBoundingBox(bucket, framePrefix, face) {
  if (!debugLocally()) {
    return;
  }

  let image = await imageFromS3(bucket, join(framePrefix, face.name));
  const imgW = image.bitmap.width;
  const imgH = image.bitmap.height;

  let { box: { l, t, w, h } } = face;
  l = Math.round(l * imgW);
  t = Math.round(t * imgH);
  w = Math.round(w * imgW);
  if ((l + w) > imgW) {
    w = imgW - l;
  }
  h = Math.round(h * imgH);
  if ((t + h) > imgH) {
    h = imgH - t;
  }

  image = drawBorder(image, l, t, w, h);

  const parsed = parse(face.name).name;
  await image.writeAsync(join('_outofbound', `${parsed}-${w}x${h}.jpg`));
}

async function _tileFacesAndStore(bucket, framePrefix, itemId, gridId, faces = []) {
  if (faces.length === 0) {
    return undefined;
  }

  // output name
  const prefix = join(framePrefix, PREFIX_FACESINGROUPS);
  const name = `${itemId}_${gridId}.jpg`;
  const relativePath = join(PREFIX_FACESINGROUPS, name);

  const dimension = HEADSHOT_DIMENSION;
  const [nRow, nCol] = _getGridLayout(faces.length);

  const gridWxH = [nCol * dimension[0], nRow * dimension[1]];

  const gridImage = await imageFromScratch(gridWxH[0], gridWxH[1]);

  const duped = faces.slice();
  let promises = [];
  for (let row = 0; row < nRow; row += 1) {
    for (let col = 0; col < nCol; col += 1) {
      if (promises.length >= 20) {
        await Promise.all(promises);
        promises = [];
      }

      const face = duped.shift();
      if (face === undefined) {
        break;
      }

      const [w, h] = dimension;
      const l = w * col;
      const t = h * row;
      face.coordInGrid = { l, t, w, h };
      face.gridImageKey = relativePath;

      promises.push(imageFromS3(bucket, join(framePrefix, face.name))
        .then((image) => {
          const { coordInGrid } = face;
          image = cropFace(image, face.box, dimension);
          gridImage.blit(image, coordInGrid.l, coordInGrid.t);
        }));
    }
  }

  if (promises.length) {
    await Promise.all(promises);
    promises = [];
  }

  // draw border lines
  drawGrid(gridImage, nRow, nCol);

  // store grid image locally for debugger purpose
  if (debugLocally()) {
    await gridImage.writeAsync(join(PREFIX_FACESINGROUPS, name));
  }

  // upload grid image to S3
  const buf = await gridImage.getBufferAsync(MIME_JPEG);
  await uploadFile(bucket, prefix, name, buf);

  return { relativePath, gridWxH, faces };
}

async function _storeGroupOfRepresentableFaces(bucket, framePrefix, itemId, faces) {
  const nGridImages = Math.ceil(faces.length / MAX_FACES_PER_GRID);
  const nFacesPerGrid = Math.round(faces.length / nGridImages);

  const facesInGridGroup = [];
  const duped = faces.slice();
  while (duped.length) {
    const facesInGrid = duped.splice(0, nFacesPerGrid);
    facesInGridGroup.push(facesInGrid);
  }

  // now, create face grid for each group and store
  // it for celebrity and facematch detection
  let promises = [];
  for (let i = 0; i < facesInGridGroup.length; i += 1) {
    const facesInGrid = facesInGridGroup[i];
    promises.push(_tileFacesAndStore(bucket, framePrefix, itemId, i, facesInGrid))
  }
  promises = await Promise.all(promises);

  return promises;
}

async function _storeGroupFace(bucket, framePrefix, faces, temporaryId, dir = '_groups') {
  if (!debugLocally()) {
    return;
  }

  // const dimension = [48, 64];
  // // store the faces for debugger purposes
  // const [nRow, nCol] = _getGridLayout(faces.length);
  // const dimension = [96, 128];
  const dimension = [120, 160];
  let nCol = 9; // 12;
  let nRow = 1;
  if (faces.length <= nCol) {
    nCol = faces.length;
  } else {
    nRow = Math.ceil(faces.length / nCol);
  }

  const gridImage = await imageFromScratch(nCol * dimension[0], nRow * dimension[1]);

  const duped = faces.slice();
  for (let row = 0; row < nRow; row += 1) {
    for (let col = 0; col < nCol; col += 1) {
      const face = duped.shift();

      if (face === undefined) {
        break;
      }

      let image = await imageFromS3(bucket, join(framePrefix, face.name));
      image = cropFace(image, face.box, dimension);
      gridImage.blit(image, col * dimension[0], row * dimension[1]);
    }
  }

  // draw border lines
  drawGrid(gridImage, nRow, nCol);

  await gridImage.writeAsync(join(dir, `${temporaryId}.jpg`));
}

function _groupFramesToShots(faceEmbeddings = []) {
  const framesToShots = [];

  if (faceEmbeddings.length === 0) {
    return framesToShots;
  }

  let curShot = [faceEmbeddings[0]];
  for (let i = 1; i < faceEmbeddings.length; i += 1) {
    const pre = curShot[curShot.length - 1];
    const cur = faceEmbeddings[i];
    if (cur.shot !== pre.shot) {
      framesToShots.push(curShot);
      curShot = [];
    }
    curShot.push(cur);
  }

  if (curShot.length > 0) {
    framesToShots.push(curShot);
  }

  return framesToShots;
}

function _pointInBox(coord, xy) {
  const { l, t, w, h } = coord;
  const [cx, cy] = xy;

  if (l < cx && cx < (l + w) && t < cy && cy < (t + h)) {
    return true;
  }

  return false;
}

function _intersected(a, b) {
  const { t: aT, l: aL, w: aW, h: aH } = a.box || a;
  const aCx = aL + (aW / 2);
  const aCy = aT + (aH / 2);

  const { t: bT, l: bL, w: bW, h: bH } = b.box || b;
  const bCx = bL + (bW / 2);
  const bCy = bT + (bH / 2);

  if ((aCx > bL && aCx < (bL + bW)) && (aCy > bT && aCy < (bT + bH))) {
    return true;
  }

  if ((bCx > aL && bCx < (aL + aW)) && (bCy > aT && bCy < (aT + aH))) {
    return true;
  }

  return false;
}

function _fixOutOfBoundCoords(box) {
  let dirty = false;

  const { t, l, w, h } = box;

  let h0 = h;
  if ((t + h) > 1.0) {
    dirty = true;
    h0 = 0.998 - t;
  }

  let w0 = w;
  if ((l + w) > 1.0) {
    dirty = true;
    w0 = 0.998 - l;
  }

  return [dirty, { l, t, w: w0, h: h0 }];
}

async function _getFacesInShot(bucket, prefix, shot = []) {
  const facesInShot = [];

  for (const frame of shot) {
    for (const face of frame.faces) {
      const [face0, dirty, skipped] = _getFaceItem(frame, face);
      if (dirty) {
        await _drawBoundingBox(bucket, prefix, face);
      }
      if (skipped) {
        continue;
      }
      facesInShot.push(face0);
    }
  }

  return facesInShot;
}

function _getFaceItem(frame, face) {
  const { imageWxH: [imgW, imgH] } = frame;

  // fix out-of-bound coordinate
  const [dirty, box] = _fixOutOfBoundCoords(face.box);
  face.box = box;
  face.name = frame.name;
  face.shot = frame.shot;
  face.frameNum = frame.frameNum;
  face.timestampMillis = frame.timestampMillis;

  let skipped = false;
  const { w, h } = box;
  if ((w * imgW) < 40 && (h * imgH) < 40) {
    console.log(`SKIPPING ${face.name}...${Math.round(w * imgW)}x${Math.round(h * imgH)}`);
    skipped = true;
  }

  return [face, dirty, skipped];
}

function _groupFacesInShot(facesInShot = []) {
  const groupFacesInShot = [];

  if (facesInShot.length === 0) {
    return groupFacesInShot;
  }

  groupFacesInShot.push([facesInShot[0]]);
  for (let i = 1; i < facesInShot.length; i += 1) {
    const cur = facesInShot[i];
    let found = false;
    for (const group of groupFacesInShot) {
      const pre = group[group.length - 1];
      if (_intersected(pre, cur)) {
        const sim = cosim(pre.embedding, cur.embedding);
        if (sim > 0.95) {
          group.push(cur);
          found = true;
          break;
        }
      }
    }
    if (!found) {
      groupFacesInShot.push([cur]);
    }
  }

  return groupFacesInShot;
}

function _representableFaceInGroup(faceGroup) {
  if (faceGroup.length === 0) {
    return undefined;
  }
  if (faceGroup.length === 1) {
    return faceGroup[0];
  }

  const centroidEmbed = centroid(faceGroup.map((x) => x.embedding));
  let bestFace = faceGroup[0];
  let bestSim = cosim(centroidEmbed, bestFace.embedding);

  for (let i = 1; i < faceGroup.length; i += 1) {
    const face = faceGroup[i];
    const sim = cosim(centroidEmbed, face.embedding);
    if (sim > bestSim) {
      bestSim = sim;
      bestFace = face;
    }
  }
  return bestFace;
}

async function _runCelebrityRecognition(bucket, prefix, faceGridGroup = []) {
  let responses = [];

  const rekognitionClient = xraysdkHelper(new RekognitionClient({
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));

  let promises = [];
  for (let i = 0; i < faceGridGroup.length; i += 1) {
    if (promises.length >= 4) {
      promises = await Promise.all(promises);
      responses = responses.concat(promises);
      promises = [];
    }

    const faceGrid = faceGridGroup[i];
    const { relativePath } = faceGrid;
    const key = join(prefix, relativePath);
    const params = {
      Image: { S3Object: { Bucket: bucket, Name: key } },
    };
    const command = new RecognizeCelebritiesCommand(params);
    promises.push(rekognitionClient.send(command)
      .then((res) => {
        res.faceGrid = faceGrid;
        return res;
      }));
  }

  if (promises.length) {
    promises = await Promise.all(promises);
    responses = responses.concat(promises);
    promises = [];
  }

  // upload rekognition response along with the facegrid
  promises = [];
  for (const response of responses) {
    const { faceGrid: { relativePath } } = response;
    const parsed = parse(relativePath);
    const name = `${parsed.name}.json`;
    promises.push(uploadFile(bucket, join(prefix, parsed.dir), name, response));
  }
  await Promise.all(promises);

  return responses;
}

function _tagCelebrityToFaceGroups(celebResponses = [], facesGroup = []) {
  const celebCountMap = {};
  for (const { CelebrityFaces } of celebResponses) {
    for (const { Name } of CelebrityFaces) {
      if (celebCountMap[Name] === undefined) {
        celebCountMap[Name] = 1;
      } else {
        celebCountMap[Name] += 1;
      }
    }
  }

  for (const response of celebResponses) {
    const {
      CelebrityFaces, UnrecognizedFaces,
      faceGrid: { gridWxH, faces },
    } = response;


    for (const face of faces) {
      const { temporaryId } = face;

      let matched = _matchRecognizedFaces(face, gridWxH, CelebrityFaces);
      if (matched) {
        const { Name, MatchConfidence } = matched;
        // low quality?
        if (celebCountMap[Name] === 1 && MatchConfidence < 90.0) {
          _tagUnrecognizedFaceToFaceGroup(temporaryId, matched, facesGroup);
        } else {
          _tagRecognizedFaceToFaceGroup(temporaryId, matched, facesGroup);
        }
        continue;
      }

      matched = _matchUnrecognizedFaces(face, gridWxH, UnrecognizedFaces);
      if (matched) {
        _tagUnrecognizedFaceToFaceGroup(temporaryId, matched, facesGroup);
        continue;
      }

      // not a face (poor quality or false positive)
      console.log(`Face #${temporaryId} not identified as a face. Could be Poor Quality or False Positive?`);
      _tagMisclassifiedToFaceGroup(temporaryId, facesGroup);
    }
  }
}

function _matchRecognizedFaces(face, wxh, recognizedFaces) {
  return _matchRekognitionFaces(face, wxh, recognizedFaces);
}

function _matchUnrecognizedFaces(face, wxh, UnrecognizedFaces) {
  return _matchRekognitionFaces(face, wxh, UnrecognizedFaces);
}

function _matchRekognitionFaces(face, wxh, rekognitionFaces) {
  const [imgW, imgH] = wxh;
  const { coordInGrid } = face;

  for (const rekognitionFace of rekognitionFaces) {
    const {
      BoundingBox: { Left, Top, Width, Height },
    } = rekognitionFace.Face || rekognitionFace;

    const cx = (Left + Width) * imgW;
    const cy = (Top + Height) * imgH;

    if (_pointInBox(coordInGrid, [cx, cy])) {
      return rekognitionFace;
    }
  }

  return undefined;
}

function _tagRecognizedFaceToFaceGroup(temporaryId, recognizedFace, faceGroups) {
  const {
    Name: name, MatchConfidence: confidence, KnownGender: { Type: gender }, Face,
  } = recognizedFace;
  const {
    Confidence: faceConfidence,
    Pose: {
      Pitch: pitch, Roll: roll, Yaw: yaw,
    },
    Quality: {
      Brightness: brightness, Sharpness: sharpness,
    },
  } = Face;

  const faceDetails = {
    confidence: faceConfidence,
    pitch, roll, yaw, brightness, sharpness,
  };

  for (const faceGroup of faceGroups) {
    for (const face of faceGroup) {
      if (face.temporaryId === temporaryId) {
        face.celebrityFace = { name, confidence, gender, faceDetails };
      }
    }
  }
}

function _tagUnrecognizedFaceToFaceGroup(temporaryId, unrecognizedFace, faceGroups) {
  const {
    Confidence: faceConfidence,
    Pose: {
      Pitch: pitch, Roll: roll, Yaw: yaw,
    },
    Quality: {
      Brightness: brightness, Sharpness: sharpness,
    },
  } = unrecognizedFace.Face || unrecognizedFace;

  const confidence = faceConfidence;
  const faceDetails = {
    confidence,
    pitch, roll, yaw, brightness, sharpness,
  };

  for (const faceGroup of faceGroups) {
    for (const face of faceGroup) {
      if (face.temporaryId === temporaryId) {
        face.unrecognizedFace = { confidence, faceDetails };
      }
    }
  }
}

function _tagMisclassifiedToFaceGroup(temporaryId, faceGroups) {
  for (const faceGroup of faceGroups) {
    for (const face of faceGroup) {
      if (face.temporaryId === temporaryId) {
        face.misclassified = true;
      }
    }
  }
}

function _getGridLayout(size) {
  const nRow = Math.round(size ** 0.5);
  let nCol = nRow;
  if ((nRow ** 2) < size) {
    nCol += 1;
  }
  return [nRow, nCol];
}

function _agnesClusters(faceGroups) {
  const faceClusters = [];
  let faces = [];

  if (Array.isArray(faceGroups[0])) {
    for (const faceGroup of faceGroups) {
      faces = faces.concat(faceGroup);
    }
  } else {
    faces = faceGroups.slice(0);
  }

  const embeddings = [];
  for (const face of faces) {
    embeddings.push(face.embedding);
  }

  if (embeddings.length === 0) {
    return faceClusters;
  }

  const tree = agnes(embeddings, {
    method: 'ward',
    distanceFunction: cosdist,
  });

  // const threshold = 0.004;
  const threshold = 0.005;
  const groups = tree.cut(threshold);
  const clusterIndices = [];
  for (const group of groups) {
    const indices = group.indices();
    clusterIndices.push(indices);
  }

  for (let i = 0; i < clusterIndices.length; i += 1) {
    const faceCluster = [];
    for (const index of clusterIndices[i]) {
      faceCluster.push(faces[index]);
    }
    faceClusters.push(faceCluster);
  }

  return faceClusters;
}

async function _clusterFacesByAgnesAlgoritm(bucket, prefix, faceEmbeddings) {
  const faces = [];

  for (const frame of faceEmbeddings) {
    for (const face of frame.faces) {
      const [face0, dirty, skipped] = _getFaceItem(frame, face);
      if (dirty) {
        await _drawBoundingBox(bucket, prefix, face);
      }
      if (skipped) {
        continue;
      }
      faces.push(face0);
    }
  }

  // clustering faces
  const faceGroups = _agnesClusters(faces);
  for (let i = 0; i < faceGroups.length; i += 1) {
    for (const face of faceGroups[i]) {
      face.temporaryId = `${i}.0`;
    }
  }

  return faceGroups;
}

async function _clusterFacesByFrameShots(bucket, prefix, faceEmbeddings) {
  const faceGroups = [];

  const framesToShots = _groupFramesToShots(faceEmbeddings);
  // For each shot, collect the faces
  for (const shot of framesToShots) {
    const shotId = shot[0].shot;

    const facesInShot = await _getFacesInShot(bucket, prefix, shot);
    if (facesInShot.length === 0) {
      continue;
    }

    const groupFacesInShot = _groupFacesInShot(facesInShot);

    for (let i = 0; i < groupFacesInShot.length; i += 1) {
      const temporaryId = `${shotId}.${i}`;
      for (const face of groupFacesInShot[i]) {
        face.temporaryId = temporaryId;
      }
      faceGroups.push(groupFacesInShot[i]);
    }
  }

  return faceGroups;
}

module.exports = StateIteratorCompleted;
