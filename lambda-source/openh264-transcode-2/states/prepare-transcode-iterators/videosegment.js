// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const SEGMENTDURATION = 600; // 10mins
const MINDURATION = 60; // 1min

function _buildVideoCodec(streaminfo) {
  const framerate = streaminfo.getFramerateFraction();
  const gopsize = Math.round((framerate[0] * 2) / framerate[1]);
  return {
    'c:v': 'libopenh264',
    'profile:v': 'high',
    'b': 1500000,
    'g': gopsize,
  };
}

function _buildVideoSegmentCommand(streaminfo, settings = {}) {
  // video filter spec
  let filter_complex = [];

  const progressive = streaminfo.videoIsProgressive();
  if (!progressive) {
    filter_complex.push('yadif');
  }

  // reset PTS to start at 0
  filter_complex.push('setpts=PTS-STARTPTS');

  // crop input?
  const cropXY = streaminfo.getCropSettings(settings);
  if (cropXY[0] > 0 || cropXY[1] > 0) {
    filter_complex.push(`crop=in_w-${cropXY[0]}:in_h-${cropXY[1]}`);
  }

  // scale output?
  const dspDim = streaminfo.getDisplayDimension();
  const scaled = streaminfo.getScaleDimension();
  if (scaled[0] !== dspDim[0] || scaled[1] !== dspDim[1] || cropXY[0] > 0 || cropXY[1] > 0) {
    filter_complex.push(`scale=${scaled[0]}x${scaled[1]}`);
  }

  filter_complex = filter_complex.join(',');

  // input mapping
  const videostream = streaminfo.videostream;
  const inmap = videostream.mapId;

  // video codec spec
  const codec = _buildVideoCodec(streaminfo);
  const ext = '.mp4';
  const pix_fmt = 'yuv420p';

  // filter complex
  if (filter_complex.length === 0) {
    return { inmap, codec, ext };
  }

  const outmap = '[vout]';
  filter_complex = `[${inmap}]${filter_complex}${outmap}`;

  return { filter_complex, outmap, codec, pix_fmt, ext };
}

function _buildSeekCommands(streaminfo) {
  const totalDuration = streaminfo.getDurationInMs() / 1000;
  const framerate = streaminfo.getFramerateFraction();

  const segmentDuration = SEGMENTDURATION;

  const framesPerSegment = Math.floor((segmentDuration * framerate[0]) / framerate[1]);
  const fastSeekPad = 5;
  let startTime = 0;
  const commands = [];

  const totalFrames = Math.ceil((totalDuration * framerate[0]) / framerate[1]);
  let fastSeekFramePad = Math.floor(fastSeekPad * framerate[0] / framerate[1]);

  let startFrame = startTime;
  while (startFrame < totalFrames) {
    let fastSeekFrame = Math.max(startFrame - fastSeekFramePad, 0);
    let accurateSeekFrame = startFrame - fastSeekFrame;

    const fastSeekTime = (fastSeekFrame * framerate[1]) / framerate[0];
    const accurateSeek = (accurateSeekFrame * framerate[1]) / framerate[0];
    const duration = (framesPerSegment * framerate[1]) / framerate[0];

    commands.push({
      fastss: fastSeekTime.toFixed(6),
      ss: accurateSeek.toFixed(6),
      t: duration.toFixed(6),
      vframes: framesPerSegment,
    });
    startFrame += framesPerSegment;
  }

  // merge the last iterator to the previous if is less than 3 minutes!
  if (commands.length > 1) {
    let lastCommand = commands[commands.length - 1];
    let { vframes, fastss } = lastCommand;

    let duration = totalDuration - Number(fastss);
    if (duration <= MINDURATION) {
      commands.pop();
      // merge to previous
      lastCommand = commands[commands.length - 1];
      duration = Number(lastCommand.t) + MINDURATION;
      lastCommand.t = duration.toFixed(6);
      lastCommand.vframes += vframes;
    }
  }

  return commands;
}

function buildVideoSegmentCommands(streaminfo, settings) {
  const videoCommand = _buildVideoSegmentCommand(streaminfo, settings);
  const seekCommands = _buildSeekCommands(streaminfo);

  return { videoCommand, seekCommands };
}

module.exports = {
  buildVideoSegmentCommands,
};
