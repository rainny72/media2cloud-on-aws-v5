// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
} = require('node:path');
const {
  randomBytes,
} = require('node:crypto');
const {
  ModelErrorException,
} = require('@aws-sdk/client-bedrock-runtime');
const {
  CommonUtils: {
    download,
    toHHMMSS,
    validateUuid,
    debugLocally,
  },
  ExceptionHelper: {
    retryableExceptions,
    invalidRequestExceptions,
  },
} = require('core-lib');
const {
  SegmentHelper: {
    TYPE_BLACKFRAMES,
    TYPE_MONOCHROMEFRAMES,
    TYPE_COLORBARS,
    TYPE_TECHNICAL_SLATE,
    TYPE_COUNTDOWNCLOCK,
    TYPE_RATING,
    TYPE_IDENTS,
    TYPE_TITLE,
    TYPE_RECAP,
    TYPE_INTRO,
    TYPE_TRANSITION,
    TYPE_PROGRAMME,
    TYPE_CREDITS,
    TYPE_UNDEFINED,
    TAG_ABSOLUTESILENT,
  },
  JimpHelper: {
    MIME_JPEG,
    imageFromS3,
    imageFromScratch,
  },
} = require('core-lib');

const EnableMonochromePredefinedType = false;

// [TYPE_COLORBARS]: 'Sequence of SMPTE \'color bars\' television test pattern.',
const CATEGORY_MAPPINGS = {
  [TYPE_BLACKFRAMES]: 'Repeated black image sequence without text and graphics and other colors.',
  [TYPE_COLORBARS]: 'Repeated television test patterns with vertical sequence of colored stripes with yellow, cyan, green, purple, red, and blue in frame image sequence.',
  [TYPE_TECHNICAL_SLATE]: 'Sequence contains technical metadata of the TV program with black background and white text and without credits to the film crews.',
  [TYPE_COUNTDOWNCLOCK]: 'Visible countdown clock counting down in image sequence',
  [TYPE_IDENTS]: 'Production company identification sequence with company logo and overlay name.',
  [TYPE_RATING]: 'Visible forground overlay text presents the TV and Motion Pictures Rating',
  [TYPE_TITLE]: 'Title sequence presents the title name of the TV program.',
  [TYPE_RECAP]: 'Foreground text such as \'Recap\', \'Previously\' or \'Last time on\' presented in the image sequence indicating the sequence is Recap or Previously.',
  [TYPE_INTRO]: 'Dialogue or conversation provides a brief preview, introduction of the plot of the following TV program.',
  [TYPE_CREDITS]: 'Sequence with Credits to the casts and film crews. Sequence with \'The End\', \'To Be Continued\' text overlay.',
  [TYPE_TRANSITION]: 'Sequence with repeated white foreground text on black screen that are not credits.',
  // [TYPE_ENDCREDITS]: 'Credits to the casts and film crews with static background and white text.',
  [TYPE_PROGRAMME]: 'Program content (if none of the above)',
};
const ONE_MINUTE = 60 * 1000;
const MAX_CUTOFF_MINUTES = 6 * ONE_MINUTE;
const MIN_DURATION_FOR_CUTOFF_LOGIC = 60 * ONE_MINUTE;
const MIN_SEQUENCE_DURATION = 1000;

function _emptyResponse(sceneNo, reason, sequenceType = TYPE_UNDEFINED) {
  console.log(`[Scene#${sceneNo}]: ${reason}. (${sequenceType})`);
  return {
    request: { messages: [] },
    response: {
      modelId: 'none',
      apiCount: 0,
      inferenceTime: 0,
      stopReason: 'skipped',
      usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      jsonOutput: {
        sceneNo,
        sequence_type: sequenceType,
        audio_description_track: reason,
      },
    },
  };
}

function _skipKnownSequence(scene, frameMap) {
  const {
    scene: sceneNo,
    knownType,
    frameSequences,
    frameRange: [fmin, fmax],
    timestampRange: [tmin, tmax],
  } = scene;

  // Blackframes sequence?
  if (knownType === TYPE_BLACKFRAMES) {
    const reason = `${knownType} sequence...`;
    return _emptyResponse(sceneNo, reason, TYPE_BLACKFRAMES);
  }

  // Monochrome frame sequence?
  if (EnableMonochromePredefinedType) {
    const colorProps = [];
    for (let i = fmin; i <= fmax; i += 1) {
      const frame = frameMap[String(i)] || {};
      if (!frame.colorProps) {
        continue;
      }
      colorProps.push(frame.colorProps);
    }

    if (colorProps.length > 0) {
      const { dominantColorName } = colorProps[0];
      const reason = `${dominantColorName} sequence...`;
      return _emptyResponse(sceneNo, reason, TYPE_MONOCHROMEFRAMES);
    }
  }

  // sequence too short?
  if ((tmax - tmin) < MIN_SEQUENCE_DURATION) {
    const reason = `Very short program sequence...`;
    return _emptyResponse(sceneNo, reason);
  }

  // No frame sequence image?
  if ((frameSequences || [])[0] === undefined) {
    const reason = 'Undetermined program sequence';
    return _emptyResponse(sceneNo, reason);
  }

  return undefined;
}

function _skipCutoffSequence(scene, cutoffEnd = 0) {
  if (cutoffEnd === 0) {
    return undefined;
  }

  const {
    scene: sceneNo, timestampRange: [tmin,],
  } = scene;

  if (tmin < cutoffEnd) {
    return undefined;
  }

  const reason = `Absolute silent audio sequence after cutoff timestamp, ${toHHMMSS(cutoffEnd, true)}`;
  return _emptyResponse(sceneNo, reason);
}

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

async function _getFacesInSceneMessages(bucket, framePrefix, faces) {
  const facesInScene = await _getFacesInScene(bucket, framePrefix, faces);
  if (facesInScene.length === 0) {
    return [];
  }

  if (facesInScene.length === 1) {
    const { name, image } = facesInScene[0];

    const messages = [];
    const text = `### The known actor "${name}" has been identified in the scene sequence. Match the givein face image of "${name}" below and USE the actor/actress name instead of "person", "man", "woman" to enrich the audio description track.`;
    messages.push({ text });

    const bytes = await image.getBufferAsync(MIME_JPEG);
    messages.push({ image: new Uint8Array(bytes) });

    return messages;
  }

  const { coordInGrid: { w, h } } = facesInScene[0];
  const imgW = w * facesInScene.length;
  const imgH = h;

  let names = [];
  const blitImage = await imageFromScratch(imgW, imgH);
  for (let i = 0; i < facesInScene.length; i += 1) {
    const { name, image } = facesInScene[i];
    const l = i * w;
    blitImage.blit(image, l, 0);
    names.push(name);
  }

  if (debugLocally()) {
    const random = randomBytes(4).toString('hex');
    await blitImage.writeAsync(join('_faceimages', `${random}.jpg`));
  }

  const messages = [];
  names = names.map((name) => `- ${name}`).join('\n');
  const text = `### List of known actors and actresses' faces have been identified in the scene sequence. The face grid image below represents the actors and actresses. READ the face grid image from left to right with their corresponding names:\n${names}\n\nMatch their faces to the scene sequence and USE their actor/actress name instead of "person", "man", "woman" to enrich the audio description track.`;
  messages.push({ text });

  const bytes = await blitImage.getBufferAsync(MIME_JPEG);
  messages.push({ image: new Uint8Array(bytes) });

  return messages;
}

async function _getFacesInScene(bucket, framePrefix, faces = []) {
  const filtered = faces.filter(({ name }) => !validateUuid(name));

  if (filtered.length === 0) {
    return filtered;
  }

  const cached = {};
  for (const face of filtered) {
    const { gridImageKey } = face;
    let image;
    if (cached[gridImageKey]) {
      image = cached[gridImageKey];
    }
    if (!image) {
      image = await imageFromS3(bucket, join(framePrefix, gridImageKey));
      cached[gridImageKey] = image;
    }
    const { coordInGrid: { l, t, w, h } } = face;
    face.image = image.clone().crop(l, t, w, h);
  }

  return filtered;
}

async function _getTranscriptMessages(transcripts) {
  const messages = [];

  let transcriptions = [];
  for (const { transcript } of transcripts) {
    transcriptions.push(transcript);
  }
  transcriptions = transcriptions.map((text) => `- ${text}`).join('\n');
  if (transcriptions.length > 40) {
    transcriptions = `### Transcript identified within this scene sequence\n${transcriptions}\n\n`;
    messages.push({ text: transcriptions });
  }

  return messages;
}

async function _getSoundEventMessages(audioTags = []) {
  if (audioTags.length === 0) {
    return [];
  }

  let labels = [];
  for (const { label, duration } of audioTags) {
    const hhmmss = toHHMMSS(duration, true);
    labels.push(`- ${label} (${hhmmss} long)`);
  }
  labels = labels.join('\n');

  const text = `### List of sound events with duration detected from the audio stream within this scene sequence\n${labels}\nUSE them to enrich the audio description track when appropriate\n\n`;
  const messages = [];
  messages.push({ text });

  return messages;
}

async function _preAnalyzeSequences(scenes, frameMap, loudnesses, diarisations, respondToField) {
  diarisations;

  if (respondToField === undefined) {
    return scenes;
  }

  if (scenes.length === 0) {
    return scenes;
  }

  const cutoffEnd = _suggestCutoffTimestamp(scenes, loudnesses);

  for (const scene of scenes) {
    // skip if already has response
    if (scene[respondToField] !== undefined) {
      continue;
    }

    // skip any known sequence such Blackframes, extremely short sequence
    let response = _skipKnownSequence(scene, frameMap);
    // skip potential Textless elements (Absolute silent audio) at the end
    if (response === undefined) {
      response = _skipCutoffSequence(scene, cutoffEnd);
    }
    if (response !== undefined) {
      scene[respondToField] = response;
    }
  }

  return scenes;
}

async function _identifySequence(models, instructions, bucket, framePrefix, scene) {
  const {
    scene: sceneNo, frameSequences, transcripts = [],
  } = scene;
  console.log(`[Scene#${sceneNo}] PROCESSING...`);

  const messages = [];

  const texts = instructions.split(/{{image}}/);
  if (texts.length !== 2) {
    console.log(instructions);
    throw new Error('Instruction missing {{image}} parameter');
  }

  // instruction before image
  messages.push({ text: texts[0] });

  for (const frameSequence of frameSequences) {
    let image = await download(bucket, join(framePrefix, frameSequence), false);
    image = await image.Body.transformToByteArray();
    messages.push({ image });
  }

  // optional actors/actresses
  let optionalMessages = await _getFacesInSceneMessages(bucket, framePrefix, scene.faces);
  for (const msg of optionalMessages) {
    messages.push(msg);
  }

  // optional transcript
  optionalMessages = await _getTranscriptMessages(transcripts);
  for (const msg of optionalMessages) {
    messages.push(msg);
  }

  // optional sound events
  optionalMessages = await _getSoundEventMessages(scene.audioTags);
  for (const msg of optionalMessages) {
    messages.push(msg);
  }

  // instruction after image
  messages.push({ text: texts[1] });

  let lastException;
  for (const model of models) {
    // Anthropic Claude family is very sensitive on moderated scene.
    let ignoreValidationException = false;
    if (model.modelId.indexOf('claude') >= 0) {
      ignoreValidationException = true;
    }

    try {
      const { request, response } = await model.inference(undefined, messages);
      response.apiCount = 1;

      const { jsonOutput } = response;
      jsonOutput.sceneNo = sceneNo;

      return { request, response };
    } catch (e) {
      if (retryableExceptions(e) || (invalidRequestExceptions(e) && ignoreValidationException)) {
        lastException = e;
      } else {
        console.log(`ERR: Scene#${sceneNo}: ${e.message}`);
        throw e;
      }
    }
  }

  // exhausted all models
  if (!lastException) {
    lastException = new ModelErrorException();
  }
  console.log(`ERR: Scene#${sceneNo}: ${lastException.message}`);
  throw lastException;
}

//
// export functions
//
async function preAnalyzeSequences(scenes, frameMap, loudnesses, diarisations, respondToField) {
  return await _preAnalyzeSequences(scenes, frameMap, loudnesses, diarisations, respondToField);
}

async function identifySequence(models, instructions, bucket, framePrefix, scene) {
  if (models.length === 0) {
    throw new Error('model not specified');
  }

  return await _identifySequence(models, instructions, bucket, framePrefix, scene);
}

module.exports = {
  CATEGORY_MAPPINGS,
  preAnalyzeSequences,
  identifySequence,
};
