// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  readdir,
} = require('node:fs/promises');
const {
  createReadStream,
} = require('node:fs');
const {
  join,
  parse,
} = require('node:path');
const {
  CommonUtils: {
    getSignedUrl,
    uploadFile,
    uploadStream,
  },
  TimecodeUtils: {
    framerateToEnum,
    fromTimecode,
    toTimecode,
    isDropFrame,
  },
  FFmpegHelper: {
    extractFrames,
    createTempDir,
    removeTempDir,
  },
  SegmentHelper: {
    JSON_FRAMEEMBEDDINGS,
  },
} = require('core-lib');
const BaseState = require('../shared/base');

const UPLOAD_CONCURRENCY = 50;

class StateExtractFrames extends BaseState {
  static opSupported(op) {
    return op === 'StateExtractFrames';
  }

  async process() {
    let tmpDir;

    try {
      const {
        itemId,
        itemData,
      } = this.stateData;

      const {
        input: {
          bucket,
          key: videoKey,
        },
        output: {
          bucket: outBucket,
          prefix: outPrefix,
        },
        durationInOut,
        streamInfo: {
          framerateFraction,
          timeCodeFirstFrame,
        },
        frameCaptureRate,
        imageWxH,
        ffOptions: { ss, to, vf },
      } = itemData;

      tmpDir = await createTempDir();
      console.log(`tmpDir = ${tmpDir}`);

      // ffmpeg -ss 600.000 -i input_video -frames:v single_frame.jpg
      // ffmpeg -ss 600.000 -to 601.000 -i input_video every_frame%03d.jpg
      let cmdOpts = [];

      // combine both fast seek and accurate seek
      let fastSS;
      let accurateSS = ss;
      let accurateTO = to;

      if (ss && ss > 5000) {
        // fast seek to 2s before the actual frame
        fastSS = ss - 3000;
        accurateSS = 3000;
        accurateTO = to - ss + 3000;
      }

      // fast seek option
      if (fastSS && fastSS > 0) {
        cmdOpts = cmdOpts.concat(['-ss', (fastSS / 1000).toFixed(3)]);
      }

      // input file
      const url = await getSignedUrl({
        bucket,
        key: videoKey,
      });
      cmdOpts = cmdOpts.concat(['-i', url]);

      // accurate seek option
      if (accurateSS && accurateSS > 0) {
        cmdOpts = cmdOpts.concat(['-ss', (accurateSS / 1000).toFixed(3)]);
      }

      // to option
      if (accurateTO && accurateTO > 0) {
        cmdOpts = cmdOpts.concat(['-to', (accurateTO / 1000).toFixed(3)]);
      }

      // video filters
      if (vf !== undefined && vf.length > 0) {
        cmdOpts = cmdOpts.concat(['-vf', vf.join(',')]);
      }

      // output settings
      cmdOpts = cmdOpts.concat([
        '-fps_mode', 'passthrough',
        '-qmin', String(1),
        '-q:v', String(1),
      ]);

      let outputName = '%07d.jpg';
      const outputs = join(tmpDir, outputName);
      cmdOpts.push(outputs);

      // run ffmpeg
      const t0 = Date.now();
      await extractFrames(cmdOpts);
      const t1 = Date.now();
      console.log(`extractFrames: elapsed = ${t1 - t0}ms`);

      // post process
      let frameInterval = (framerateFraction[0] * frameCaptureRate[1]) / (framerateFraction[1] * frameCaptureRate[0]);
      frameInterval = Math.round(frameInterval);

      // 23.976 - rounding won't work, 1 frame shorter. It requires ceiling of the number.
      let frameOffset = ((durationInOut[0] * framerateFraction[0]) / framerateFraction[1]) / 1000;
      frameOffset = Math.ceil(frameOffset);

      const dropFrame = isDropFrame(timeCodeFirstFrame);
      const enumFPS = framerateToEnum(framerateFraction);
      const timecodeFrameOffset = fromTimecode(enumFPS, timeCodeFirstFrame);

      const iteratorPrefix = join(outPrefix, String(itemId));

      let promises = [];
      const frames = [];

      const files = await readdir(tmpDir);

      for (const file of files) {
        if (promises.length >= UPLOAD_CONCURRENCY) {
          console.log(`Batch uploading....${promises.length}`);
          await Promise.all(promises);
          promises = [];
        }

        const { name, ext } = parse(file);
        if (ext !== '.jpg') {
          continue;
        }

        const frameNum = frameOffset + ((Number(name) - 1) * frameInterval);
        let timestampMillis = (frameNum * framerateFraction[1] * 1000) / framerateFraction[0];
        // need to floor the timestamp
        timestampMillis = Math.floor(timestampMillis);
        const smpteTimecode = toTimecode(enumFPS, (timecodeFrameOffset + frameNum), dropFrame)[0];
        const jpegName = `${frameNum}.jpg`;

        const stream = createReadStream(join(tmpDir, file));
        promises.push(uploadStream(outBucket, join(iteratorPrefix, jpegName), stream)
          .then(() => {
            frames.push({
              frameNum,
              timestampMillis,
              smpteTimecode,
              name: jpegName,
            });
          }));
      }

      if (promises.length > 0) {
        await Promise.all(promises);
        promises = [];
      }

      frames.sort((a, b) =>
        Number(a.frameNum) - Number(b.frameNum));

      console.log(`Extracted (${frames.length} images): ${JSON.stringify(frames, null, 2)}`);

      const frameEmbeddings = {
        durationInOut,
        imageWxH,
        frames,
        titanApiCount: 0,
      };

      await uploadFile(outBucket, iteratorPrefix, JSON_FRAMEEMBEDDINGS, frameEmbeddings);
      itemData.output.framePrefix = iteratorPrefix;
      itemData.embeddings = JSON_FRAMEEMBEDDINGS;

      return this.setCompleted();
    } catch (e) {
      console.error(e);
      throw e;
    } finally {
      console.log(`finally: removeTempDir: ${tmpDir}`);
      await removeTempDir(tmpDir);
    }
  }

  setCompleted() {
    return this.stateData;
  }
}

module.exports = StateExtractFrames;
