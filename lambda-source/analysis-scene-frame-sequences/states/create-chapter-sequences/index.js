// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
} = require('node:path');
const {
  CommonUtils: {
    download,
    uploadFile,
  },
  JimpHelper: {
    MIME_JPEG,
    imageFromS3,
    imageFromScratch,
  },
} = require('core-lib');
const BaseState = require('../shared/base');

const MAX_FRAMESEQUENCE_IMAGES = 20;
// https://docs.anthropic.com/en/docs/build-with-claude/vision#evaluate-image-size
const MAX_IMAGE_WXH = [1456, 1456];
const TILE_WXH = [284, 160]; // [364, 204];
const BORDER_SIZE = 2;

class StateCreateChapterSequences extends BaseState {
  static opSupported(op) {
    return op === 'StateCreateChapterSequences';
  }

  async process() {
    try {
      const {
        itemId,
        itemData,
      } = this.stateData;
      const {
        bucket,
        prefix,
        name,
        embeddings: embeddingsKey,
        nIterations,
      } = itemData;

      const frameEmbeddings = await download(bucket, join(prefix, embeddingsKey))
        .then((res) =>
          JSON.parse(res));

      const chapters = await download(bucket, join(prefix, name))
        .then((res) =>
          JSON.parse(res));

      const toBeProcessed = [];

      const responseData = [];
      for (let i = itemId; i < chapters.length; i += nIterations) {
        toBeProcessed.push(chapters[i]);
      }

      let lastIdx = 0;
      for (const chapter of toBeProcessed) {
        const {
          chapter: chapterId,
          frameRange: [fmin, fmax],
        } = chapter;

        console.log(`PROCESSING Chapter ${chapterId}`);

        let chapterFrames = [];
        for (lastIdx; lastIdx < frameEmbeddings.frames.length; lastIdx += 1) {
          const frame = frameEmbeddings.frames[lastIdx];
          if (frame.frameNum < fmin) {
            continue;
          }
          if (frame.frameNum > fmax) {
            break;
          }
          chapterFrames.push(frame);
        }

        // limit it to one grid (5x9) image per chapter
        chapterFrames = _getEquallyDistributedSubset(chapterFrames, 45);

        let promises = [];
        let sequenceImages = await _tileImages(bucket, prefix, chapterFrames);

        for (const sequenceImage of sequenceImages) {
          promises.push(sequenceImage.getBufferAsync(MIME_JPEG));
        }
        sequenceImages = await Promise.all(promises);

        promises = [];
        for (let i = 0; i < sequenceImages.length; i += 1) {
          const jpeg = `C${String(chapterId).padStart(3, '0')}_${String(i).padStart(3, '0')}.jpg`;
          promises.push(uploadFile(bucket, join(prefix, 'chapters'), jpeg, sequenceImages[i])
            .then(() =>
              join('chapters', jpeg)));
        }
        sequenceImages = await Promise.all(promises);
        responseData.push({
          chapter: chapterId,
          sequenceImages,
        });
      }

      return responseData;
    } catch (e) {
      console.log(e);
      throw e;
    }
  }
}

async function _tileImages(
  bucket,
  prefix,
  frames,
  maxFrameSequenceImages = MAX_FRAMESEQUENCE_IMAGES
) {
  if (!frames || frames.length === 0) {
    return [];
  }

  // check the image size and orientation
  const key = join(prefix, frames[0].name);
  const image = await imageFromS3(bucket, key);

  const imgW = image.bitmap.width;
  const imgH = image.bitmap.height;

  let factor = TILE_WXH[0] / imgW;

  // Portrait mode?
  if (imgH > imgW) {
    factor = TILE_WXH[0] / imgH;
  }

  const tileW = Math.round((factor * imgW) / 2) * 2;
  const tileH = Math.round((factor * imgH) / 2) * 2;

  const nCol = Math.floor(MAX_IMAGE_WXH[0] / tileW);
  const nRow = Math.floor(MAX_IMAGE_WXH[1] / tileH);

  // max number of frame images per image
  const numFramesPerImage = nCol * nRow;

  let selectedFrames = frames;

  const maxFramesAllowed = numFramesPerImage * maxFrameSequenceImages;
  if (frames.length > maxFramesAllowed) {
    selectedFrames = _getEquallyDistributedSubset(
      frames,
      maxFramesAllowed
    );

    console.log(`getEquallyDistributedSubset: ${frames.length} -> ${selectedFrames.length} [maxFramesAllowed=${maxFramesAllowed}, ColxRow=${nCol}x${nRow}]`);
  }

  let images = [];

  while (selectedFrames.length > 0) {
    const framesPerImage = selectedFrames.splice(0, numFramesPerImage);

    images.push(_tileImage(
      bucket,
      prefix,
      framesPerImage,
      [tileW, tileH],
      [nCol, nRow]
    ));
  }

  images = await Promise.all(images);

  return images;
}

async function _tileImage(
  bucket,
  prefix,
  frames,
  tileWxH,
  grid,
  borderSize = BORDER_SIZE
) {
  const nCol = grid[0];
  const nRow = Math.ceil(frames.length / nCol);

  const [tileW, tileH] = tileWxH;
  const compositeW = tileW * nCol;
  const compositeH = tileH * nRow;

  const frameSequenceImage = await imageFromScratch(compositeW, compositeH);

  for (let row = 0; row < nRow && frames.length > 0; row += 1) {
    for (let col = 0; col < nCol && frames.length > 0; col += 1) {
      const frame = frames.shift();
      const key = join(prefix, frame.name);

      const frameImage = await imageFromS3(bucket, key)
        .then((img) => {
          const w = tileW - (borderSize * 2);
          const h = tileH - (borderSize * 2);
          return img.resize(w, h);
        });

      const l = col * tileW + borderSize;
      const t = row * tileH + borderSize;
      frameSequenceImage.blit(frameImage, l, t);
    }
  }

  return frameSequenceImage.quality(80);
}

function _getEquallyDistributedSubset(frames, maxFrames) {
  if (!Array.isArray(frames) || !maxFrames) {
    return [];
  }

  const step = Math.ceil(frames.length / maxFrames);

  let selected = [];
  const secondPass = [];

  for (let i = 0; i < frames.length; i += 1) {
    if ((i % step) === 0) {
      selected.push(frames[i]);
    } else {
      secondPass.push(frames[i]);
    }

    if (selected.length >= maxFrames) {
      break;
    }
  }

  // fill the frames by the highest laplacians
  const remaining = maxFrames - selected.length;

  if (remaining > 0) {
    secondPass.sort((a, b) =>
      b.laplacian - a.laplacian);

    selected = selected.concat(secondPass.splice(0, remaining));
  }

  selected.sort((a, b) =>
    a.timestamp - b.timestamp);

  return selected;
}

module.exports = StateCreateChapterSequences;
