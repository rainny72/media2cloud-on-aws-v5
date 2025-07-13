// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  WebVttHelper: {
    compile: toWebVtt,
  },
  CommonUtils: {
    toMilliseconds,
    debugLocally,
  },
} = require('core-lib');

const INSTRUCTIONS = `
## Task
Given that the conversation analysis has already identified a Recap/Previously sequence in the video, please double confirm the start and end time of the Recap/Previously sequence based on the following materials:
- The initial conversation analysis result
- A list of video scene descriptions (visual cues) that represent the first 5 to 7 minutes of the TV program

### Conversation Analysis Result
{{conversations}}

### Video Scene Descriptions (Visual cues)
{{descriptions}}


## Instructions
1. Carefully examine the provided conversation analysis and video scene descriptions in WebVTT format.
2. Identify the OVERALL Recap/Previously sequence of the tv program. Follow the guideline below:

### Guidelines
#### EXCLUDE color patterns sequences
#### Recap/Previously sequence MUST be longer than 20 seconds and contains multiple video scenes
#### MUST also include ALL sequences that contain the FOLLOWING prominent, FOREGROUND OVERLAY text:
- CREDITS to the CASTS and FILM CREWS
- TITLE and PROGRAM name of the TV program
- PRODUCTION LOGO or COMPANY names

3. Provide start time of the FIRST video scene identified Recap/Previously sequences.
4. Provide end time of the LAST video scene identified Recap/Previously sequences.
5. Ensure timestamp precisely capture the start and end time in the provided WebVTT.
6. IF Recap sequence IS NOT identified, SET is_recap_sequence to false AND SET start_time AND end_time to 00:00:00.000
7. Provide concise reasoning.

### Response Example
{
  "start_time": "Start Time in HH:MM:SS.mmm format",
  "end_time": "End Time in HH:MM:SS.mmm format",
  "reasoning": "Insert your reason here. LESS THAN 100 words.",
  "is_recap_sequence": true or false
}

Provide your response immediately in the following JSON format without any preamble or additional information:
`;

function _validateResponse(response) {
  const {
    response: { jsonOutput },
  } = response;

  const {
    start_time, end_time, is_recap_sequence,
  } = jsonOutput;

  const start = toMilliseconds(start_time);
  const end = toMilliseconds(end_time);

  jsonOutput.start = start;
  jsonOutput.end = end;

  if ((end - start) <= 0 || is_recap_sequence === false) {
    jsonOutput.start = 0;
    jsonOutput.end = 0;
    jsonOutput.is_recap_sequence = false;
  }

  return response;
}

//
// export functions
//
function getDefaultTemplate() {
  return INSTRUCTIONS;
}

async function validateRecapSequence(model, scenes, conversation) {
  if (!(((conversation || {}).audio_segments || [])[0] || {}).recap_segment) {
    return undefined;
  }

  const {
    audio_segments: [firstSegment,],
  } = conversation;

  const {
    start, end, audio_segment_description,
  } = firstSegment;

  const audioVtt = toWebVtt({
    valid: true,
    cues: [{
      identifier: 1,
      start: start / 1000,
      end: end / 1000,
      text: audio_segment_description,
      styles: '',
    }],
  });

  let instruction = INSTRUCTIONS;
  instruction = instruction.replace('{{conversations}}', audioVtt);

  const cutoff = Math.max(5 * 60 * 1000, end);
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

  const visualCues = [];
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

    visualCues.push({
      identifier: visualCues.length + 1,
      start: start / 1000,
      end: end / 1000,
      text,
      styles: '',
    });
  }

  const vtt = toWebVtt({
    valid: true,
    cues: visualCues,
  });
  instruction = instruction.replace(/{{descriptions}}/, vtt);

  const messages = [{ text: instruction }];
  let response = await model.inference(undefined, messages);

  response = _validateResponse(response);

  return response;
}

module.exports = {
  getDefaultTemplate,
  validateRecapSequence,
};
