// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  CommonUtils: {
    toMilliseconds,
    debugLocally,
  },
} = require('core-lib');

const INSTRUCTIONS = `
## Instruction
Your task is to analyze the provided TV program transcript and identify the following:

### Group conversations into different audio segments
1. Drastic changes in the conversation topic
2. Long pauses or silences in the conversation
3. Distinct, burstly dialogues
4. Each audio segment MUST be longer than 1 minute

### Genres
Identify THREE most relevant TV or Movie genres of the program based on the transcript.

### Episodic content vs Movie
Movies are generally two hours or less, while episodic tv series can be anywhere from half an hour to an hour per episode and can go on for seasons. This difference in time commitment means that films can be more concise with their story and character development, while tv series have more time to explore these elements.
What kind of content is it? Answer episodic, movie, or others.

### For each identified audio segment, provide:
#### Detail description of the audio segment
Provide a detail description of the audio segment. NO MORE than 400 words.

#### Explanation
A brief explanation justifying why you consider it a distinct audio segment. NO MORE than 50 words.

#### Start and End Time
The start and end timestamps of the audio segment, MUST MATCH the dialogue timestamps in the WebVTT formatted transcript.

#### Recap of previous episode?
Is the conversation a recap of previous episode? The conversation flow differs from the rest of the program.

#### Intro segment
Is the conversation an intro or a teaser to the rest of the program?

## Guidelines
- Read the transcript carefully, noting shifts in subject matter and conversational flow
- Identify clear breaks or transitions where the discussion pivots to a new topic
- For long pauses, note extended periods of silence that disrupt the conversational continuity
- Provide concise reasoning for each audio segment, focusing on the key factors that signal a change of topic
- Ensure timestamps precisely capture the start and end of EACH identified event
- Identify genres and what kind of content

## Transcript
{{transcript}}

## Response Format
Please take your time to think before you provide your response in the following JSON format without any preamble or additional information:

{
  "list_of_genres: ["Genre1", "Genre2", "Genre3"],
  "kind_of_content": "Insert episodic, movie, or others",
  "audio_segments": [
    {
      "start_time": "Start Time in HH:MM:SS.mmm format",
      "end_time": "End Time in HH:MM:SS.mmm format",
      "explanation": "Insert your explanation here (NO MORE THAN 50 words)",
      "audio_segment_description: "Insert detail description (NO MORE than 400 words)",
      "recap_segment": true or false,
      "intro_segment": true or false,
    }
    ...
  ]
}
`;

const MAX_ALLOWED_DURATION = 2 * 60 * 1000;
const KINDS_OF_CONTENT = ['episodic', 'movie', 'others'];

// remove potential hallucinations from the model
function _validateResponse(inferenceResponse) {
  const {
    response: { jsonOutput },
  } = inferenceResponse;

  // remove hallucinations
  const { list_of_genres } = jsonOutput;
  let genres = [];
  if (typeof list_of_genres === 'string') {
    genres = list_of_genres.split(',').map((x) => x.trim());
  }

  if (Array.isArray(list_of_genres)) {
    for (const genre of list_of_genres) {
      if (genre.toLowerCase().startsWith('genre')) {
        continue;
      }
      genres.push(genre);
    }
  }

  jsonOutput.list_of_genres = [...new Set(genres)];

  // check kind_of_content
  let { kind_of_content = '' } = jsonOutput;
  kind_of_content = kind_of_content.toLowerCase();
  if (!KINDS_OF_CONTENT.includes(kind_of_content)) {
    kind_of_content = 'others';
  }
  jsonOutput.kind_of_content = kind_of_content;

  // augmenting the recap, intro, parental guidance flags
  const fieldsToValidate = [
    ['parental_guidance_segment', 'Parental Guidance'],
    ['intro_segment', 'Intro'],
    ['recap_segment', 'Recap/Previously'],
  ];
  const remark = '(The segment was identified as {{type}}. Mostly hallucination. Manually change to Program.)';
  let programCount = 0;

  const { audio_segments } = jsonOutput;
  for (const segment of audio_segments) {
    const {
      start_time, end_time, explanation,
    } = segment;

    const start = toMilliseconds(start_time);
    const end = toMilliseconds(end_time);
    const duration = Math.max(0, (end - start));

    segment.start = start;
    segment.end = end;

    if ((end - start) <= 0) {
      segment.start = 0;
      segment.end = 0;
    }

    if (!(segment.parental_guidance_segment || segment.intro_segment || segment.recap_segment)) {
      programCount += 1;
      continue;
    }

    // Check the segment temporal order
    if (programCount > 0) {
      for (const [field, type] of fieldsToValidate) {
        if (segment[field] === true) {
          segment[field] = false;
          segment.explanation = `${explanation} ${remark.replace('{{type}}', type)}`;
        }
      }
      programCount += 1;
    }

    // Check segment length
    for (const [field, type] of fieldsToValidate) {
      if (segment[field] === true && duration > MAX_ALLOWED_DURATION) {
        type;
        // segment[field] = false;
        // segment.explanation = `${explanation} ${remark.replace('{{type}}', type)}`;
      }
    }
  }

  return inferenceResponse;
}

async function _runConversationAnalysis(model, transcript, customTemplate = '') {
  let instruction = customTemplate;
  if (instruction.length === 0 || debugLocally()) {
    instruction = INSTRUCTIONS;
  }
  instruction = instruction.replace('{{transcript}}', transcript);

  const messages = [{ text: instruction }];

  const response = await model.inference(undefined, messages)
    .then((res) =>
      _validateResponse(res));

  console.log(`====== ${model.modelName} ======`);
  console.log(JSON.stringify(response.response, null, 2));
  console.log('\n');

  return response;
}

//
// export functions
//
function getDefaultTemplate() {
  return INSTRUCTIONS;
}

async function runConversationAnalysis(model, transcript, customTemplate) {
  return await _runConversationAnalysis(model, transcript, customTemplate);
}

module.exports = {
  getDefaultTemplate,
  runConversationAnalysis,
};
