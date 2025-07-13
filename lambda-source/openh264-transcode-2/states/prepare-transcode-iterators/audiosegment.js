// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const SEGMENTDURATION = 1800; // 30mins
const MINDURATION = 180; // 3mins

// FLAC stereo output
function _buildAudioCodec(streaminfo) {
  streaminfo;
  return {
    'c:a': 'flac',  // 'pcm_s16le',
    'ac': 2,
    'ar': 44100,
  };
}

function _makeChannelConfiguration(tracks = []) {
  const filterComplex = [];

  let inmap;
  // multi-channel track or single mono track
  if (tracks.length === 1) {
    inmap = `[${tracks[0].mapId}]`;
  } else {
    // multi-mono tracks
    const l = tracks[0];
    const r = tracks[1];

    inmap = [l, r].map((trk) => `[${trk.mapId}]`);
    inmap = inmap.join('');

    filterComplex.push('amerge=inputs=2');
  }

  const outmap = '[stereo]';
  const filter_complex = `${inmap}${filterComplex.join(',')}${outmap}`;

  return { filter_complex, outmap };
}

function _demuxAudio(track) {
  const { mapId: inmap } = track;
  const codec = { 'c': 'copy' };
  const ext = '.mp4';

  return { inmap, codec, ext };
}

function _buildAudioSegmentCommand(streaminfo, settings = {}) {
  settings;

  // demux only
  const aacTracks = streaminfo.getAudioByCodecName('aac');
  if (aacTracks.length > 0) {
    return _demuxAudio(aacTracks[0]);
  }

  const codec = _buildAudioCodec(streaminfo);
  const ext = '.flac';

  // favor multichannel
  const multiChannelTracks = streaminfo.getMultiChannelTracks();
  if (multiChannelTracks.length > 0) {
    multiChannelTracks.sort((a, b) => a.index - b.index);
    const channelMapping = _makeChannelConfiguration([multiChannelTracks[0]]);
    return { ...channelMapping, codec, ext };
  }

  const monoTracks = streaminfo.getMonoTracks();
  if (monoTracks.length > 0) {
    monoTracks.sort((a, b) => a.index - b.index);
    const channelMapping = _makeChannelConfiguration(monoTracks);
    return { ...channelMapping, codec, ext };
  }

  // no audio track?
  return undefined;
}

function _buildSeekCommands(streaminfo) {
  const totalDuration = streaminfo.getDurationInMs() / 1000;
  const fastSeekPad = 3;
  let startTime = 0;
  const commands = [];

  while (startTime < totalDuration) {
    const fastseekTime = Math.max(startTime - fastSeekPad, 0);
    const accurateSeek = startTime - fastseekTime;
    const duration = SEGMENTDURATION;

    commands.push({
      fastss: fastseekTime.toFixed(6),
      ss: accurateSeek.toFixed(6),
      t: duration.toFixed(6),
    });
    startTime += duration;
  }

  // merge the last iterator to the previous if is less than 3 minutes!
  if (commands.length > 1) {
    let lastCommand = commands[commands.length - 1];
    let duration = totalDuration - Number(lastCommand.fastss);
    if (duration <= MINDURATION) {
      commands.pop();
      // merge to previous
      lastCommand = commands[commands.length - 1];
      duration = Number(lastCommand.t) + MINDURATION;
      lastCommand.t = duration.toFixed(6);
    }
  }

  return commands;
}

function buildAudioSegmentCommands(streaminfo, settings) {
  let seekCommands = [];

  const audioCommand = _buildAudioSegmentCommand(streaminfo, settings);
  if (audioCommand !== undefined) {
    if (audioCommand.ext === '.mp4') {
      seekCommands.push({});
    } else {
      seekCommands = _buildSeekCommands(streaminfo);
    }
  }

  return { audioCommand, seekCommands };
}

module.exports = {
  buildAudioSegmentCommands,
};
