// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  CommonUtils: {
    debugLocally,
  },
  // SegmentHelper: {
  //   TYPE_RECAP,
  //   TYPE_TECHNICAL_SLATE,
  //   TYPE_IDENTS,
  //   TYPE_TITLE,
  //   TYPE_COUNTDOWNCLOCK,
  //   TYPE_COLORBARS,
  //   TYPE_BLACKFRAMES,
  //   TYPE_ENDCREDITS,
  //   TYPE_PROGRAMME,
  //   TYPE_UNDEFINED,
  // },
} = require('core-lib');
const {
  preAnalyzeSequences,
  identifySequence,
} = require('./sequenceHelper');

// const SequenceTypeList = [
//   TYPE_RECAP,
//   TYPE_TECHNICAL_SLATE,
//   TYPE_IDENTS,
//   TYPE_TITLE,
//   TYPE_COUNTDOWNCLOCK,
//   TYPE_COLORBARS,
//   TYPE_BLACKFRAMES,
//   TYPE_ENDCREDITS,
//   TYPE_PROGRAMME,
// ];

const INSTRUCTIONS = `
## Instructions
1. Carefully examine the provided grid image sequences along with the transcript and the known actors or actresses if provided. Read the grid images as is reading a comic book from left to right and top to bottom. Then, move on to the next grid image until all the grid images are read and understood:
### List of Grid Images
{{image}}

2. Write a concise Audio Description Track for visually impaired people, describing important visual content for people who are unable to see the video.
### It should also include details of the surroundings, prominent ONSCREEN OVERLAY text or words, color pattern presented in the frame image sequence.
### It MUST NOT exceed 400 words.

3. If ONSCREEN OVERLAY text or words are presented, identify the program name of the content. Return empty string if not applicable.
4. Determine if the image sequence represents a TV or MPAA Rating screen. Provide a clear TV rating identified based on the presence of specific elements such as rating labels (e.g., PG-14, TV-14), content descriptors, and any other relevant indicators.
### Key Elements to Look For:
- Rating Labels: Check for common TV or MPAA rating labels such as PG-13, TV-14, TV-PG, etc.
- Content Descriptors: Look for descriptors like 'Violence,' 'Language,' 'Sexual Content,' etc.
- Layout and Design: Note the typical layout and design of a TV or MPAA rating screen, which often includes a dark background with white and light-colored text.

5. Identify sponsor and brand logos presented in the image sequence and include them in the 'sponsor_and_brand_logos' list, NO MORE THAN 10. Return an empty list if not applicable.
6. Identify landmarks presented in the image sequence and include them in the 'landmarks' list, NO MORE THAN 5. Return an empty list if not applicable.
7. Identify FOREGROUND, ONSCREEN OVERLAY text or words and include them in the 'foreground_texts' list, NO MORE THAN 20. Return an empty list if not applicable.
8. Suggest relevant tags that best describes the image sequence, NO MORE THAN 5. Return an empty list if not applicable.
9. DO NOT include PII information in your response.
10. IGNORE and DO NOT include any timestamp text presented in the image sequence.

## Response example
{
  "audio_description_track": "Insert your audio description track here, LESS THAN 400 words.",
  "program_name": "Specify program name here ONLY IF it is identified. Otherwise, return empty string.",
  "sponsor_and_brand_logos": ["Logo1", "Logo2", "Brand1"],
  "landmarks": ["Landmark1", "Landmark2"],
  "relevant_tags": ["Tag1", "Tag2"],
  "foreground_texts": ["Text1, "Text2"],
  "tv_movie_rating": "Insert the identified TV rating here. If not applicable, return empty string."
}

Provide your response immediately in the following JSON format without any preamble or additional information:
`;

// Remove potential hallucination from the model
function _validateResponse(inferenceData) {
  try {
    const { response: { jsonOutput } } = inferenceData;

    // check stopReason to ensure output is not being filtered
    const { stopReason } = jsonOutput;
    if (stopReason === 'content_filtered') {
      jsonOutput.audio_description_track = 'Sensitive program content...';
      jsonOutput.program_name = '';
      jsonOutput.sponsor_and_brand_logos = [];
      jsonOutput.landmarks = [];
      jsonOutput.relevant_tags = [];
      jsonOutput.foreground_texts = [];
      jsonOutput.tv_movie_rating = '';
    }

    // program_name
    if ((jsonOutput.program_name || '').length > 0) {
      const re = new RegExp(/^(N\/A|None)/i);
      if (re.test(jsonOutput.program_name) === true) {
        jsonOutput.program_name = '';
      }
    }

    // foreground_texts, landmarks, relevant_tags, sponsor_and_brand_logos
    const fieldsToValidate = [
      ['foreground_texts', new RegExp(/^Text[0-9]+/i)],
      ['landmarks', new RegExp(/^Landmark[0-9]+/i)],
      ['relevant_tags', new RegExp(/^Tag[0-9]+/i)],
      ['sponsor_and_brand_logos', new RegExp(/^(Logo|Brand)[0-9]+/i)],
    ];

    for (const [field, re] of fieldsToValidate) {
      if (!Array.isArray(jsonOutput[field])) {
        continue;
      }
      const validated = [];
      for (const text of jsonOutput[field]) {
        if (re.test(text) === false) {
          validated.push(text);
        }
      }
      jsonOutput[field] = [...new Set(validated)];
    }
  } catch (e) {
    console.log(e);
  }

  return inferenceData;
}

//
// export functions
//
function getDefaultTemplate() {
  return INSTRUCTIONS;
}

async function preAnalyzeProgramSequences(scenes, frameMap, loudnesses, diarisations, respondToField) {
  return await preAnalyzeSequences(scenes, frameMap, loudnesses, diarisations, respondToField);
}

async function identifyProgramSequence(models, bucket, framePrefix, scene, instruction = '') {
  let prompt = INSTRUCTIONS;
  if (!debugLocally() && instruction.length > 0) {
    prompt = instruction;
  }

  let inferenceData = await identifySequence(models, prompt, bucket, framePrefix, scene);

  inferenceData = _validateResponse(inferenceData);

  return inferenceData;
}

module.exports = {
  getDefaultTemplate,
  preAnalyzeProgramSequences,
  identifyProgramSequence,
};
