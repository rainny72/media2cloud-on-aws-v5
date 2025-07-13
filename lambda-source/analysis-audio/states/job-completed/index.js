// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  parse,
  join,
} = require('node:path');
const {
  StateData,
  AnalysisError,
  CommonUtils: {
    download,
    uploadFile,
    debugLocally,
  },
  SimpleGeometry: {
    timeIntersected,
  },
  SegmentHelper: {
    JSON_AUDIOSEGMENTS,
    TYPE_RECAP,
    TYPE_INTRO,
    TYPE_PROGRAMME,
    TYPE_RATING,
    loadModelConfigs,
    getPreferredModel,
  },
  WebVttHelper: {
    parse: parseWebVTT,
  },
} = require('core-lib');
const {
  getDefaultTemplate,
  runConversationAnalysis,
} = require('./runConversationAnalysis');

const {
  Statuses: {
    Completed,
  },
} = StateData;

const {
  ENV_PROXY_BUCKET: ProxyBucket,
  ENV_BEDROCK_MODELLIST_LOCATION: ModelListLocation = '_settings/availablemodels.json',
} = process.env;

// custom prompt template
const CustomPromptTemplate = {
  bucket: ProxyBucket,
  prefix: '_prompt_templates/analysis_audio',
  conversationAnalysis: 'conversationAnalysis.md',
};

class StateJobCompleted {
  static opSupported(op) {
    return op === 'StateJobCompleted';
  }

  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new AnalysisError('stateData not StateData object');
    }
    this.$stateData = stateData;
  }

  get [Symbol.toStringTag]() {
    return 'StateJobCompleted';
  }

  get stateData() {
    return this.$stateData;
  }

  async process() {
    const {
      executionArn,
      executionStartTime,
      input: {
        duration,
        destination: {
          bucket: proxyBucket,
        },
        aiOptions: {
          filters = {},
        },
        audio: {
          key: audioKey,
          diarisation = {},
          transcribe = {},
        },
      },
      data,
    } = this.stateData;

    // mesh all filter settings
    const filterSettings = {};
    for (const category of Object.values(filters)) {
      for (const [k, v] of Object.entries(category)) {
        filterSettings[k] = v;
      }
    }

    let responseData = {
      status: Completed,
      executionArn,
      transcribe,
      ...data,
    };

    const {
      transcribe: { vtt: vttKey },
    } = responseData;

    let promises = [];

    let vtt = '';
    let diarisations;

    promises.push(download(proxyBucket, join(transcribe.prefix, vttKey))
      .then((res) => {
        vtt = res;
      })
      .catch(() =>
        undefined));

    // diarisation is optional
    if ((diarisation || {}).output) {
      promises.push(download(proxyBucket, join(diarisation.prefix, diarisation.output))
        .then((res) => {
          diarisations = JSON.parse(res);
        }));
    }

    await Promise.all(promises);

    // start the inference
    const {
      analyseConversation = true,
    } = filterSettings;

    let conversationAnalysis;
    if (analyseConversation) {
      conversationAnalysis = _inferenceWithTranscript(vtt, duration);
    }
    let audioSegments = _groupAudioSegments(vtt, diarisations);

    conversationAnalysis = await conversationAnalysis;
    audioSegments = _groupConversationAnalysis(audioSegments, conversationAnalysis);

    const prefix = parse(audioKey).dir;
    const name = JSON_AUDIOSEGMENTS;

    await uploadFile(proxyBucket, prefix, name, audioSegments);

    const { genres } = audioSegments;

    responseData.audioSegments = {
      prefix,
      output: name,
      genres,
    };

    responseData.startTime = executionStartTime;
    responseData.endTime = Date.now();

    console.log(JSON.stringify({ audio: responseData }));

    return {
      audio: responseData,
    };
  }
}

async function _inferenceWithTranscript(vtt, duration) {
  // transcript too short or duration less than 1min
  if (!vtt || vtt.length < 1024 || duration < 60000) {
    return undefined;
  }

  // load the template
  const template = await _getUserDefinedTemplate();

  const model = await _getModel('nova-micro');
  model.inferenceConfig.temperature = 0.10;

  return await runConversationAnalysis(model, vtt, template);
}

function _mergeTranscriptAndDiarisations(segments, timestamps) {
  const dialogueGroups = [];

  if (!segments || !segments.length) {
    return dialogueGroups;
  }

  for (const segment of segments) {
    const {
      start: sstart,
      end: send,
    } = segment;

    segment.timestampRange = [sstart, send];
    segment.diarisationGroups = [];

    for (const [dstart, dend] of timestamps) {
      if (dend < sstart) {
        continue;
      }
      if (dstart > send) {
        break;
      }
      if (timeIntersected([sstart, send], [dstart, dend])) {
        segment.diarisationGroups.push([dstart, dend]);
      }
    }
  }

  let groups = [];
  let curGroup = [segments[0]];

  for (let i = 1; i < segments.length; i += 1) {
    const pre = curGroup[curGroup.length - 1];
    const cur = segments[i];
    const preTimeRange = _getTimeRange(pre);
    const curTimeRange = _getTimeRange(cur);
    if (timeIntersected(preTimeRange, curTimeRange)) {
      curGroup.push(cur);
      continue;
    }
    groups.push(curGroup);
    curGroup = [cur];
  }

  if (curGroup.length > 0) {
    groups.push(curGroup);
  }

  for (const group of groups) {
    let diarisationGroups = [];
    const transcripts = [];
    const timestampRange = [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];

    for (const item of group) {
      transcripts.push({
        start: item.start,
        end: item.end,
        transcript: item.transcript,
      });
      const timeRange = _getTimeRange(item);
      timestampRange[0] = Math.min(timestampRange[0], timeRange[0]);
      timestampRange[1] = Math.max(timestampRange[1], timeRange[1]);
      diarisationGroups = diarisationGroups.concat(item.diarisationGroups);
    }

    dialogueGroups.push({
      group: dialogueGroups.length,
      timestampRange,
      transcripts,
      diarisationGroups,
    });
  }

  // remove the diarisationGroups
  for (const dialogue of dialogueGroups) {
    if (dialogue.diarisationGroups.length === 0) {
      dialogue.diarisationTimeRange = [];
    } else {
      dialogue.diarisationTimeRange = [
        dialogue.diarisationGroups[0][0],
        dialogue.diarisationGroups[dialogue.diarisationGroups.length - 1][1],
      ];
    }
    delete dialogue.diarisationGroups;
  }

  console.log(`After merging transcript and diarisations: ${segments.length} -> ${dialogueGroups.length}`);

  return dialogueGroups;
}

function _parseTranscript(transcript) {
  let segments = [];

  if (!transcript) {
    return segments;
  }

  // use vtt for audio segment
  if (typeof transcript === 'string' && transcript.indexOf('WEBVTT') >= 0) {
    const vtt = parseWebVTT(transcript);
    for (const cue of vtt.cues) {
      segments.push({
        start: Math.round(cue.start * 1000),
        end: Math.round(cue.end * 1000),
        transcript: cue.text,
      });
    }
    return segments;
  }

  const {
    results: {
      audio_segments,
    },
  } = transcript;

  for (const segment of audio_segments) {
    segments.push({
      start: Math.round(Number(segment.start_time) * 1000),
      end: Math.round(Number(segment.end_time) * 1000),
      transcript: segment.transcript,
    });
  }

  return segments;
}

function _parseDiarisationTimestamps(diarisations = []) {
  if (!diarisations.length) {
    return [];
  }

  const timestamps = [];
  for (const { start, end } of diarisations) {
    timestamps.push([start, end]);
  }

  const stack = [];
  if (timestamps.length > 0) {
    stack.push(timestamps[0]);
    for (let i = 1; i < timestamps.length; i += 1) {
      const pre = stack[stack.length - 1];
      const cur = timestamps[i];
      if (timeIntersected(pre, cur)) {
        const timestamp = [Math.min(pre[0], cur[0]), Math.max(pre[1], cur[1])];
        stack.pop();
        stack.push(timestamp);
        continue;
      }
      stack.push(cur);
    }
  }

  console.log(`Diarisation timestamp merged: ${timestamps.length} -> ${stack.length}`);

  return stack;
}

function _groupAudioSegments(transcript, diarisations = []) {
  const timestamps = _parseDiarisationTimestamps(diarisations);
  const segments = _parseTranscript(transcript);
  const dialogueGroups = _mergeTranscriptAndDiarisations(segments, timestamps);

  return {
    dialogueGroups,
  };
}

function _getTimeRange(segment) {
  const {
    timestampRange: [sstart, send],
  } = segment;

  const timeRange = [sstart, send];
  for (const [dstart, dend] of segment.diarisationGroups) {
    timeRange[0] = Math.min(timeRange[0], dstart);
    timeRange[1] = Math.max(timeRange[1], dend);
  }

  return timeRange;
}

function _groupConversationAnalysis(audioSegments, conversationAnalysis) {
  const { dialogueGroups } = audioSegments;

  let genres = [];
  let kindOfContent;

  try {
    const {
      response: {
        jsonOutput: { audio_segments, list_of_genres, kind_of_content },
      },
    } = conversationAnalysis;

    genres = list_of_genres;
    kindOfContent = kind_of_content;

    if (Array.isArray(audio_segments)) {
      let topicGroup = 0;

      for (const segment of audio_segments) {
        const {
          start, end, recap_segment, intro_segment, parental_guidance_segment,
        } = segment;

        if ((end - start) <= 0) {
          continue;
        }

        const timeRange = [start, end];

        let segmentType = TYPE_PROGRAMME;
        if (String(parental_guidance_segment) === 'true') {
          segmentType = TYPE_RATING;
        } else if (String(recap_segment) === 'true') {
          segmentType = TYPE_RECAP;
        } else if (String(intro_segment) === 'true') {
          segmentType = TYPE_INTRO;
        }

        for (const group of dialogueGroups) {
          const { timestampRange } = group;
          if (timestampRange[0] > timeRange[1]) {
            break;
          }
          if (timeIntersected(timeRange, timestampRange)) {
            group.segmentType = segmentType;
            group.topicGroup = topicGroup;
          }
        }
        topicGroup += 1;
      }
    }
  } catch (e) {
    e;
  }

  return {
    ...audioSegments,
    conversationAnalysis,
    genres,
    kindOfContent,
  };
}

async function _getModel(name) {
  await loadModelConfigs(ProxyBucket, ModelListLocation);

  return await getPreferredModel(name);
}

async function _getUserDefinedTemplate() {
  let defaultTemplate = getDefaultTemplate();

  if (debugLocally()) {
    return defaultTemplate;
  }

  const {
    bucket, prefix, conversationAnalysis,
  } = CustomPromptTemplate;

  let template = await download(bucket, join(prefix, conversationAnalysis))
    .catch(() => undefined);

  if (template === undefined && defaultTemplate.length > 0) {
    template = defaultTemplate;
    await uploadFile(bucket, prefix, conversationAnalysis, template);
  }

  return template;
}

module.exports = StateJobCompleted;
