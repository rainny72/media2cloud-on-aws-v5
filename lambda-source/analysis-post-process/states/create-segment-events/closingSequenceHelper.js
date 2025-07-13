// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  SegmentHelper: {
    TAG_ABSOLUTESILENT,
  },
  WebVttHelper: {
    compile: toWebVtt,
  },
  CommonUtils: {
    debugLocally,
    toMilliseconds,
  },
} = require('core-lib');

const ONE_MINUTE = 60 * 1000;
const MAX_CUTOFF_MINUTES = 6 * ONE_MINUTE;
const MIN_DURATION_FOR_CUTOFF_LOGIC = 60 * ONE_MINUTE;

const INSTRUCTIONS = `
## Task
Given a list of video scene descriptions (visual cues) that represents the last 5 to 7 minutes of the TV program, please help to identify the end credit sequences of the TV program.

### Video Scene Description List
{{descriptions}}

## Instructions
1. Carefully examine the provided video scene descriptions in WebVTT format.
2. Identify the end credit sequence of the TV program. Follow the guideline below:

### Guidelines
#### EXCLUDE color patterns sequences
#### End credit sequences MUST be longer than 20 seconds
#### MUST include ALL sequences that contain the FOLLOWING prominent, FOREGROUND text OVERLAY:
- CREDITS to the CASTS and FILM CREWS
- PRODUCTION LOGO or COMPANY names
#### Check Next Episode sequence
- When 'NEXT ON' or 'NEXT EPISODE' FOREGROUND text OVERLAY is identified in the video scene sequence, SET is_next_episode_sequence to true.

3. Provide start time of the FIRST video scene identified end credit sequences.
4. Provide end time of the LAST video scene identified end credit sequences.
5. Ensure timestamp precisely capture the start and end time in the provided WebVTT.
6. IF end credit sequence IS NOT identified, SET is_end_credit_sequence to false AND SET start_time AND end_time to 00:00:00.000
7. Provide concise reasoning.

### Response Example
{
  "start_time": "Start Time in HH:MM:SS.mmm format",
  "end_time": "End Time in HH:MM:SS.mmm format",
  "reasoning": "Insert your reason here. LESS THAN 100 words.",
  "is_end_credit_sequence": true of false,
  "is_next_episode_sequence": true or false
}

Provide your response immediately in the following JSON format without any preamble or additional information:
`;

function _suggestCutoffTimestamp(scenes, loudnesses = []) {
  let cutoffEnd = 0;

  const {
    timestampRange: [tmin,],
  } = scenes[0];
  const {
    timestampRange: [, tmax],
  } = scenes[scenes.length - 1];

  if ((tmax - tmin) < MIN_DURATION_FOR_CUTOFF_LOGIC) {
    return cutoffEnd;
  }

  // Special case: if it is absolute silent for very long time, skip those sequences
  // as it is potentially Textless elements
  const loudnessN = loudnesses[loudnesses.length - 1];
  if (loudnessN) {
    const {
      label, timestampRange: [tmin, tmax],
    } = loudnessN;

    if (label === TAG_ABSOLUTESILENT && (tmax - tmin) > MAX_CUTOFF_MINUTES) {
      cutoffEnd = tmin + ONE_MINUTE;
    }
  }

  return cutoffEnd;
}

function _validateResponse(response) {
  const {
    response: { jsonOutput },
  } = response;

  const {
    start_time, end_time,
    is_end_credit_sequence, is_next_episode_sequence,
  } = jsonOutput;

  const start = toMilliseconds(start_time);
  const end = toMilliseconds(end_time);

  jsonOutput.start = start;
  jsonOutput.end = end;

  if ((end - start) <= 0 || (!is_end_credit_sequence && !is_next_episode_sequence)) {
    jsonOutput.start = 0;
    jsonOutput.end = 0;
    jsonOutput.is_end_credit_sequence = false;
    delete jsonOutput.is_next_episode_sequence;
  } else if (is_next_episode_sequence) {
    delete jsonOutput.is_end_credit_sequence;
  } else {
    delete jsonOutput.is_next_episode_sequence;
  }

  return response;
}

function getDefaultTemplate() {
  return INSTRUCTIONS;
}

async function identifyClosingSequence(model, scenes, loudnesses = []) {
  const duped = scenes.slice();
  duped.sort((a, b) => b.scene - a.scene);

  // estimate when we should stop
  const cutoffEnd = _suggestCutoffTimestamp(scenes, loudnesses);

  // estimate when we should start
  const { timestampRange: [,tend] } = duped[0];
  let tstart = tend - MAX_CUTOFF_MINUTES;
  if (cutoffEnd > 0) {
    tstart = Math.min(tstart, cutoffEnd - MAX_CUTOFF_MINUTES);
  }
  tstart = Math.max(0, tstart);

  const candidates = [];
  for (const scene of duped) {
    const {
      timestampRange: [start, end],
      closingSequenceResponse,
    } = scene;

    if (closingSequenceResponse !== undefined && !debugLocally()) {
      closingSequenceResponse;
    }

    if (cutoffEnd > 0 && start > cutoffEnd) {
      continue;
    }
    if (end < tstart) {
      break;
    }
    candidates.push(scene);
  }
  candidates.sort((a, b) => a.scene - b.scene);

  const cues = [];
  for (const scene of candidates) {
    const {
      programSequenceResponse: {
        response: {
          jsonOutput: { audio_description_track },
        },
      },
      timestampRange: [start, end],
    } = scene;

    if ((end - start) <= 0) {
      continue;
    }

    let text = audio_description_track;
    if (text.startsWith('SKIPPING')) {
      text = text.replace('SKIPPING', '');
    }

    cues.push({
      identifier: cues.length + 1,
      start: start / 1000,
      end: end / 1000,
      text,
      styles: '',
    });
  }

  const vtt = toWebVtt({
    valid: true,
    cues,
  });

  let instruction = INSTRUCTIONS;
  instruction = instruction.replace(/{{descriptions}}/, vtt);

  const messages = [{ text: instruction }];
  let response = await model.inference(undefined, messages);
  response = _validateResponse(response);

  return response;
}

module.exports = {
  getDefaultTemplate,
  identifyClosingSequence,
};
