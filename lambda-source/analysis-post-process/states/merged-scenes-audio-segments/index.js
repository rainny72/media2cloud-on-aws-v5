// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
} = require('node:path');
const {
  StateData: {
    Statuses: {
      Completed,
    },
  },
  CommonUtils: {
    download,
    uploadFile,
    debugLocally,
  },
  SimpleGeometry: {
    timeIntersected,
  },
  SegmentHelper: {
    TYPE_PROGRAMME, TYPE_RECAP, TYPE_INTRO, TYPE_RATING,
  },
} = require('core-lib');
const BaseState = require('../shared/base');

class StateMergeScenesAudioSegments extends BaseState {
  static opSupported(op) {
    return op === 'StateMergeScenesAudioSegments';
  }

  get input() {
    return this.stateData.input;
  }

  get data() {
    return this.stateData.data;
  }

  get proxyBucket() {
    return this.input.destination.bucket;
  }

  get inputaudio() {
    return this.input.audio;
  }

  get audiotagging() {
    return (this.inputaudio || {}).audiotagging;
  }

  get datavideo() {
    return this.data.video;
  }

  get dataaudio() {
    return this.data.audio;
  }

  get rekognition() {
    return this.datavideo.rekognition;
  }

  get structural() {
    return (this.rekognition || {}).structural;
  }

  get facerecognition() {
    return (this.rekognition || {}).facerecognition;
  }

  get audioSegments() {
    return (this.dataaudio || {}).audioSegments;
  }

  async process() {
    const outputs = await this.downloadAllOutputs();

    let {
      sceneShots, faceMetadata, audioSegments = {}, audioTags = [],
    } = outputs;

    sceneShots = _mapAudioAnalysisToScenes(audioSegments, sceneShots);
    sceneShots = _mapFaceMetadataToScenes(faceMetadata, sceneShots);
    sceneShots = _mapAudioTagsToScenes(audioTags, sceneShots);

    const bucket = this.proxyBucket;
    const { prefix, shotsToScenes, embeddings } = this.structural;

    let promises = [];
    promises.push(uploadFile(bucket, prefix, shotsToScenes, sceneShots));

    // Prepare for the next state
    const iterators = [];

    const imageIterators = _prepareSequenceImages(sceneShots);
    for (const iterator of imageIterators) {
      iterators.push({
        bucket,
        prefix,
        embeddings,
        shotsToScenes,
        ids: iterator,
      });
    }
    promises = await Promise.all(promises);

    this.data.iterators = iterators;

    return this.setCompleted();
  }

  setCompleted() {
    this.stateData.status = Completed;
    return this.stateData;
  }

  async downloadAllOutputs() {
    const audioSegments = this.audioSegments || {};
    const {
      prefix, shotsToScenes,
    } = this.structural || {};
    const {
      prefix: facePrefix, metadata: faceMetadata,
    } = this.facerecognition || {};
    const {
      prefix: audioPrefix, output: audioTags,
    } = this.audiotagging || {};

    const outputs = {};
    const dataFiles = [];

    // shots_to_scene
    dataFiles.push(['sceneShots', join(prefix, shotsToScenes)]);

    // facemetadata
    if (facePrefix && faceMetadata) {
      dataFiles.push(['faceMetadata', join(facePrefix, faceMetadata)]);
    }

    // audio segments
    if (audioSegments.output !== undefined) {
      dataFiles.push(['audioSegments', join(audioSegments.prefix, audioSegments.output)]);
    }

    // audio tagging
    if (audioPrefix !== undefined && audioTags !== undefined) {
      dataFiles.push(['audioTags', join(audioPrefix, audioTags)]);
    }

    const bucket = this.proxyBucket;

    let promises = [];
    for (const [field, key] of dataFiles) {
      promises.push(download(bucket, key)
        .then((res) => {
          outputs[field] = JSON.parse(res);
        }));
    }
    await Promise.all(promises);

    return outputs;
  }
}

function _prepareSequenceImages(sceneGroups) {
  const toBeProcessed = [];

  for (const scene of sceneGroups) {
    const {
      scene: sceneId,
    } = scene;

    toBeProcessed.push({
      scene: sceneId,
    });
  }

  const nImagesToGenerate = toBeProcessed.length;
  const nRounds = Math.ceil(nImagesToGenerate / 80);
  const imagesPerIterator = Math.round(nImagesToGenerate / nRounds);

  const iterators = [];
  while (toBeProcessed.length) {
    const iterator = toBeProcessed.splice(0, imagesPerIterator);
    iterators.push(iterator);
  }

  return iterators;
}

function _mapAudioAnalysisToScenes(audioAnalysis, sceneShots) {
  if (sceneShots.length === 0) {
    return sceneShots;
  }

  const {
    conversationAnalysis, dialogueGroups = [], genres = [], kindOfContent,
  } = audioAnalysis;

  if (genres.length > 0) {
    sceneShots[0].genres = genres;
  }

  if (kindOfContent) {
    sceneShots[0].kindOfContent = kindOfContent;
  }

  if (conversationAnalysis !== undefined) {
    const {
      response: {
        jsonOutput: { audio_segments: audioSegments = [] },
      },
    } = conversationAnalysis;
    _mapAudioSegmentTypeToScenes(audioSegments, sceneShots);
  }

  for (const dialogueGroup of dialogueGroups) {
    const {
      timestampRange: [amin, amax],
    } = dialogueGroup;

    let relatedScenes = [];

    for (const scene of sceneShots) {
      const {
        timestampRange: [vmin, vmax],
      } = scene;

      if (vmax < amin) {
        continue;
      }

      if (vmin > amax) {
        break;
      }

      if (timeIntersected([vmin, vmax], [amin, amax])) {
        relatedScenes.push(scene);
      }
    }

    _mapTranscriptToScenes(dialogueGroup, relatedScenes);
  }

  return sceneShots;
}

function _mapAudioSegmentTypeToScenes(audioSegments, scenes) {
  if (debugLocally()) {
    for (const scene of scenes) {
      delete scene.segmentType;
      delete scene.audioSegmentType;
    }
  }

  for (const segment of audioSegments) {
    const {
      start, end, recap_segment, intro_segment, parental_guidance_segment,
    } = segment;

    if ((end - start) <= 0) {
      continue;
    }

    let audioSegmentType = TYPE_PROGRAMME;
    if (String(parental_guidance_segment) === 'true') {
      audioSegmentType = TYPE_RATING;
    } else if (String(recap_segment) === 'true') {
      audioSegmentType = TYPE_RECAP;
    } else if (String(intro_segment) === 'true') {
      audioSegmentType = TYPE_INTRO;
    }

    for (const scene of scenes) {
      if (scene.audioSegmentType !== undefined) {
        continue;
      }

      const { timestampRange: [vmin, vmax] } = scene;

      if (vmax < start) {
        continue;
      }

      if (vmin > end) {
        break;
      }

      if (timeIntersected([vmin, vmax], [start, end])) {
        scene.audioSegmentType = audioSegmentType;
      }
    }
  }

  return scenes;
}

function _mapTranscriptToScenes(dialogueGroup, scenes) {
  const {
    sequenceType,
    topicGroup,
    transcripts,
  } = dialogueGroup;

  for (const scene of scenes) {
    scene.topicGroup = topicGroup;
    scene.sequenceType = sequenceType;
    if (scene.transcripts === undefined) {
      scene.transcripts = [];
    }
  }

  if (scenes.length === 0) {
    return;
  }

  if (scenes.length === 1) {
    scenes[0].transcripts = scenes[0].transcripts.concat(transcripts);
    return;
  }

  for (const transcript of transcripts) {
    const { start, end } = transcript;
    const overlapped = [];

    for (const scene of scenes) {
      const {
        timestampRange: [tmin, tmax],
      } = scene;

      if (!timeIntersected([tmin, tmax], [start, end])) {
        overlapped.push({
          scene,
          percentage: 0,
        });
        continue;
      }

      if (tmin <= start && tmax >= end) {
        overlapped.push({
          scene,
          percentage: 1,
        });
        continue;
      }

      if (start <= tmin && end >= tmax) {
        overlapped.push({
          scene,
          percentage: (tmax - tmin) / (start - end),
        });
        continue;
      }

      if (start <= tmin) {
        overlapped.push({
          scene,
          percentage: (Math.min(tmax, end) - tmin) / (end - start),
        });
        continue;
      }

      if (tmin <= start) {
        overlapped.push({
          scene,
          percentage: (Math.min(tmax, end) - start) / (end - start),
        });
        continue;
      }
      throw new Error('LOGIC ERROR');
    }

    overlapped.sort((a, b) =>
      b.percentage - a.percentage);

    const match = overlapped[0].scene;
    match.transcripts.push(transcript);
  }
}

function _mapFaceMetadataToScenes(faceMetadata, sceneShots) {
  const { recognized = [] } = faceMetadata || {};
  if (recognized.length === 0) {
    return sceneShots;
  }

  for (const scene of sceneShots) {
    const { timestampRange: [tmin, tmax] } = scene;
    const nameMap = {};
    for (const face of recognized) {
      const { name, timestampRange: [fmin, fmax] } = face;
      if (timeIntersected([tmin, tmax], [fmin, fmax], false)) {
        const { coordInGrid, gridImageKey } = face.faces[0];
        if (nameMap[name] === undefined) {
          nameMap[name] = { name, coordInGrid, gridImageKey };
        }
      }
    }
    scene.faces = Object.values(nameMap);
  }

  return sceneShots;
}

function _mapAudioTagsToScenes(audioTags = [], sceneShots = []) {
  if (sceneShots.length === 0 || audioTags.length === 0) {
    return sceneShots;
  }

  for (const scene of sceneShots) {
    const { timestampRange: [tmin, tmax] } = scene;
    const tagMap = {};
    for (const { label, start, end } of audioTags) {
      if (_withinA([tmin, tmax], [start, end])) {
        if (tagMap[label] === undefined) {
          tagMap[label] = { label, duration: 0 };
        }
        tagMap[label].duration += (end - start);
      }
    }
    scene.audioTags = Object.values(tagMap);
  }

  return sceneShots;
}

function _withinA(a, b) {
  if (b[0] >= a[0] && b[1] <= a[1]) {
    return true;
  }

  return false;
}

module.exports = StateMergeScenesAudioSegments;
