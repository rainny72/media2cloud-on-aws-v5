// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  CommonUtils: {
    debugLocally,
    toMilliseconds,
  },
  WebVttHelper: {
    compile: toWebVtt,
  },
} = require('core-lib');
const {
  validateRecapSequence,
} = require('./recapValidationHelper');
const {
  validateIntroSequence,
} = require('./introValidationHelper');

const INSTRUCTIONS = `
## Task
Given a list of video scene descriptions (visual cues) that represents the first 5 to 7 minutes of the TV program and OPTIONALLY the tv program name, please help to identify the opening sequences of the TV program.

### Video Scene Description List
{{descriptions}}

#### TV Program Name
{{program_name}}

## Instructions
1. Carefully examine the provided video scene descriptions in WebVTT format.
2. Identify the opening sequence of the TV program. Follow the guideline below:

### Guidelines
#### EXCLUDE color patterns sequences
#### Opening sequences MUST be longer than 20 seconds
#### MUST include ALL sequences that contain the FOLLOWING prominent, FOREGROUND OVERLAY text or word:
- CREDITS to the casts and FILM CREWS
- TV Program Name or TITLE name
- PRODUCTION LOGO or COMPANY names

3. Provide start time of the FIRST video scene identified opening sequences.
4. Provide end time of the LAST video scene identified opening sequences.
5. Ensure timestamp precisely capture the start and end time in the provided WebVTT.
6. IF opening sequence IS NOT identified, SET is_opening_sequence to false AND SET start_time AND end_time to 00:00:00.000
7. Provide concise reasoning.

### Response Example
{
  "start_time": "Start Time in HH:MM:SS.mmm format",
  "end_time": "End Time in HH:MM:SS.mmm format",
  "reasoning": "Insert your reason here. LESS THAN 100 words.",
  "is_opening_sequence": true or false
}

Provide your response immediately in the following JSON format without any preamble or additional information:
`;

function _validateResponse(response) {
  const {
    response: { jsonOutput },
  } = response;

  const {
    start_time, end_time, is_opening_sequence,
  } = jsonOutput;

  const start = toMilliseconds(start_time);
  const end = toMilliseconds(end_time);

  jsonOutput.start = start;
  jsonOutput.end = end;

  if ((end - start) <= 0 || is_opening_sequence === false) {
    jsonOutput.start = 0;
    jsonOutput.end = 0;
    jsonOutput.is_opening_sequence = false;
  }

  return response;
}

async function _identifyOpeningSequence(model, scenes) {
  const cutoff = 7 * 60 * 1000;
  let instruction = INSTRUCTIONS;

  const candidates = [];
  for (const scene of scenes) {
    const {
      timestampRange: [start,],
      openingSequenceResponse,
    } = scene;

    if (openingSequenceResponse && !debugLocally()) {
      return openingSequenceResponse;
    }

    if (start > cutoff) {
      break;
    }
    candidates.push(scene);
  }

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
  instruction = instruction.replace(/{{descriptions}}/, vtt);

  let { programName = '' } = scenes[0];
  if (programName.length === 0) {
    programName = 'N/A';
  }
  instruction = instruction.replace(/{{program_name}}/, programName);

  const messages = [{ text: instruction }];
  let response = await model.inference(undefined, messages);
  response = _validateResponse(response);

  return response;
}

function getDefaultTemplate() {
  return INSTRUCTIONS;
}

async function identifyOpeningSequence(model, scenes, conversationAnalysis) {
  let response = await validateRecapSequence(model, scenes, conversationAnalysis);

  if (!response) {
    response = await validateIntroSequence(model, scenes, conversationAnalysis);
  }

  if (!response) {
    response = await _identifyOpeningSequence(model, scenes);
  }

  return response;
}

module.exports = {
  getDefaultTemplate,
  identifyOpeningSequence,
};
