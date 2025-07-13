// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  WebVttHelper: {
    compile: toWebVtt,
  },
  CommonUtils: {
    toMilliseconds,
  },
} = require('core-lib');
const { debugLocally } = require('core-lib/lib/commonUtils');

const INSTRUCTIONS = `
## Task
Given that the conversation analysis has identified an Intro sequence in the video, please confirm if the start and end time of the Intro sequence based on the following materials:
- The initial conversation analysis result
- A list of video scene descriptions (visual cues) that represent the first 5 to 7 minutes of the TV program

### Conversation Analysis Result
{{conversations}}

### Video Scene Descriptions (Visual cues)
{{descriptions}}


## Instructions
1. Carefully examine the provided conversation analysis and video scene descriptions in WebVTT format.
2. Identify the OVERALL Intro sequence of the tv program. Follow the guideline below:

### Guidelines
#### EXCLUDE color patterns sequences
#### Intro sequence MUST be longer than 20 seconds and contains multiple video scenes
#### MUST also include ALL sequences that contain the FOLLOWING prominent, FOREGROUND text OVERLAY:
- CREDITS to the CASTS and FILM CREWS
- TITLE and PROGRAM name of the TV program
- PRODUCTION LOGO or COMPANY names
#### Check any Recap/Previously sequence
- When Recap, Previously, or 'Last Time On' FOREGROUND text OVERLAY is identified in the video scene sequence, MARK is_recap_sequence to true.

3. Provide start time of the FIRST video scene identified Intro sequences.
4. Provide end time of the LAST video scene identified Intro sequences.
5. Ensure timestamp precisely capture the start and end time in the provided WebVTT.
6. Provide concise reasoning.
7. IF BOTH Intro and Recap/Previously sequence ARE NOT identified, MARK is_intro_sequence AND is_recap_sequence to false AND SET start_time AND end_time to 00:00:00.000
8. Examine the video scene sequences to double confirm if the sequence can be a Recap/Previously sequence.

### Response Example
{
  "start_time": "Start Time in HH:MM:SS.mmm format",
  "end_time": "End Time in HH:MM:SS.mmm format",
  "reasoning": "Insert your reason here. LESS THAN 100 words."
  "is_intro_sequence": true or false,
  "is_recap_sequence": true or false
}

Provide your response immediately in the following JSON format without any preamble or additional information:
`;

function _validateResponse(response) {
  const {
    response: { jsonOutput },
  } = response;

  const {
    start_time, end_time, is_recap_sequence, is_intro_sequence
  } = jsonOutput;

  const start = toMilliseconds(start_time);
  const end = toMilliseconds(end_time);

  jsonOutput.start = start;
  jsonOutput.end = end;

  if ((end - start) <= 0 || (!is_recap_sequence && !is_intro_sequence)) {
    jsonOutput.start = 0;
    jsonOutput.end = 0;
    jsonOutput.is_intro_sequence = false;
    delete jsonOutput.is_recap_sequence;
  } else if (is_recap_sequence) {
    delete jsonOutput.is_intro_sequence;
  } else {
    delete jsonOutput.is_recap_sequence;
  }

  return response;
}

//
// export functions
//
function getDefaultTemplate() {
  return INSTRUCTIONS;
}

async function validateIntroSequence(model, scenes, conversation) {
  if (!(((conversation || {}).audio_segments || [])[0] || {}).intro_segment) {
    return undefined;
  }

  const {
    audio_segments: segments,
  } = conversation;

  let cutoff = 0;
  const audioCues = [];
  for (const segment of segments) {
    const {
      start, end, audio_segment_description, intro_segment,
    } = segment;
    if (!intro_segment) {
      break;
    }

    if ((end - start) <= 0) {
      continue;
    }

    audioCues.push({
      identifier: audioCues.length + 1,
      start: start / 1000,
      end: end / 1000,
      text: audio_segment_description,
      styles: '',
    });
    cutoff = end;
  }

  if (audioCues.length === 0) {
    return undefined;
  }

  const audioVtt = toWebVtt({ valid: true, cues: audioCues });

  let instruction = INSTRUCTIONS;
  instruction = instruction.replace('{{conversations}}', audioVtt);

  cutoff = Math.max(5 * 60 * 1000, cutoff);
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
  validateIntroSequence,
};
