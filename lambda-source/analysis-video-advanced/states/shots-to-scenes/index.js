// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
} = require('node:path');
const {
  CommonUtils: {
    download,
    uploadFile,
    getSignedUrl,
    toFraction,
    debugLocally,
  },
  SegmentHelper: {
    JSON_SHOTSTOSCENES,
    MAXTIMEDISTANCE,
    MINFRAMESIMILARITY,
    groupShotsToScenes,
    tagAudioMetadataToFrames,
    tagAudioMetadataToShots,
  },
  FFmpegHelper: {
    probeStream,
  },
  JimpHelper: {
    imageFromScratch,
    imageFromS3,
    drawGrid,
  },
} = require('core-lib');
const BaseState = require('../shared/base');

const MAX_ITERATIONS = 6;

const EnableSceneClustering = false;

class StateShotsToScenes extends BaseState {
  static opSupported(op) {
    return op === 'StateShotsToScenes';
  }

  get data() {
    return this.stateData.data;
  }

  get structural() {
    return this.data.structural;
  }

  get uuid() {
    return this.stateData.uuid;
  }

  async process() {
    try {
      const structural = this.structural;
      const {
        bucket,
        key,
        framerate,
        timeCodeFirstFrame,
        copyFromSource,
        frameExtraction: {
          framePrefix,
          embeddings: embeddingsJson,
          similarity: similarityJson,
          framesToShots: framesToShotsJson,
        },
        diarisation,
        loudness,
        filterSettings,
      } = structural;

      const {
        maxTimeDistance = MAXTIMEDISTANCE,
        minFrameSimilarity = MINFRAMESIMILARITY,
      } = filterSettings;

      if (structural.startTime === undefined) {
        structural.startTime = Date.now();
      }

      const outputs = {};

      let promises = [];

      const audioMetadata = [];
      if ((loudness || {}).output) {
        audioMetadata.push(['loudnesses', join(loudness.prefix, loudness.output)]);
      }
      if ((diarisation || {}).pauseOutput) {
        audioMetadata.push(['pauseTimestamps', join(diarisation.prefix, diarisation.pauseOutput)]);
      }

      for (const [field, key] of audioMetadata) {
        promises.push(download(bucket, key)
          .then((res) => {
            outputs[field] = JSON.parse(res);
          }));
      }

      for (const [field, name] of [['frameEmbeddings', embeddingsJson], ['similarity', similarityJson], ['framesToShots', framesToShotsJson]]) {
        promises.push(download(bucket, join(framePrefix, name))
          .then((res) => {
            outputs[field] = JSON.parse(res);
          }));
      }

      await Promise.all(promises);

      const {
        frameEmbeddings,
        similarity,
        framesToShots,
        loudnesses,
        pauseTimestamps = [],
      } = outputs;

      // get proxy video stream information
      let videoInfo = _probeVideoStream(bucket, key);

      const frameMap = {};
      for (const frame of frameEmbeddings.frames) {
        frameMap[String(frame.frameNum)] = frame;
      }

      if (loudnesses && pauseTimestamps) {
        tagAudioMetadataToFrames(frameEmbeddings.frames, loudnesses, pauseTimestamps);
        tagAudioMetadataToShots(frameMap, framesToShots);
      }

      // generate scenes using cluster logic
      if (EnableSceneClustering) {
        await _scenesFromClusters(bucket, framePrefix, frameEmbeddings);
      }

      const shotsToScenes = groupShotsToScenes(
        frameEmbeddings.frames,
        framesToShots,
        similarity,
        minFrameSimilarity,
        maxTimeDistance
      );

      let updatedFrames = [];

      for (const scene of shotsToScenes) {
        for (const shot of scene.shots) {
          updatedFrames = updatedFrames.concat(shot.frames);
          delete shot.frames;
        }
      }

      updatedFrames.sort((a, b) =>
        a.frameNum - b.frameNum);
      frameEmbeddings.frames = updatedFrames;

      promises = [];
      for (const [name, data] of [[JSON_SHOTSTOSCENES, shotsToScenes], [embeddingsJson, frameEmbeddings]]) {
        promises.push(uploadFile(bucket, framePrefix, name, data));
      }
      await Promise.all(promises);

      structural.embeddings = embeddingsJson;
      structural.similarity = similarityJson;
      structural.framesToShots = framesToShotsJson;
      structural.shotsToScenes = JSON_SHOTSTOSCENES;

      videoInfo = await videoInfo;

      const numScenes = shotsToScenes.length;
      let nIterations = Math.round(numScenes / 6);
      nIterations = Math.min(nIterations, MAX_ITERATIONS);

      const uuid = this.uuid;
      const iterators = [];
      for (let i = 0; i < nIterations; i += 1) {
        iterators.push({
          uuid,
          bucket,
          key,
          framePrefix,
          similarity: similarityJson,
          embeddings: embeddingsJson,
          framesToShots: framesToShotsJson,
          shotsToScenes: JSON_SHOTSTOSCENES,
          framerate,
          timeCodeFirstFrame,
          copyFromSource,
          videoInfo,
          filterSettings,
          nIterations,
        });
      }

      const {
        data,
      } = this.stateData;
      data.iterators = iterators;

      return this.stateData;
    } catch (e) {
      console.error(e);
      throw e;
    }
  }
}

async function _probeVideoStream(bucket, key) {
  const url = await getSignedUrl({ bucket, key });

  const streamInfo = await probeStream(url);

  const {
    streams,
  } = streamInfo;

  let videoInfo = {};

  for (const stream of streams) {
    const {
      codec_type: codecType,
      field_order: fieldOrder = 'progressive',
      width,
      height,
    } = stream;

    if (codecType !== 'video') {
      continue;
    }

    let {
      sample_aspect_ratio: pixelAspectRatio = '1',
      display_aspect_ratio: displayAspectRatio = '1',
      coded_width: codedWidth = width,
      coded_height: codedHeight = height,
    } = stream;

    const progressive = fieldOrder.toLowerCase() === 'progressive';
    pixelAspectRatio = toFraction(pixelAspectRatio);
    displayAspectRatio = toFraction(displayAspectRatio);

    videoInfo = {
      codedWidth,
      codedHeight,
      pixelAspectRatio,
      displayAspectRatio,
      progressive,
    };
  }

  return videoInfo;
}

async function _scenesFromClusters(bucket, framePrefix, frameEmbeddings) {
  const frames = frameEmbeddings.frames.filter((frame) => frame.clusterId !== undefined);
  frames.sort((a, b) => a.clusterId - b.clusterId);

  let clusters = [];
  let curCluster = [frames[0]];
  for (let i = 1; i < frames.length; i += 1) {
    const pre = curCluster[curCluster.length - 1];
    const cur = frames[i];
    if (pre.clusterId === cur.clusterId) {
      curCluster.push(cur);
      continue;
    }
    clusters.push(curCluster);
    curCluster = [cur];
  }

  if (curCluster.length) {
    clusters.push(curCluster);
  }

  const scenes = [];
  for (let i = 0; i < clusters.length; i += 1) {
    const cluster = clusters[i].flat(1);
    cluster.sort((a, b) => a.frameNum - b.frameNum);
    for (const frame of cluster) {
      frame.clusterId = i;
    }
    clusters[i] = cluster;

    const frame0 = cluster[0];
    const frameN = cluster[cluster.length - 1];
    scenes.push({
      clusterId: i,
      frameRange: [frame0.frameNum, frameN.frameNum],
      timestampRange: [frame0.timestampMillis, frameN.timestampMillis],
    });
  }

  if (debugLocally()) {
    let clusterId = 0;
    for (const cluster of clusters) {
      await _storeClusterGroup(bucket, framePrefix, cluster, clusterId++, '_scenesFromClusters');
    }
  }

  return scenes;
}

async function _storeClusterGroup(bucket, framePrefix, frames, sceneId, dir = '_clusters') {
  const dimension = [160, 90];
  let nCol = 12;
  let nRow = 1;
  if (frames.length <= nCol) {
    nCol = frames.length;
  } else {
    nRow = Math.ceil(frames.length / nCol);
  }

  const gridImage = await imageFromScratch(nCol * dimension[0], nRow * dimension[1]);

  const duped = frames.slice();
  for (let row = 0; row < nRow; row += 1) {
    for (let col = 0; col < nCol; col += 1) {
      const frame = duped.shift();

      if (frame === undefined) {
        break;
      }

      let image = await imageFromS3(bucket, join(framePrefix, frame.name));
      image = image.resize(...dimension);
      gridImage.blit(image, col * dimension[0], row * dimension[1]);
    }
  }

  // draw border lines
  drawGrid(gridImage, nRow, nCol);

  await gridImage.writeAsync(join(dir, `${sceneId}.jpg`));
}

module.exports = StateShotsToScenes;
