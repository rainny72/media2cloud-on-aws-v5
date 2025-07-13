// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
  parse,
} = require('node:path');
const {
  StateData: {
    Statuses: {
      Completed,
    },
  },
  SegmentHelper: {
    MAXPIXELTHRESHOLD,
    MINCOVERAGEPERCENTAGE,
    MINFRAMESIMILARITY,
    MAXTIMEDISTANCE,
  },
  FFmpegHelper: {
    FRAMECAPTURERATE,
    MAXRESOLUTION,
    FRAME_PREFIX,
    probeStream,
  },
  CommonUtils: {
    getSignedUrl,
    listObjects,
    toFraction,
  },
} = require('core-lib');
const BaseState = require('../shared/base');

const SCAN_TYPE_PROGRESSIVE = 'Progressive';
const DURATION_PER_ITERATION = 20 * 60 * 1000;

class StatePrepareFrameIterators extends BaseState {
  static opSupported(op) {
    return op === 'StatePrepareFrameIterators';
  }

  get uuid() {
    return this.stateData.uuid;
  }

  get input() {
    return this.stateData.input;
  }

  get ingestBucket() {
    return this.input.bucket;
  }

  get ingestKey() {
    return this.input.key;
  }

  get destination() {
    return this.input.destination;
  }

  get proxyBucket() {
    return this.destination.bucket;
  }

  get proxyPrefix() {
    return this.destination.prefix;
  }

  get aiOptions() {
    return this.input.aiOptions;
  }

  get data() {
    return this.stateData.data;
  }

  get mediainfo() {
    return this.data.mediainfo;
  }

  get transcode() {
    return this.data.transcode;
  }

  async process() {
    const proxyLocation = await this.getProxyLocation();
    const videostreaminfo = await this.probeVideoStream(proxyLocation);

    const { avg_frame_rate } = videostreaminfo;
    const framerateFraction = toFraction(avg_frame_rate);

    const { duration } = videostreaminfo;
    const durationMsec = Math.round(Number(duration) * 1000);

    // Mesh all filter settings
    let filterSettings = {};
    const { filters = {} } = this.aiOptions || {};
    for (const filter of Object.values(filters)) {
      filterSettings = { ...filterSettings, ...filter };
    }

    const displayAspectRatio = this.getDisplayAspectRatioFraction(videostreaminfo);
    const pixelAspectRatio = this.getPixelAspectRatioFraction(videostreaminfo);
    const cropXY = this.getCropSettings(videostreaminfo, filterSettings);
    const scanType = this.getScanType(videostreaminfo);
    const [srcDim, dspDim, scaled] = this.getVideoDimensions(videostreaminfo);

    const vfilters = [];

    // need deinterlacing
    if (scanType.toLowerCase() !== SCAN_TYPE_PROGRESSIVE.toLowerCase()) {
      vfilters.push('yadif');
    }

    const frameInterval = this.getFrameCaptureInterval(framerateFraction, FRAMECAPTURERATE);
    vfilters.push(`select=not(mod(n\\,${frameInterval}))`);

    // input cropping
    if (cropXY[0] > 0 || cropXY[1] > 0) {
      vfilters.push(`crop=in_w-${cropXY[0]}:in_h-${cropXY[1]}`);
    }

    // scale output?
    if (scaled[0] !== dspDim[0] || scaled[1] !== dspDim[1] || cropXY[0] > 0 || cropXY[1] > 0) {
      vfilters.push(`scale=${scaled[0]}x${scaled[1]}`);
    }

    // common parameters
    const input = { ...proxyLocation };

    const output = {
      bucket: this.proxyBucket,
      prefix: join(this.proxyPrefix, FRAME_PREFIX),
    };

    // Timecode to use the source video!!!
    let timeCodeFirstFrame = '00:00:00:00';
    const { timecode = {} } = this.mediainfo || {};
    if (timecode.timeCodeFirstFrame !== undefined) {
      timeCodeFirstFrame = timecode.timeCodeFirstFrame;
    }

    const {
      maxPixelThreshold = MAXPIXELTHRESHOLD,
      minCoveragePercentage = MINCOVERAGEPERCENTAGE,
      minFrameSimilarity = MINFRAMESIMILARITY,
      maxTimeDistance = MAXTIMEDISTANCE,
    } = filterSettings;

    // number of iterators
    let { durationPerFrameExtraction = 0 } = filterSettings;
    if (durationPerFrameExtraction === 0) {
      durationPerFrameExtraction = DURATION_PER_ITERATION;
    }
    const nIterations = Math.ceil(durationMsec / durationPerFrameExtraction);

    const iterators = [];
    for (let i = 0; i < nIterations; i += 1) {
      const durationIn = i * durationPerFrameExtraction;
      let durationOut = durationIn + durationPerFrameExtraction;
      durationOut = Math.min(durationOut, durationMsec);
      iterators.push({
        input,
        output,
        durationInOut: [durationIn, durationOut],
        streamInfo: {
          scanType,
          pixelAspectRatio,
          displayAspectRatio,
          framerateFraction,
          timeCodeFirstFrame,
          srcWxH: srcDim,
          dspWxH: dspDim,
        },
        frameCaptureRate: FRAMECAPTURERATE,
        cropXY,
        imageWxH: scaled,
        ffOptions: {
          ss: durationIn,
          to: durationOut,
          vf: vfilters,
        },
        filterSettings: {
          maxPixelThreshold,
          minCoveragePercentage,
          minFrameSimilarity,
          maxTimeDistance,
        },
      });
    }

    this.data.iterators = iterators;

    return this.setCompleted();
  }

  setCompleted() {
    if (this.data.iterators === undefined) {
      this.data.iterators = [];
    }
    this.stateData.status = Completed;
    return this.stateData;
  }

  async getProxyLocation() {
    const bucket = this.proxyBucket;
    const { output } = this.transcode;

    const response = await listObjects(bucket, output);
    for (const { Key: key } of response.Contents) {
      if (['.mp4', '.mov'].includes(parse(key).ext.toLowerCase())) {
        return { bucket, key };
      }
    }

    throw new Error('No transcoded asset?');
  }

  async probeVideoStream(location) {
    const signed = await getSignedUrl(location);

    const streaminfo = await probeStream(signed);
    for (const stream of streaminfo.streams) {
      const { codec_type } = stream;
      if (codec_type === 'video') {
        return stream;
      }
    }

    throw new Error('No video stream info?');
  }

  getDisplayAspectRatioFraction(videoinfo = {}) {
    const { display_aspect_ratio = '16:9' } = videoinfo;
    return toFraction(display_aspect_ratio);
  }

  getPixelAspectRatioFraction(videoinfo = {}) {
    const { sample_aspect_ratio = '1:1' } = videoinfo;
    return toFraction(sample_aspect_ratio);
  }

  getCropSettings(videoinfo = {}, settings = {}) {
    const { copyFromSource = false } = this.transcode || {};

    // If operate on proxy video, the cropping has been done at the proxy video
    if (copyFromSource === false) {
      return [0, 0];
    }

    let { cropX = 0, cropY = 0, keepAR = true } = settings;
    if (cropX === 0 && cropY === 0) {
      return [cropX, cropY];
    }

    let dar = this.getDisplayAspectRatioFraction(videoinfo);
    dar = dar[0] / dar[1];

    // adjust the cropXY to keep aspect ratio and align to multiplier of 2
    if (keepAR) {
      const cropX2 = cropY * dar;
      if (cropX2 > cropX) {
        cropX = cropX2;
      } else {
        cropY = cropX / dar;
      }
    }

    cropX = Math.round(cropX / 2) * 2;
    cropY = Math.round(cropY / 2) * 2;

    return [cropX, cropY];
  }

  getScanType(videoinfo = {}) {
    const { field_order = SCAN_TYPE_PROGRESSIVE } = videoinfo;
    return field_order;
  }

  getFrameCaptureInterval(framerateFraction, frameCaptureFraction = [1, 1]) {
    // Note: using time interval is not accurate for 23.976 framerate
    // const timeInterval = (FRAMECAPTURERATE[1] / FRAMECAPTURERATE[0]).toPrecision(4);
    // vfilters.push(`select=bitor(gte(t-prev_selected_t\\,${timeInterval})\\,isnan(prev_selected_t))`);

    // accurate frame selection
    let frameInterval = (framerateFraction[0] * frameCaptureFraction[1]) / (framerateFraction[1] * frameCaptureFraction[0]);
    frameInterval = Math.round(frameInterval);
    return frameInterval;
  }

  getVideoDimensions(videoinfo = {}) {
    const { width, height, coded_width, coded_height } = videoinfo;
    const srcDim = [
      Number(width || coded_width),
      Number(height || coded_height),
    ];
    const dspDim = [...srcDim];

    const { copyFromSource = false } = this.transcode || {};
    if (copyFromSource === false) {
      return [srcDim, dspDim, dspDim];
    }

    const par = this.getPixelAspectRatioFraction(videoinfo);
    dspDim[0] = Math.round((srcDim[0] * par[0]) / par[1]);
    dspDim[1] = srcDim[1];

    // scale output
    let scaled = [...MAXRESOLUTION];
    if (dspDim[0] === dspDim[1]) {
      // square dimension, take the smallest
      const min = Math.min(...scaled);
      scaled = [min, min];
    } else if (dspDim[1] > dspDim[0]) {
      // Portrait mode, swap the dimension
      scaled = [scaled[1], scaled[0]];
    }

    const factor = Math.min(scaled[0] / dspDim[0], scaled[1] / dspDim[1]);
    scaled = [
      (Math.round(dspDim[0] * factor) >> 1) << 1,
      (Math.round(dspDim[1] * factor) >> 1) << 1,
    ];

    return [srcDim, dspDim, scaled];
  }
}

module.exports = StatePrepareFrameIterators;
