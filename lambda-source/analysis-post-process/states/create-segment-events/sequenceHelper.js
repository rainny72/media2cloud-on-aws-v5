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
  SegmentHelper: {
    TYPE_UNDEFINED,
    TYPE_ENDCREDITS,
    TYPE_OPENINGCREDITS,
    TYPE_TITLE,
    TYPE_RATING,
    TYPE_PROGRAMME,
    TYPE_TRANSITION,
    TYPE_IDENTS,
  },
} = require('core-lib');

const INSTRUCTIONS = `
## Definitions
In TV and movie content, typical elements include:
1. **Rating Band**: If present, it appears at the BEGINNING and present the TV or MPAA Rating labels such as TV-MA, PG-13, etc.
2. **Opening Credits**: If present, it appears at the BEGINNING and list the names of the key people involved in the production, such as the director, producers, writers, actors, casts, and crew members.
3. **End Credits**: If present, it appears near the END of the content and list the names of the key people involved in the production, such as the director, executive producer, producer, writer, actor, cast, crew member, as well as acknowledgments and thanks. Typically, end credits are displayed on a black or dark background with white text.
4. **Title Sequence**: This is a visual introduction that includes the title of the film or show, often accompanied by music and special effects.
5. **Scene Transitions**: These are visual effects that help to transition from one scene to another, such as fades, cuts, or wipes.
6. **Studio Bumpers**: The logo of a production company that appears at the BEGINNING briefly on-screen following the credits for a television show or movie.
7. **Program**: The main content of the tv program or show.

These elements help to structure the content and enhance the viewing experience.

## Task
Given a list of video scene descriptions (visual cues) in WebVTT format with start and time timestamps that represents the TV or movie content. Please help to identify the key elements of the content.

### Video Scene Description
{{descriptions}}

## Instructions
1. Carefully read and comprehend the ENTIRE Video Scene Description before you answer any question
2. Determine the program name of the tv program or movie.
3. Identify the key elements such as Opening Credits, End Credits, Title Sequences, Scene Transitions, and Program
4. For each identified key element,
- Provide the start and end timestamps.
- The start and end timestamp MUST match the timestamp of the video scene presented in the WebVTT.
- Provide concise reasoning, NO MORE THAN 40 words

## IMPORTANT NOTES:
- A key element can span across multiple video scenes
- A black sequence typically indicates a change of two key elements
- An end credits element contains white text on black or dark background
- To avoid mis-identifying the start timestamp of the End Credits, look for a clear transition from the main program to the end credits, often marked by a significant change in visual style, such as a shift to a black or dark background with white text
- An opening credits and end credits are very similar. The important difference is the timestamp. An opening credits occurs at the BEGINNING of the program and an end credits occurs toward the END of the program. Pay attention to the timestamps.

### Response Example
{
  "program_name": "Specify Program Name here. If not present, return empty string."
  "list_of_key_elements": [
    {
      "key_element": "Answer the key element here.",
      "start_time": "HH:MM:SS.mmm format, i.e., 00:00:00.000",
      "end_time": "HH:MM:SS.mmm format, i.e., 10:10:10.100",
      "reasoning": "Answer your reason here, NO MORE THAN 40 words"
    },
    ...
  ]
}

Provide your response immediately in the following JSON format without any preamble or additional information:
`;

function _validateResponse(response) {
  const {
    response: { jsonOutput },
  } = response;

  const {
    program_name = '', list_of_key_elements = [],
  } = jsonOutput;

  if (program_name.length === 0) {
    jsonOutput.program_name = TYPE_UNDEFINED;
  }

  if (Array.isArray(list_of_key_elements) === false) {
    jsonOutput.list_of_key_elements = [];
    return response;
  }

  for (const element of list_of_key_elements) {
    const { start_time, end_time, key_element } = element;

    if (typeof key_element !== 'string') {
      console.log(`[ERR]: Incorrect key_element type. ${JSON.stringify(element)}. SKIPPING...`);
      continue;
    }

    const start = toMilliseconds(start_time);
    const end = toMilliseconds(end_time);

    const lowercase = key_element.toLowerCase();
    let sequenceType = TYPE_UNDEFINED;
    const validations = [
      ['end', TYPE_ENDCREDITS],
      ['open', TYPE_OPENINGCREDITS],
      ['title', TYPE_TITLE],
      ['rating', TYPE_RATING],
      ['program', TYPE_PROGRAMME],
      ['scene', TYPE_TRANSITION],
      ['studio', TYPE_IDENTS],
    ];

    for (const [keyword, type] of validations) {
      if (lowercase.startsWith(keyword)) {
        sequenceType = type;
        break;
      }
    }

    element.start = start;
    element.end = end;
    element.sequence_type = sequenceType;
  }

  return response;
}

async function _identifyProgramStructure(model, scenes, prompt = '') {
  let instruction = INSTRUCTIONS;

  if (!debugLocally() && prompt.length > 0) {
    instruction = prompt;
  }

  const cues = [];
  for (const scene of scenes) {
    const { scene: sceneId } = scene;
    try {
      const {
        programSequenceResponse: { response: { jsonOutput } },
      } = scene;

      const {
        audio_description_track = '', foreground_texts = [],
      } = jsonOutput;

      let text = audio_description_track || 'No info';
      if (Array.isArray(foreground_texts) && foreground_texts.length > 0) {
        text = `${text}\nAdditional texts appear in the scene sequence such as ${foreground_texts.map((x) => `"${x}"`).join(', ')})`;
      }

      let {
        timestampRange: [start, end],
      } = scene;

      if ((end - start) <= 0) {
        end = start + 100;
      }

      cues.push({
        identifier: cues.length + 1,
        start: start / 1000,
        end: end / 1000,
        text,
        styles: '',
      });
    } catch (e) {
      console.log(`[ERR]: Scene#${sceneId}:`, e);
    }
  }

  const vtt = toWebVtt({
    valid: true,
    cues,
  });
  instruction = instruction.replace(/{{descriptions}}/, vtt);

  const messages = [{ text: instruction }];
  let response = await model.inference(undefined, messages);

  console.log(JSON.stringify(response.response.jsonOutput, null, 2));

  response = _validateResponse(response);

  console.log(JSON.stringify(response.response.jsonOutput, null, 2));

  return response;
}

function getDefaultTemplate() {
  return INSTRUCTIONS;
}

async function identifyProgramStructure(model, scenes, instruction) {
  if (scenes.length === 0) {
    return undefined;
  }

  const { programStructureResponse } = scenes[0];
  // if (programStructureResponse) {
  if (programStructureResponse && !debugLocally()) {
    return programStructureResponse;
  }

  return await _identifyProgramStructure(model, scenes, instruction);
}

module.exports = {
  getDefaultTemplate,
  identifyProgramStructure,
};
