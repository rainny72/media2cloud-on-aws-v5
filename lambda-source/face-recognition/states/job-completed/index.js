// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
} = require('node:path');
const {
  StateData: {
    Statuses: { Completed },
  },
  AnalysisTypes: {
    Rekognition: { FaceMatch },
  },
  CommonUtils: {
    download,
    uploadFile,
    toHHMMSS,
  },
  WebVttHelper: {
    compile: compileVtt,
  }
} = require('core-lib');
const BaseState = require('../shared/base');

const JSON_FACEMETADATA = 'facemetadata.json';
const MIN_CELEB_CONFIDENCE = 98.0;

class StateJobCompleted extends BaseState {
  static opSupported(op) {
    return op === 'StateJobCompleted';
  }

  get facerecognition() {
    return this.data.facerecognition;
  }

  get data() {
    return this.stateData.data;
  }

  get uuid() {
    return this.stateData.uuid;
  }

  async process() {
    try {
      const {
        bucket, framePrefix, output, frameshotSnapshot, duration,
      } = this.facerecognition;

      const faceGroup = await download(bucket, join(framePrefix, output))
        .then((res) =>
          JSON.parse(res));

      const shotMap = await download(bucket, join(framePrefix, frameshotSnapshot))
        .then((res) =>
          JSON.parse(res));

      const { usage } = faceGroup;
      const faceMaps = _parseFaceGroup(faceGroup);
      // Generate V5 metadata
      const metadata = await this.generateMetadata(faceMaps, shotMap, duration, usage);

      // Generate V4 compatibility outputs
      const v4Response = await this.generateV4CompatibleMetadata(faceMaps, shotMap, duration, usage);

      const { startTime, endTime } = this.facerecognition;
      const facerecognition = {
        startTime,
        endTime,
        status: Completed,
        prefix: framePrefix,
        output,
        metadata,
        usage,
      };

      return {
        facerecognition,
        ...v4Response,
      };
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  async generateMetadata(faceMaps, shotMap, duration, usage) {
    const { taggedFaceMap, untaggedFaceMap, unrecognizedFaceMap } = faceMaps;

    const knownMap = {};

    for (const faceMap of [taggedFaceMap, untaggedFaceMap]) {
      for (const [qualifiedName, faces] of Object.entries(faceMap)) {
        const shots = _groupFaceByShot(faces);

        for (const faceInShot of shots) {
          if (faceInShot.length === 0) {
            continue;
          }

          const shotId = String(faceInShot[0].shot);
          const currentShot = shotMap[shotId];

          const item = _timelineItem(qualifiedName, duration, currentShot, faceInShot);
          if (item === undefined) {
            continue;
          }

          const centroids = _toFaceMetadataInShot(faceInShot, qualifiedName);
          if (centroids.length === 0) {
            continue;
          }

          const { begin, end } = item;
          if (knownMap[qualifiedName] === undefined) {
            knownMap[qualifiedName] = [];
          }
          knownMap[qualifiedName].push({
            name: qualifiedName,
            timestampRange: [begin, end],
            faces: centroids,
          });
        }
      }
    }

    // Now, process faces with no celebrity or facemtach info
    const unknownMap = {};
    for (const [temporaryId, faces] of Object.entries(unrecognizedFaceMap)) {
      const shots = _groupFaceByShot(faces);

      for (const faceInShot of shots) {
        if (faceInShot.length === 0) {
          continue;
        }

        const shotId = String(faceInShot[0].shot);
        const currentShot = shotMap[shotId];

        const item = _timelineItem(temporaryId, duration, currentShot, faceInShot);
        if (item === undefined) {
          continue;
        }

        const centroids = _toFaceMetadataInShot(faceInShot, undefined);
        if (centroids.length === 0) {
          continue;
        }

        const { begin, end } = item;
        if (unknownMap[temporaryId] === undefined) {
          unknownMap[temporaryId] = [];
        }
        unknownMap[temporaryId].push({
          temporaryId,
          timestampRange: [begin, end],
          faces: centroids,
        });
      }
    }

    const { bucket, framePrefix } = this.facerecognition;
    const name = JSON_FACEMETADATA;

    const recognized = Object.values(knownMap).flat(1);
    const unrecognized = Object.values(unknownMap).flat(1);
    const data = { usage, recognized, unrecognized };

    await uploadFile(bucket, framePrefix, name, data);

    return name;
  }

  async generateV4CompatibleMetadata(faceMaps, shotMap, duration, usage) {
    const { taggedFaceMap, untaggedFaceMap } = faceMaps;
    const metadata = _toV4CompatibleMetadata(taggedFaceMap, untaggedFaceMap, shotMap, duration);

    return await this.uploadV4Metadata(metadata, usage);
  }

  async uploadV4Metadata(metadata = {}, usage = {}) {
    const {
      bucket, prefix, requestTime, framePrefix, output,
    } = this.facerecognition;

    let isoTime = new Date();
    if (requestTime) {
      isoTime = new Date(requestTime);
    }
    isoTime = isoTime.toISOString().split('.')[0].replace(/[:-]/g, '');

    let promises = [];

    const {
      timelinesMap = {}, timeseriesMap = {}, vttMap = {},
    } = metadata;

    // create a dummy mapFile, redirect.json
    const redirect = { prefix: framePrefix, name: output };
    const mapData = {
      version: 3,
      file: 'redirect.json',
      data: Object.keys(timelinesMap),
    };

    const name = `${FaceMatch}.json`;
    const dataOut = [
      [undefined, join('raw', isoTime, 'rekognition'), 'redirect.json', redirect],
      ['output', join('raw', isoTime, 'rekognition'), 'mapFile.json', mapData],
      ['metadata', join('metadata', FaceMatch), name, timelinesMap],
      ['timeseries', join('timeseries', FaceMatch), name, timeseriesMap],
      ['vtt', join('vtt', FaceMatch), name, vttMap],
    ];

    let responseData = {};

    for (const [field, subPrefix, json, data] of dataOut) {
      promises.push(uploadFile(bucket, join(prefix, subPrefix), json, data));
      if (field !== undefined) {
        responseData[field] = join(prefix, subPrefix, json);
      }
    }
    promises = await Promise.all(promises);

    const {
      startTime = 0, endTime = 0,
    } = this.facerecognition;

    const {
      celebrityApiCount = 0, searchFaceApiCount = 0, indexFaceApiCount = 0,
    } = usage;

    const apiCount = celebrityApiCount + searchFaceApiCount + indexFaceApiCount;

    return {
      [FaceMatch]: {
        ...responseData, startTime, endTime, apiCount, usage,
      },
    };
  }
}

function _toFaceMetadataInShot(faces, qualifiedName) {
  const consolidated = [];

  for (const face of faces) {
    if (!face.isCentroid) {
      continue;
    }

    // essential data
    const { box, name, frameNum, timestampMillis, temporaryId } = face;
    // data used for visualisation
    const { coordInGrid, gridImageKey, tsne } = face;
    // optional
    const { celebrityFace = {}, facematch = {} } = face;
    const celeb = qualifiedName;
    const confidence = _faceConfidence(face);
    const faceId = facematch.faceId;
    const collectionId = facematch.collectionId;
    const gender = celebrityFace.gender || (face.gender || {}).name;

    // (DO NOT save shot info as it gets reassigned from other workflows)

    consolidated.push({
      box, name, frameNum, timestampMillis, temporaryId,
      coordInGrid, gridImageKey, tsne,
      faceId, collectionId, celeb, confidence, gender,
    });
  }

  return consolidated;
}

function _parseFaceGroup(faceGroup) {
  const taggedFaceMap = {};
  const untaggedFaceMap = {};

  const { recognizedFaces, unrecognizedFaces } = faceGroup;

  while (recognizedFaces.length) {
    const face = recognizedFaces.shift();
    const { facematch, celebrityFace } = face;

    const celeb = _qualifiedFaceName(face);

    let faceId;
    if (facematch !== undefined) {
      faceId = facematch.faceId;
    }

    if (celeb) {
      if (taggedFaceMap[celeb] === undefined) {
        taggedFaceMap[celeb] = [];
      }
      taggedFaceMap[celeb].push(face);
      continue;
    }

    if (faceId) {
      if (untaggedFaceMap[faceId] === undefined) {
        untaggedFaceMap[faceId] = [];
      }
      untaggedFaceMap[faceId].push(face);
      continue;
    }

    // move it to unrecognized faces
    let reason = `${(face.gender || {}).name} (age: ${(face.age)})`;
    if ((celebrityFace || {}).name) {
      reason = `${celebrityFace.name} (${Math.round(celebrityFace.confidence)})`;
    }
    console.log(`DROPPING: No faceId or low celebrity confidence: ${reason} [${face.name}]`);

    unrecognizedFaces.push(face);
  }

  const unrecognizedFaceMap = {};
  while (unrecognizedFaces.length) {
    const face = unrecognizedFaces.shift();

    const { temporaryId } = face;
    if (unrecognizedFaceMap[temporaryId] === undefined) {
      unrecognizedFaceMap[temporaryId] = [];
    }
    unrecognizedFaceMap[temporaryId].push(face);
  }

  return { taggedFaceMap, untaggedFaceMap, unrecognizedFaceMap };
}

function _toV4CompatibleMetadata(taggedFaceMap, untaggedFaceMap, shotMap, duration) {
  const timelinesMap = {};
  const timeseriesMap = {};
  const vttMap = {};

  for (const faceMap of [taggedFaceMap, untaggedFaceMap]) {
    for (const [name, faces] of Object.entries(faceMap)) {
      const shots = _groupFaceByShot(faces);

      const timelines = [];
      const timeseries = [];
      const vttcues = [];

      for (const faceInShot of shots) {
        if (faceInShot.length === 0) {
          continue;
        }

        const shotId = String(faceInShot[0].shot);
        const currentShot = shotMap[shotId];

        let item = _timelineItem(name, duration, currentShot, faceInShot);
        if (item !== undefined) {
          timelines.push(item);
        }

        item = _toVttCue(item);
        if (item !== undefined) {
          vttcues.push(item);
        }

        item = _timeseriesItem(name, duration, faceInShot)
        if (item !== undefined) {
          timeseries.push(item);
        }
      }

      let track = _composeTimelineTrack(timelines);
      if (track !== undefined) {
        timelinesMap[name] = track;
      }

      track = _composeTimeseriesTrack(timeseries);
      if (track !== undefined) {
        timeseriesMap[name] = track;
      }

      track = _composeVttTrack(vttcues);
      if (track !== undefined) {
        vttMap[name] = track;
      }
    }
  }

  return { timelinesMap, timeseriesMap, vttMap };
}

function _toVttCue(item) {
  const { name, begin, end, confidence, cx, cy } = item;
  if ((end - begin) < 0) {
    return undefined;
  }

  const text = `${name}\n(${Math.round(confidence)}%)`;
  const line = Math.floor(cy * 100);
  const position = Math.floor(cx * 100);
  const alignment = `align:center line:${line}% position:${position}% size:25%`;

  let end0 = end;
  if ((end0 - begin) < 800) {
    end0 = begin + 800;
  }

  return {
    start: begin / 1000,
    end: end0 / 1000,
    text,
    styles: alignment,
  };
}

function _timelineItem(name, duration, currentShot, faces = []) {
  duration;
  if (faces.length === 0) {
    return undefined;
  }

  const face0 = faces[0];
  const faceN = faces[faces.length - 1];

  const faceId = (face0.facematch || {}).faceId;
  let begin = face0.timestampMillis;
  let end = faceN.timestampMillis;
  const count = faces.length;
  const confidence = _faceConfidence(face0);
  const { box: { l, t, w, h } } = face0;
  const cx = l + (w / 2);
  const cy = t + (h / 2);

  // roll up timestamp to shot level?
  if ((currentShot || {}).timestampRange !== undefined) {
    const {
      timestampRange: shotTimeRange,
    } = currentShot;

    [begin, end] = _rollupTimestamp(name, [begin, end], shotTimeRange, count);
  }

  return { name, faceId, begin, end, confidence, cx, cy, count };
}

function _timeseriesItem(label, duration, faces = []) {
  if (faces.length === 0) {
    return undefined;
  }

  const face0 = faces[0];
  const faceN = faces[faces.length - 1];
  const faceId = (face0.facematch || {}).faceId;
  const begin = face0.timestampMillis;
  const end = faceN.timestampMillis;
  const appearance = end - begin;

  let desc = (face0.celebrityFace || {}).gender;
  if ((face0.facematch || {}).gender) {
    desc = `${face0.facematch.gender} (Age: ${face0.facematch.ageRange || '??'})`;
  } else {
    desc = `${(face0.gender || {}).name || 'Unknown'} (Age: ${face0.age || '??'})`;
  }

  // group by timestamp to ensure multiple
  // appearances of the same face are shown properly
  const timestampMap = {};
  for (const item of faces) {
    const id = String(item.timestampMillis);
    if (timestampMap[id] === undefined) {
      timestampMap[id] = [];
    }
    timestampMap[id].push(item);
  }

  const data = [];
  for (const [timestampMillis, items] of Object.entries(timestampMap)) {
    const x = Number(timestampMillis);
    const y = items.length;

    const details = [];
    for (const item of items) {
      const c = _faceConfidence(item);
      details.push({ ...item.box, c });
    }
    data.push({ x, y, details });
  }

  return { label, faceId, desc, data, appearance, duration };
}

function _composeTimelineTrack(timelines = []) {
  if (timelines.length === 0) {
    return undefined;
  }
  return timelines;
}

function _composeTimeseriesTrack(timeseries = []) {
  if (timeseries.length === 0) {
    return undefined;
  }
  const { label, faceId, desc, duration } = timeseries[0];

  let appearance = 0;
  let data = [];
  for (const item of timeseries) {
    appearance += item.appearance;
    data = data.concat(item.data);
  }

  return { label, faceId, desc, data, appearance, duration };
}

function _composeVttTrack(vttCues = []) {
  if (vttCues.length === 0) {
    return undefined;
  }

  vttCues.sort((a, b) => a.start - b.start);

  const cues = [];
  for (let i = 0; i < vttCues.length; i += 1) {
    cues.push({
      identifier: String(i + 1),
      ...vttCues[i],
    });
  }

  return compileVtt({
    meta: { Kind: 'metadata', Language: 'en' },
    valid: true,
    cues,
  });
}

function _groupFaceByShot(faces) {
  let shotGroup = {};
  for (const face of faces) {
    const id = String(face.shot);
    if (shotGroup[id] === undefined) {
      shotGroup[id] = [];
    }
    shotGroup[id].push(face);
  }

  shotGroup = Object.values(shotGroup);
  for (const faces of shotGroup) {
    faces.sort((a, b) => a.timestampMillis - b.timestampMillis);
  }
  return shotGroup;
}

function _rollupTimestamp(name, faceTimeRange, shotTimeRange, faceCount) {
  const [tsta, tend] = shotTimeRange;
  let [begin, end] = faceTimeRange;

  // roll up to segment timestamp to cover the whole shot
  // if timestamps more than 80%
  if ((end - begin) / (tend - tsta) > 0.799) {
    console.log(`ROLLUP: ${name}: ${toHHMMSS(begin, true)}/${toHHMMSS(end, true)} -> ${toHHMMSS(tsta, true)}/${toHHMMSS(tend, true)}`);
    begin = Math.min(begin, tsta);
    end = Math.max(end, tend);
  }

  // extremely short segment
  if ((end - begin) < 10 && (tend - tsta) <= 1600) {
    // roll up to segment timestamp
    if (faceCount < 2) {
      console.log(`ROLLUP: ${name}: ${toHHMMSS(begin, true)}/${toHHMMSS(end, true)} -> ${toHHMMSS(tsta, true)}/${toHHMMSS(tend, true)} [Extremely shot segment]`);
      begin = Math.min(begin, tsta);
      end = Math.max(end, tend);
    }
  }

  // pad to 800ms at the minimum
  if ((end - begin) < 800) {
    end = begin + 800;
  }

  return [begin, end];
}

function _faceConfidence(face) {
  if ((face.facematch || {}).confidence !== undefined) {
    return face.facematch.confidence;
  }
  if ((face.celebrityFace || {}).confidence) {
    return face.celebrityFace.confidence;
  }
  if ((face.unrecognizedFace || {}).confidence) {
    return face.unrecognizedFace.confidence;
  }
  return 10;
}

function _qualifiedFaceName(face) {
  if ((face.facematch || {}).celeb) {
    return face.facematch.celeb;
  }

  if (((face.celebrityFace || {}).confidence || 0) > MIN_CELEB_CONFIDENCE) {
    return face.celebrityFace.name;
  }

  return undefined;
}

module.exports = StateJobCompleted;
