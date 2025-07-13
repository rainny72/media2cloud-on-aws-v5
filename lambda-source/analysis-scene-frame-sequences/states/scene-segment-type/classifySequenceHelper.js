// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  SegmentHelper: {
    TYPE_COLORBARS,
    TYPE_TECHNICAL_SLATE,
    TYPE_COUNTDOWNCLOCK,
    TYPE_TITLE,
    TYPE_RATING,
    TYPE_PROGRAMME,
    TYPE_IDENTS,
    TYPE_CREDITS,
    TYPE_TRANSITION,
    TYPE_BLACKFRAMES,
    TYPE_UNDEFINED,
    TYPE_OPENINGCREDITS,
    TYPE_ENDCREDITS,
  },
} = require('core-lib');

const SequenceTypeMapping = {
  'BlackFrames': { type: TYPE_BLACKFRAMES, flag: 'is_blackframes' },
  'Color Bars': { type: TYPE_COLORBARS, flag: 'is_color_bars' },
  'Countdown Clock': { type: TYPE_COUNTDOWNCLOCK, flag: 'is_countdown_clock' },
  'Technical Slate': { type: TYPE_TECHNICAL_SLATE, flag: 'is_technical_slate' },
  'Idents': { type: TYPE_IDENTS, flag: 'is_idents' },
  'Ratings': { type: TYPE_RATING, flag: 'is_ratings' },
  'Title': { type: TYPE_TITLE, flag: 'is_title' },
  'Credits': { type: TYPE_CREDITS, flag: 'is_credits' },
  'Transition': { type: TYPE_TRANSITION, flag: 'is_transition' },
  'Program': { type: TYPE_PROGRAMME, flag: 'is_program' },
};

const INSTRUCTIONS = `
## Task
Analyze the scene description and follow the guidelines to answer the questions.

## Sequence Type Guidelines
### BlackFrames
1. Black image sequence only and NO OTHER describeable element.

### Color Bars
1. Repeated colorful Color pattern and NO OTHER describeable element.

### Countdown Clock
1. Repeated large countdown clock and the clock is counting down in the image sequence.

### Technical Slate
1. VISIBLE, FOREGROUND overlay TECHNICAL data and code identifier related to the TV program
2. Is it on solid background with no other descriptive elements in the sequence?

### Idents
1. Centered logo, graphic or overlay name of the production company and NO other describeable element

### Ratings
1. Does it contain visible overlay text related to the TV and Motion Pictures Rating?

### Title
1. VISIBLE, PROMINENT, FOREGROUND, centered text overlay program name of the tv program AND NO OTHER describeable element in the sequence.

### Credits
1. Credits to CASTS and FILM CREWS and NO OTHER describeable element.
2. Or, overlay text of 'THE END,' 'TO BE CONTINUED', 'NEXT ON' and NO OTHER describeable element.

### Transition
1. Centered white overlay text on solid blackground that ARE NOT 'Credits', 'Title', and 'Idents' sequence and NO OTHER describeable element.

### Program
1. Program sequence if none of the above is true.

## Instructions
1. Carefully examine the provided scene descriptions as follows:
### Scene Descriptions
{{description}}

2. Follow the provided guidelines and answer true or false for each question.
3. Suggest one best sequence type after your analysis.
4. Identify the program name of the tv program when possible.
5. Provide your response immediately in the following JSON format without any preamble or additional information:

### Response example 1
{
  "is_blackframes": true or false,
  "is_color_bars": true or false,
  "is_countdown_clock": true or false,
  "is_technical_slate": true or false,
  "is_idents": true or false,
  "is_ratings": true or false,
  "is_title": true or false,
  "is_credits": true or false,
  "is_transition": true or false,
  "is_program": true of false,
  "sequence_type": "Specify one best sequence type here.",
  "program_name": "Specify the program name of the tv program if is present. Otherwise respond 'N/A'."
}
`;

const PROGRAM_BEGIN = 7 * 60 * 1000;

async function _classifySequence(model, scene, instruction, sceneDescription) {
  const messages = [{
    text: instruction.replace('{{description}}', sceneDescription),
  }];

  let inferenceData = await model.inference(undefined, messages);
  inferenceData = _validateResponse(inferenceData, scene);

  const { request, response } = inferenceData;
  response.apiCount = 1;

  // debugger;

  return { request, response };
}

function _emptyResponse(sequenceType) {
  return {
    request: { messages: [] },
    response: {
      modelId: 'none',
      apiCount: 0,
      inferenceTime: 0,
      stopReason: 'skipped',
      jsonOutput: {
        sequence_type: sequenceType || TYPE_UNDEFINED,
      },
      usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    },
  };
}

function _validateResponse(response, scene) {
  try {
    const { response: { jsonOutput } } = response;
    const { sequence_type } = jsonOutput;

    // Map sequence_type to segmentType
    let segmentType;
    if (SequenceTypeMapping[sequence_type]) {
      segmentType = SequenceTypeMapping[sequence_type].type;
    }

    for (const [key, val] of Object.entries(jsonOutput)) {
      if (key.startsWith('is_')) {
        if (typeof val !== 'boolean') {
          jsonOutput[key] = String(val).toLowerCase() === 'true';
        }
        // look up segmentType
        if (jsonOutput[key] === true && segmentType === undefined) {
          for (const { type, flag } of Object.values(SequenceTypeMapping)) {
            if (flag === key) {
              segmentType = type;
              break;
            }
          }
        }
      } else if (typeof val === 'string') {
        // N/A, None -> empty string
        const re = new RegExp(/^(N\/A|None)/i);
        if (re.test(val) === true) {
          jsonOutput[key] = '';
        }
      }
    }

    if (segmentType === undefined) {
      segmentType = TYPE_UNDEFINED;
    }

    // check scene timestamp to see if it is opening credits or end credits
    if (segmentType === TYPE_CREDITS) {
      const { timestampRange: [, tend] } = scene;
      if (tend < PROGRAM_BEGIN) {
        segmentType = TYPE_OPENINGCREDITS;
      } else {
        segmentType = TYPE_ENDCREDITS;
      }
    }
    jsonOutput.segmentType = segmentType;
  } catch (e) {
    console.log(e);
  }

  return response;
}

//
// export functions
//
function getDefaultTemplate() {
  return INSTRUCTIONS;
}

async function classifySequence(model, scene, segmentType, text, instruction) {
  let prompt = INSTRUCTIONS;
  if (instruction !== undefined && instruction.length > 0) {
    prompt = instruction;
  }

  let response;
  if (segmentType !== undefined || !text) {
    response = _emptyResponse(segmentType);
  } else {
    response = await _classifySequence(model, scene, prompt, text);
    // response = _validateResponse(response, scene);
  }

  const { response: jsonOutput } = response;
  const { scene: sceneNo } = scene;
  jsonOutput.sceneNo = sceneNo;

  return response;
}

module.exports = {
  getDefaultTemplate,
  classifySequence,
};
