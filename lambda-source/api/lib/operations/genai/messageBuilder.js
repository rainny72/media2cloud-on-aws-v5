// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  M2CException,
} = require('core-lib');
const {
  TASK: {
    Genre,
    Sentiment,
    Summarize,
    Taxonomy,
    Theme,
    TVRatings,
    Custom,
  },
  LIST_OF_GENRES,
  LIST_OF_RATINGS,
  LIST_OF_SENTIMENTS,
  LIST_OF_THEMES,
  LIST_OF_TAXONOMY,
} = require('./defs');

const INSTRUCTIONS = `
## Task
Analyze the transcript and suggest three most relevant {{task}} from list provided.

## Instructions
1. Carefully examine the transcript
### Transcript
{{transcript}}

2. Suggest three most relevant {{task}} from the list provided:
### List of {{task}}
{{categories}}

3. For each suggested {{task}}, assign a confidence score from 0 to 100.
4. Provide your response immediately in the following JSON format without any preamble or additional information:
### Response example 1
{{example}}
`;

async function _messageBuilder(task, params = {}) {
  if (task === Genre) {
    return _genreMessages(params);
  }
  if (task === Sentiment) {
    return _sentimentMessages(params);
  }
  if (task === Summarize) {
    return _summaryMessages(params);
  }
  if (task === Taxonomy) {
    return _taxonomyMessages(params);
  }
  if (task === Theme) {
    return _themeMessages(params);
  }
  if (task === TVRatings) {
    return _tvratingMessages(params);
  }
  if (task === Custom) {
    return _customMessages(params);
  }

  throw new M2CException('invalid prompt parameter');
}

function _genreMessages(params) {
  const example = {
    genres: [
      { text: 'Genre1', score: '0 to 100' },
      { text: 'Genre2', score: '0 to 100' },
    ],
  };

  const categories = LIST_OF_GENRES
    .map((genre, idx) => `${idx + 1}. ${genre}`)
    .join('\n');

  const instructions = INSTRUCTIONS
    .replaceAll('{{task}}', Genre)
    .replace('{{transcript}}', params.text_inputs)
    .replace('{{categories}}', categories)
    .replace('{{example}}', JSON.stringify(example, null, 2));

  return [{ text: instructions }];
}

function _sentimentMessages(params) {
  const example = {
    sentiment: { text: 'Sentiment', score: '0 to 100' },
  };

  const categories = LIST_OF_SENTIMENTS
    .map((sentiment, idx) => `${idx + 1}. ${sentiment}`)
    .join('\n');

  const instructions = INSTRUCTIONS
    .replaceAll('three', 'the')
    .replaceAll('{{task}}', Sentiment)
    .replace('{{transcript}}', params.text_inputs)
    .replace('{{categories}}', categories)
    .replace('{{example}}', JSON.stringify(example, null, 2));

  return [{ text: instructions }];
}

function _taxonomyMessages(params) {
  const example = {
    taxonomies: [
      { text: 'IAB Taxonomy 1', score: '0 to 100' },
      { text: 'IAB Taxonomy 2', score: '0 to 100' },
    ],
  };

  const categories = LIST_OF_TAXONOMY
    .map((taxonomy, idx) => `${idx + 1}. ${taxonomy.Name}`)
    .join('\n');

  const instructions = INSTRUCTIONS
    .replaceAll('{{task}}', 'IAB Content Taxonomy')
    .replace('{{transcript}}', params.text_inputs)
    .replace('{{categories}}', categories)
    .replace('{{example}}', JSON.stringify(example, null, 2));

  return [{ text: instructions }];
}

function _themeMessages(params) {
  const example = {
    themes: [
      { text: 'Theme1', score: '0 to 100' },
      { text: 'Theme2', score: '0 to 100' },
    ],
  };

  const categories = LIST_OF_THEMES
    .map((theme, idx) => `${idx + 1}. ${theme}`)
    .join('\n');

  const instructions = INSTRUCTIONS
    .replaceAll('{{task}}', Theme)
    .replace('{{transcript}}', params.text_inputs)
    .replace('{{categories}}', categories)
    .replace('{{example}}', JSON.stringify(example, null, 2));

  return [{ text: instructions }];
}

function _tvratingMessages(params) {
  const example = {
    ratings: { text: 'MPAA Rating 1', score: '0 to 100' },
  };

  const categories = LIST_OF_RATINGS
    .map((rating, idx) => `${idx + 1}. ${rating}`)
    .join('\n');

  const instructions = INSTRUCTIONS
    .replaceAll('three', 'the')
    .replaceAll('{{task}}', 'MPAA Ratings')
    .replace('{{transcript}}', params.text_inputs)
    .replace('{{categories}}', categories)
    .replace('{{example}}', JSON.stringify(example, null, 2));

  return [{ text: instructions }];
}

function _summaryMessages(params) {
  const example = {
    summary: { text: 'Summary', score: '0 to 100' },
  };

  const instructions = `
## Task
Analyze and summarize the transcript.

## Instructions
1. Carefully examine the transcript
### Transcript
${params.text_inputs}

2. Summariz the transcript

3. Assign a confidence score from 0 to 100.
4. Provide your response immediately in the following JSON format without any preamble or additional information:
### Response example 1
${JSON.stringify(example, null, 2)}
  `;

  return [{ text: instructions }];
}

function _customMessages(params) {
  const example = {
    custom: { text: 'Response goes here', score: '0 to 100' },
  };

  const instructions = `
  ${params.text_inputs}

  ## Provide your response immediately in the following JSON format without any preamble or additional information:
  ### Response example 1
  ${JSON.stringify(example, null, 2)}
  `;

  return [{ text: instructions }];
}

async function messageBuilder(task, params) {
  return await _messageBuilder(task, params);
}

module.exports = {
  messageBuilder,
};