// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  CommonUtils: {
    getSignedUrl,
    uploadFile,
    toFraction,
  },
  FFmpegHelper: {
    FRAMECAPTURERATE,
    MAXRESOLUTION,
    probeStream,
  },
} = require('core-lib');

const PROGRESSIVE = 'progressive';

class StreamInfo {
  constructor(streaminfo = {}) {
    const { streams = [] } = streaminfo;

    const videostreams = [];
    const audiostreams = [];
    const datastreams = [];

    for (const stream of streams) {
      const { codec_type } = stream;
      if (codec_type === 'video') {
        videostreams.push(stream);
      } else if (codec_type === 'audio') {
        audiostreams.push(stream);
      } else if (codec_type === 'data') {
        datastreams.push(stream);
      }
    }

    if (videostreams.length === 0) {
      throw new Error('no video stream?');
    }

    this.$streaminfo = streaminfo;
    this.$format = streaminfo.format;

    // adding mapId to all streams
    const allstreams = [
      ['a', audiostreams], ['v', videostreams], ['d', datastreams],
    ];

    for (const [type, avstreams] of allstreams) {
      avstreams.sort((a, b) => a.index - b.index);
      for (let i = 0; i < avstreams.length; i += 1) {
        avstreams[i].mapId = `0:${type}:${i}`;
      }
    }

    // map to the first video alone
    this.$videostream = videostreams[0];
    this.$audiostreams = audiostreams;
    this.$datastreams = datastreams;
  }

  get streaminfo() {
    return this.$streaminfo;
  }

  get format() {
    return this.$format;
  }

  get containerFormat() {
    return (this.format.format_name || '').toLowerCase();
  }

  get videostream() {
    return this.$videostream;
  }

  get audiostreams() {
    return this.$audiostreams;
  }

  get datastreams() {
    return this.$datastreams;
  }

  getDurationInMs() {
    let { duration = 0 } = this.videostream;
    if (duration === 0) {
      duration = this.format.duration;
    }
    if (!duration) {
      throw new Error('video has no duration?');
    }

    const durationMs = Math.round(Number(duration) * 1000);
    return durationMs;
  }

  getScanType() {
    const { field_order = PROGRESSIVE } = this.videostream;
    return field_order.toLowerCase();
  }

  getFramerateFraction() {
    const { avg_frame_rate } = this.videostream;
    return toFraction(avg_frame_rate);
  }

  getFrameCaptureInterval(frameCaptureFraction = FRAMECAPTURERATE) {
    // accurate frame selection
    const framerateFraction = this.getFramerateFraction();
    let frameInterval = (framerateFraction[0] * frameCaptureFraction[1]) / (framerateFraction[1] * frameCaptureFraction[0]);
    frameInterval = Math.round(frameInterval);
    return frameInterval;
  }

  getCropSettings(settings = {}) {
    let { cropX = 0, cropY = 0, keepAR = true } = settings;
    if (cropX === 0 && cropY === 0) {
      return [cropX, cropY];
    }

    let dar = this.getDisplayAspectRatioFraction();
    dar = dar[0] / dar[1];

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

  getDisplayAspectRatioFraction() {
    const { display_aspect_ratio = '16:9' } = this.videostream;
    return toFraction(display_aspect_ratio);
  }

  getPixelAspectRatioFraction() {
    const { sample_aspect_ratio = '1:1' } = this.videostream;
    return toFraction(sample_aspect_ratio);
  }

  getDisplayDimension() {
    let { width, height } = this.videostream;

    const par = this.getPixelAspectRatioFraction();
    width = Math.round((width * par[0]) / par[1]);

    return [width, height];
  }

  getScaleDimension() {
    const [dspW, dspH] = this.getDisplayDimension(this.videostream);

    let scaled = [...MAXRESOLUTION];
    if (dspW === dspH) {
      // square dimension, take the smallest
      const min = Math.min(...scaled);
      scaled = [min, min];
    } else if (dspH > dspW) {
      // Portrait mode, swap the dimension
      scaled = [scaled[1], scaled[0]];
    }

    const factor = Math.min(scaled[0] / dspW, scaled[1] / dspH);
    scaled = [
      (Math.round(dspW * factor) >> 1) << 1,
      (Math.round(dspH * factor) >> 1) << 1,
    ];

    return scaled;
  }

  getMonoTracks() {
    return this.audiostreams.filter((stream) => stream.channels === 1);
  }

  getMultiChannelTracks() {
    return this.audiostreams.filter((stream) => stream.channels > 1);
  }

  videoIsProgressive() {
    const scanType = this.getScanType();
    return scanType === PROGRESSIVE;
  }

  videoIsMPEGTS() {
    return (this.containerFormat.indexOf('mpegts') >= 0);
  }

  getAudioByCodecName(codecName) {
    return this.audiostreams.filter((stream) => stream.codec_name.indexOf(codecName) >= 0);
  }

  async upload(bucket, prefix) {
    return await uploadFile(bucket, prefix, 'streaminfo.json', JSON.stringify(this.streaminfo));
  }
}

async function getStreamInfo(bucket, key) {
  const signed = await getSignedUrl({ bucket, key });
  const streaminfo = await probeStream(signed);
  return new StreamInfo(streaminfo);
}

module.exports = {
  getStreamInfo,
};
