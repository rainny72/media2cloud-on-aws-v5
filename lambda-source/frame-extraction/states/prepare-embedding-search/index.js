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
  SimpleMath: {
    cosim,
  },
  JimpHelper: {
    compareHashes,
    imageFromScratch,
    imageFromS3,
    drawGrid,
  },
  SegmentHelper: {
    JSON_FRAMESTOSHOTS,
    JSON_FRAMESIMILARITY,
    groupFramesToShots,
    agnesClusterFramesToScenes,
  },
} = require('core-lib');
const BaseState = require('../shared/base');

const EnableSceneClustering = false;

class StatePrepareEmbeddingSearch extends BaseState {
  static opSupported(op) {
    return op === 'StatePrepareEmbeddingSearch';
  }

  get input() {
    return this.stateData.input;
  }

  get proxyBucket() {
    return this.input.destination.bucket;
  }

  get data() {
    return this.stateData.data;
  }

  async process() {
    const bucket = this.proxyBucket;
    const { iterators } = this.data;

    iterators.sort((a, b) =>
      a.itemId - b.itemId);

    let totalTitanApiCount = 0;
    let totalDurationInOut = [];
    let totalFrames = [];

    for (const iterator of iterators) {
      const {
        itemId,
        output: { framePrefix },
        embeddings: embeddingsJson,
        titanApiCount,
      } = iterator;

      const frameEmbeddings = await download(bucket, join(framePrefix, embeddingsJson))
        .then((res) => {
          const parsed = JSON.parse(res);
          // patching the prefix to the name field...
          for (const frame of parsed.frames) {
            frame.name = join(String(itemId), frame.name);
          }
          return parsed;
        });

      if (titanApiCount) {
        totalTitanApiCount += titanApiCount;
      }
      totalDurationInOut = totalDurationInOut.concat(frameEmbeddings.durationInOut);
      totalFrames = totalFrames.concat(frameEmbeddings.frames);
    }

    const t0 = Date.now();

    // update duration in/out in milliseconds
    totalDurationInOut = [
      Math.round(Math.min(...totalDurationInOut)),
      Math.round(Math.max(...totalDurationInOut)),
    ];

    // resorting frames, compute hashDistance and embedSimilarity
    totalFrames.sort((a, b) => a.frameNum - b.frameNum);
    for (let i = 0; i < totalFrames.length; i += 1) {
      const cur = totalFrames[i];
      const nex = totalFrames[i + 1];

      if (nex === undefined) {
        continue;
      }

      if (cur.frameNum >= nex.frameNum) {
        throw new Error(`incorrect frame order: ${cur.frameNum} >= ${nex.frameNum}`);
      }

      if (cur.knownType) {
        console.log(`Frame#${cur.frameNum}: ${cur.knownType}`);
      }

      try {
        cur.hashDistance = compareHashes(cur.hash, nex.hash);
        cur.embedSimilarity = cosim(cur.embedding, nex.embedding);
      } catch (e) {
        console.log(`Fail to compute distance and similarity. Frame#${cur.frameNum} and Frame#${nex.frameNum}`);
        console.log(e);
        throw e;
      }
    }

    const {
      output: { prefix: framePrefix },
      embeddings: embeddingsJson,
      imageWxH,
      filterSettings,
    } = iterators[0];

    const groups = groupFramesToShots(totalFrames, filterSettings.minFrameSimilarity);
    for (const group of groups) {
      group.sort((a, b) => a.frameNum - b.frameNum);
    }

    //////////////////////////////////////////
    // Adding cluster id
    if (EnableSceneClustering) {
      await _tagClusterIdToFrames(bucket, framePrefix, groups, filterSettings);
    }
    //////////////////////////////////////////

    const framesToShots = [];

    for (const group of groups) {
      let timestampRange = [];
      let frameRange = [];
      const shotId = framesToShots.length;

      for (const frame of group) {
        frame.shot = shotId;
        timestampRange.push(frame.timestampMillis);
        frameRange.push(frame.frameNum);
      }

      const knownType = group[0].knownType;
      timestampRange = [Math.min(...timestampRange), Math.max(...timestampRange)];
      frameRange = [Math.min(...frameRange), Math.max(...frameRange)];

      const shot = {
        shot: shotId,
        knownType,
        timestampRange,
        frameRange,
      };

      framesToShots.push(shot);
    }

    console.log(`elapsed = ${Date.now() - t0}ms`);

    const merged = {
      durationInOut: totalDurationInOut,
      imageWxH,
      frames: totalFrames,
      titanApiCount: totalTitanApiCount,
    }

    const promises = [];

    for (const [name, data] of [[embeddingsJson, merged], [JSON_FRAMESTOSHOTS, framesToShots]]) {
      promises.push(uploadFile(bucket, framePrefix, name, data));
    }
    await Promise.all(promises);

    const numFrames = totalFrames.length;
    const numShots = framesToShots.length;

    // prepare the next state: create shot sequence images
    const data = this.data;

    data.frameExtraction = {
      framePrefix,
      framesToShots: JSON_FRAMESTOSHOTS,
      embeddings: embeddingsJson,
      numFrames,
      numShots,
      titanApiCount: totalTitanApiCount,
    };

    const specs = [
      [embeddingsJson, JSON_FRAMESIMILARITY, 'frame'],
      // [framesToShotsJson, JSON_SHOT_SIMILARITY, 'shot'],
    ]

    data.iterators = [];
    for (const [embeddings, similarity, level] of specs) {
      data.iterators.push({
        bucket,
        prefix: framePrefix,
        embeddings,
        similarity,
        level,
      });
    }

    console.log(JSON.stringify(data.iterators, null, 2));
    return this.setCompleted();
  }

  setCompleted() {
    this.stateData.status = Completed;
    return this.stateData;
  }
}

async function _tagClusterIdToFrames(bucket, framePrefix, shotGroups, filterSettings) {
  const framesToClusters = await agnesClusterFramesToScenes(shotGroups, filterSettings);

  for (let i = 0; i < framesToClusters.length; i += 1) {
    const cluster = framesToClusters[i];
    for (const frame of cluster) {
      frame.clusterId = i;
    }
  }

  if (debugLocally()) {
    let clusterId = 0;
    for (const cluster of framesToClusters) {
      await _storeClusterGroup(bucket, framePrefix, cluster, clusterId++, '_framesToClusters');
    }
  }

  return framesToClusters;
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

module.exports = StatePrepareEmbeddingSearch;
