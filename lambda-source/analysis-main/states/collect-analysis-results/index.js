// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
} = require('node:path');
const {
  StateData,
  AnalysisError,
  CommonUtils: {
    download,
    uploadFile,
  },
  // SimpleGeometry: {
  //   timeIntersected,
  // },
} = require('core-lib');

class StateCollectAnalysisResults {
  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new AnalysisError('stateData not StateData object');
    }
    this.$stateData = stateData;
  }

  get [Symbol.toStringTag]() {
    return 'StateCollectAnalysisResults';
  }

  get stateData() {
    return this.$stateData;
  }

  get input() {
    return this.stateData.input;
  }

  get aiOptions() {
    return this.input.aiOptions;
  }

  get data() {
    return this.stateData.data;
  }

  get bucket() {
    return this.input.destination.bucket;
  }

  get inputaudio() {
    return this.input.audio;
  }

  get inputvideo() {
    return this.input.video;
  }

  get dataaudio() {
    return this.data.audio;
  }

  get datavideo() {
    return this.data.video;
  }

  get rekognition() {
    return (this.datavideo || {}).rekognition;
  }

  async process() {
    const data = this.data;
    const { iterators } = data;

    for (const iterator of iterators) {
      for (const [key, value] of Object.entries(iterator)) {
        data[key] = value;
      }
    }

    delete data.iterators;

    await this.mergeAudioVisualData();

    this.stateData.setCompleted();
    return this.stateData.toJSON();
  }

  async mergeAudioVisualData() {
    const {
      diarisation = {},
    } = this.inputaudio || {};
    const {
      facerecognition = {},
    } = this.rekognition || {};

    if (!diarisation.speakerEmbeddings || !facerecognition.metadata) {
      return;
    }

    // Binding speaker and visual MAY require autofaceindexer
    // as speaker can belong to some unknown person...
    // const {
    //   autofaceindexer,
    // } = this.aiOptions || {};

    // if (!autofaceindexer) {
    //   return;
    // }

    const dataFiles = [
      ['speakerEmbeddings', join(diarisation.prefix, diarisation.speakerEmbeddings)],
      ['facemetadata', join(facerecognition.prefix, facerecognition.metadata)],
    ];

    const bucket = this.bucket;

    const output = {};
    let promises = [];
    for (const [field, key] of dataFiles) {
      promises.push(download(bucket, key)
        .then((res) => {
          output[field] = JSON.parse(res);
        }));
    }
    promises = await Promise.all(promises);

    const {
      speakerEmbeddings, facemetadata,
    } = output;
    const modified = _mergeSpeakerWithRecognizedFaces(speakerEmbeddings, facemetadata);

    if (modified) {
      await uploadFile(bucket, diarisation.prefix, diarisation.speakerEmbeddings, speakerEmbeddings);
    }
  }
}

function _mergeSpeakerWithRecognizedFaces(speakers, facemetadata) {
  console.log(`==== FIND SPEAKER BY MOST APPEARANCES ====`);

  let updated = false;

  const { recognized } = facemetadata;

  if (speakers.length === 0 || recognized.length === 0) {
    return updated;
  }

  speakers.sort((a, b) => {
    const durationA = a.segments.reduce((sum, cur) =>
      sum + (cur.end - cur.start), 0);
    const durationB = b.segments.reduce((sum, cur) =>
      sum + (cur.end - cur.start), 0);
    return durationB - durationA;
  });
  // speakers.sort((a, b) =>
  //   b.segments.length - a.segments.length);

  const alreadyChosenFaceMap = {};

  for (const speaker of speakers) {
    let nFaces = 0;
    let totalTimeOverlapped = 0;
    const faceMap = {};

    const { segments } = speaker;
    for (const segment of segments) {
      const { start, end } = segment;

      const response = _findFacesInRange(recognized, [start, end]);
      for (const [name, { faces, timeOverlapped }] of Object.entries(response)) {
        nFaces += faces.length;
        totalTimeOverlapped += timeOverlapped;
        if (faceMap[name] === undefined) {
          faceMap[name] = { timeOverlapped: 0, name, faces: [] };
        }
        for (const face of faces) {
          faceMap[name].faces.push(face);
        }
        faceMap[name].timeOverlapped += timeOverlapped;
      }
    }

    const { speakerId } = speaker;
    if (nFaces === 0 || totalTimeOverlapped === 0) {
      console.log(`== ${speakerId}: No face. DROPPING ==`);
      continue;
    }

    const bestMatch = _bestGuessMatchFace(faceMap, alreadyChosenFaceMap);
    if (bestMatch === undefined) {
      console.log(`== ${speakerId}: No face ==`);
      continue;
    }

    const { name, face } = bestMatch;
    speaker.matchedFace = face;
    updated = true;

    // also update the already choosen map
    if (alreadyChosenFaceMap[name] === undefined) {
      alreadyChosenFaceMap[name] = { name, speakers: [] };
    }
    alreadyChosenFaceMap[name].speakers.push(speakerId);
    console.log(`== ${speakerId}: ${bestMatch.name} ==`);
  }

  return updated;
}

function _bestGuessMatchFace(faceMap, alreadyChosenFaceMap) {
  const items = Object.values(faceMap);
  if (items.length === 0) {
    return undefined;
  }

  if (items.length === 1) {
    const { name, faces } = items[0];
    const matched = faces.find((face) =>
      face.gridImageKey !== undefined);
    return { name, face: matched };
  }

  const occupied = Object.keys(alreadyChosenFaceMap);
  const filtered = []
  for (const item of items) {
    if (!occupied.includes(item.name)) {
      filtered.push(item);
    }
  }

  if (filtered.length === 0) {
    return undefined;
  }

  const rankedByTimeOverlapped = filtered.slice()
    .sort((a, b) => b.timeOverlapped - a.timeOverlapped);

  const rankedByFaces = filtered.slice()
    .sort((a, b) => b.faces.length - a.faces.length);

  // if is tied, choose timeOverlapped as default;
  let matched = rankedByTimeOverlapped[0];
  if (rankedByTimeOverlapped[0].name !== rankedByFaces[0].name) {
    // calculate the percentage and choose the higher one...
    let pctTimeOverlapped = rankedByTimeOverlapped.reduce((sum, cur) =>
      sum + cur.timeOverlapped, 0);
    pctTimeOverlapped = rankedByTimeOverlapped[0].timeOverlapped / pctTimeOverlapped;

    let pctFaces = rankedByFaces.reduce((sum, cur) =>
      sum + cur.faces.length, 0);
    pctFaces = rankedByFaces[0].faces.length / pctFaces;

    if (pctFaces > pctTimeOverlapped) {
      matched = rankedByFaces[0];
    }
  }
  const { name, faces } = matched;
  matched = faces.find((face) =>
    face.gridImageKey !== undefined);

  return { name, face: matched };
}

function _findFacesInRange(recognized, timeRange) {
  const faceMap = {};

  const [start, end] = timeRange;
  for (const { name, timestampRange, faces } of recognized) {
    const [fsta, fend] = timestampRange;

    const matchedInShot = [];
    for (const face of faces) {
      const { timestampMillis: t } = face;
      if (t >= start && t <= end) {
        matchedInShot.push(face);
        continue;
      }
      if (t > end) {
        break;
      }
    }

    if (matchedInShot.length > 0) {
      // how much time overlapped in the segment?
      const overlapped = _timeOverlapped([start, end], [fsta, fend]);
      // drop noisy datapoints
      if (overlapped < 800) {
        continue;
      }
      if (faceMap[name] === undefined) {
        faceMap[name] = { timeOverlapped: 0, faces: [] };
      }
      for (const face of matchedInShot) {
        faceMap[name].faces.push(face);
      }
      faceMap[name].timeOverlapped += overlapped;
    }
  }

  return faceMap;
}

function _timeOverlapped(a, b) {
  const [aStart, aEnd] = a;
  const [bStart, bEnd] = b;

  if (aEnd <= bStart || bEnd <= aStart) {
    return 0;
  }

  const overlapStart = Math.max(aStart, bStart);
  const overlapEnd = Math.min(aEnd, bEnd);

  return overlapEnd - overlapStart;
}

module.exports = StateCollectAnalysisResults;
