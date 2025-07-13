// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  writeFileSync,
} = require('node:fs');
const {
  join,
} = require('node:path');
const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require('@aws-sdk/client-bedrock-runtime');
const {
  jsonrepair,
} = require('core-lib/node_modules/jsonrepair');
const {
  Environment: {
    Solution: {
      Metrics: {
        CustomUserAgent,
      },
    },
  },
  CommonUtils: {
    createDir,
    uploadFile,
  },
  TaxonomyHelper: {
    searchTaxonomyByName,
    findAllTierTaxonomies,
  },
  JimpHelper: {
    MIME_JPEG,
    imageFromS3,
    imageFromScratch,
  },
  SegmentHelper: {
    loadModelConfigs,
    getPreferredModel,
  },
  xraysdkHelper,
  retryStrategyHelper,
} = require('core-lib');

const {
  ENV_PROXY_BUCKET: ProxyBucket,
  ENV_BEDROCK_MODELLIST_LOCATION: ModelListLocation = '_settings/availablemodels.json',
} = process.env;

const STORE_IMAGE_LOCAL = true;
const DEBUG_FRAMES = (process.env.AWS_LAMBDA_FUNCTION_NAME === undefined && STORE_IMAGE_LOCAL);

// maximum number of frame sequence images.
// Claude 3 can support upto 20 images, equivalent to 560 frames, approx. 9 minutes.
const MAX_FRAMESEQUENCE_IMAGES = 20;
// const MAX_GRID = [4, 7];
// Claude max WxH without resizing
const MAX_IMAGE_WXH = [1568, 1568];
const TILE_WXH = [392, 220];
const BORDER_SIZE = 2;

const VISUAL_TEXT = 'Here are a list of frame sequence images that describes the video content.';
const IMAGE_TEXT = `The ID of the image below is "{{IMAGE_ID}}". Save your answers to {{IMAGE_JSON}}.`;

const TRANSCRIPT_TEXT = `
Here is the transcript in WebVTT format in <transcript> tag:
<transcript>
{{TRANSCRIPT}}
</transcript>
`;

const KNOWN_PEOPLE_TEXT = `
Here is a list of known people appeared in the video images, specified in <known_people> tag:
<known_people>
{{KNOWN_PEOPLE}}
</known_people>

Use the names of the known people whenever possible.
`;

const OUTPUT_EXAMPLE_TEXT = `
Return JSON output and follow the example specified in <output> tag:
<output>
{{OUTPUT}}
</output>

Skip any explanation.
`;

let Model;
let _bedrockRuntimeClient;

class ContextualHelper {
  static async makeImageStackContent(images, defaulText = IMAGE_TEXT) {
    return _makeImageStackContent(images, defaulText);
  }

  static async makeFrameSequencesContent(images, defaulText = VISUAL_TEXT) {
    return _makeFrameSequencesContent(images, defaulText);
  }

  static async makeTranscriptContent(transcript = '', minLength = 50) {
    return _makeTranscriptContent(transcript, minLength);
  }

  static async makeKnownPeopleContent(knownPeople = []) {
    return _makeKnownPeopleContent(knownPeople);
  }

  static async makeOutputExampleContent(exampleJson) {
    return _makeOutputExampleContent(exampleJson);
  }

  static async inference(system, messages, options = {}) {
    return _inference(system, messages, options);
  }

  static async inferenceIABOnly(contents, taskManager, curTaxonomy) {
    return _inferenceIABOnly(contents, taskManager, curTaxonomy)
  }

  static async lazyInference(contents, taskManager, customExample = undefined) {
    return _lazyInference(contents, taskManager, customExample)
  }

  static async tileImages(
    bucket,
    prefix,
    frames,
    maxFrameSequenceImages = MAX_FRAMESEQUENCE_IMAGES,
    title = '',
    outputPrefix = ''
  ) {
    return _tileImages(
      bucket,
      prefix,
      frames,
      maxFrameSequenceImages,
      title,
      outputPrefix
    );
  }
}

async function _makeImageStackContent(images, defaulText = IMAGE_TEXT) {
  const contents = [];

  for (const id in images) {
    const imageId = `image${id}`;
    const imageJson = JSON.stringify({
      [imageId]: {},
    });

    const imageText = defaulText
      .replace('{{IMAGE_ID}}', imageId)
      .replace('{{IMAGE_JSON}}', imageJson);

    contents.push({
      type: 'text',
      text: _deIndent(imageText),
    });

    const image = await images[id].getBase64Async(MIME_JPEG);
    contents.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: image.split(',')[1],
      },
    });
  }

  return contents;
}

async function _makeFrameSequencesContent(images, defaulText = VISUAL_TEXT) {
  const contents = [];

  contents.push({
    type: 'text',
    text: defaulText,
  });

  let base64images = images.map((image) =>
    image.getBase64Async(MIME_JPEG));

  base64images = await Promise.all(base64images);

  for (const base64image of base64images) {
    contents.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: base64image.split(',')[1],
      },
    });
  }

  return contents;
}

async function _makeTranscriptContent(transcript = '', minLength = 50) {
  const contents = [];

  if (transcript.length > minLength) {
    const transcriptText = TRANSCRIPT_TEXT
      .replace('{{TRANSCRIPT}}', transcript);

    contents.push({
      type: 'text',
      text: _deIndent(transcriptText),
    });
  }

  return contents;
}

async function _makeKnownPeopleContent(knownPeople = []) {
  const contents = []

  if (knownPeople.length > 0) {
    const names = knownPeople
      .map((name) => `- ${name}`)
      .join('\n');

    const knownPeopleText = KNOWN_PEOPLE_TEXT
      .replace('{{KNOWN_PEOPLE}}', names);

    contents.push({
      type: 'text',
      text: _deIndent(knownPeopleText),
    });
  }

  return contents;
}

async function _makeOutputExampleContent(exampleJson) {
  const contents = [];

  const outputExampleText = OUTPUT_EXAMPLE_TEXT
    .replace('{{OUTPUT}}', JSON.stringify(exampleJson));

  contents.push({
    type: 'text',
    text: _deIndent(outputExampleText),
  });

  return contents;
}

async function _inference(system, messages, options = {}) {
  const t0 = Date.now();

  if (Model === undefined) {
    await loadModelConfigs(ProxyBucket, ModelListLocation);
    Model = await getPreferredModel(['sonnet']);
  }

  // console.log(_deIndent(system));
  const { modelId, modelVersion, modelRegion } = Model;
  let anthropic_version;
  if (modelId && modelId.indexOf('claude') > 0) {
    anthropic_version = modelVersion;
  }

  const modelParams = {
    anthropic_version,
    max_tokens: 4096,
    temperature: 0.1,
    stop_sequences: ['\n\nHuman:'],
    ...options,
    messages,
    system: _deIndent(system),
  };

  const response = await _invokeEndpoint(modelId, modelRegion, modelParams);
  if (response === undefined) {
    return response;
  }

  const {
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
    content = [],
  } = response;

  let result = {
    usage: {
      inputTokens,
      outputTokens,
    },
    apiCount: 1,
    inferenceTime: Date.now() - t0,
  };

  if (!(content[0] || {}).json) {
    return result;
  }

  result = {
    ...result,
    ...content[0].json,
  };

  if ((result.iabTaxonomy || {}).text) {
    const found = searchTaxonomyByName(result.iabTaxonomy.text);
    if (found) {
      result.iabTaxonomy.id = found.UniqueID;
    } else {
      result.iabTaxonomy.id = '0';
    }
  }

  // console.log('_inference', JSON.stringify(content[0].json, null, 2));

  return result;
}

async function _inferenceIABOnly(contents, taskManager, curTaxonomy) {
  if (!curTaxonomy) {
    return undefined;
  }

  let response = {
    iabTaxonomy: {
      ...curTaxonomy,
      id: 0,
    },
  };

  const found = searchTaxonomyByName(curTaxonomy.text);
  if (!found) {
    return response;
  }

  response.iabTaxonomy.id = found.UniqueID;

  const subTiers = findAllTierTaxonomies([found]);
  if (!subTiers.length) {
    return response;
  }

  const task = taskManager.getTaskByName('iabTaxonomy');
  const system = taskManager.resolveSystem([task]);

  // rebuild the messages
  const messages = [];

  // done with input messages
  messages.push({
    role: 'user',
    content: contents
  });

  messages.push({
    role: 'assistant',
    content: 'What output format?',
  });

  messages.push({
    role: 'user',
    content: await _makeOutputExampleContent(task.example),
  });

  messages.push({
    role: 'assistant',
    content: '{',
  });

  response = await _inference(system, messages);

  if (((response || {}).iabTaxonomy || {}).text) {
    const found = subTiers
      .find((x) =>
        x.Name === response.iabTaxonomy.text);
    if (found) {
      response.iabTaxonomy.id = found.UniqueID;
    }
  }

  return response;
}

async function _lazyInference(contents, taskManager, customExample = undefined) {
  if (!contents || !contents.length) {
    throw new Error('Expects contents to be present');
  }

  const tasks = taskManager.getAvailableTasks();
  const system = taskManager.resolveSystem(tasks);

  let messages = [];

  messages.push({
    role: 'user',
    content: contents
  });

  messages.push({
    role: 'assistant',
    content: 'What output format?',
  });

  let example = customExample;
  if (example === undefined) {
    example = tasks
      .reduce((a0, c0) => ({
        ...a0,
        ...c0.example,
      }), {});
  }

  const outputExampleElement = await _makeOutputExampleContent(example);

  messages.push({
    role: 'user',
    content: outputExampleElement,
  });

  messages.push({
    role: 'assistant',
    content: '{',
  });

  const response = await _inference(system, messages);

  // if (response.iabTaxonomy) {
  //   const responseIABOnly = await _inferenceIABOnly(contents, taskManager, response.iabTaxonomy);

  //   if (responseIABOnly) {
  //     if (responseIABOnly.apiCount) {
  //       response.apiCount += (responseIABOnly.apiCount || 0);
  //     }

  //     if (responseIABOnly.inferenceTime) {
  //       response.inferenceTime += (responseIABOnly.inferenceTime || 0);
  //     }

  //     if ((responseIABOnly.usage || {}).inputTokens) {
  //       response.usage.inputTokens += responseIABOnly.usage.inputTokens;
  //       response.usage.outputTokens += responseIABOnly.usage.outputTokens;
  //     }

  //     // console.log('=====================================');
  //     // console.log('response', JSON.stringify(response, null, 2));
  //     // console.log('responseIABOnly', JSON.stringify(responseIABOnly, null, 2));
  //     // console.log('=====================================');

  //     response.iabTaxonomy = {
  //       ...response.iabTaxonomy,
  //       ...responseIABOnly.iabTaxonomy,
  //     };
  //   }
  // }

  return response;
}

async function _tileImages(
  bucket,
  prefix,
  frames,
  maxFrameSequenceImages = MAX_FRAMESEQUENCE_IMAGES,
  title = '',
  outputPrefix = ''
) {
  if (!frames || frames.length === 0) {
    return [];
  }

  // check the image size and orientation
  const key = join(prefix, frames[0].name)
  const image = await imageFromS3(bucket, key);
  const imgW = image.bitmap.width;
  const imgH = image.bitmap.height;

  let factor = TILE_WXH[0] / imgW;

  // Portrait mode?
  if (imgH > imgW) {
    factor = TILE_WXH[0] / imgH;
  }

  const tileW = Math.round((factor * imgW) / 2) * 2;
  const tileH = Math.round((factor * imgH) / 2) * 2;

  const nCol = Math.floor(MAX_IMAGE_WXH[0] / tileW);
  const nRow = Math.floor(MAX_IMAGE_WXH[1] / tileH);

  // max number of frame images per image
  const numFramesPerImage = nCol * nRow;

  let selectedFrames = frames;

  const maxFramesAllowed = numFramesPerImage * maxFrameSequenceImages;
  if (frames.length > maxFramesAllowed) {
    selectedFrames = _getEquallyDistributedSubset(
      frames,
      maxFramesAllowed
    );

    console.log(`getEquallyDistributedSubset: ${frames.length} -> ${selectedFrames.length} [maxFramesAllowed=${maxFramesAllowed}, ColxRow=${nCol}x${nRow}]`);
  }

  let images = [];

  while (selectedFrames.length > 0) {
    const framesPerImage = selectedFrames.splice(0, numFramesPerImage);

    images.push(_tileImage(
      bucket,
      prefix,
      framesPerImage,
      [tileW, tileH],
      [nCol, nRow]
    ));
  }

  images = await Promise.all(images);

  const names = await _uploadImages(bucket, outputPrefix, title, images);

  return [images, names];
}

async function _tileImage(
  bucket,
  prefix,
  frames,
  tileWxH,
  grid,
  borderSize = BORDER_SIZE
) {
  const nCol = grid[0];
  const nRow = Math.ceil(frames.length / nCol);

  const [tileW, tileH] = tileWxH;
  const compositeW = tileW * nCol;
  const compositeH = tileH * nRow;

  const frameSequenceImage = await imageFromScratch(compositeW, compositeH);

  for (let row = 0; row < nRow && frames.length > 0; row += 1) {
    for (let col = 0; col < nCol && frames.length > 0; col += 1) {
      const frame = frames.shift();
      const key = join(prefix, frame.name);

      const frameImage = await imageFromS3(bucket, key)
        .then((img) => {
          const w = tileW - (borderSize * 2);
          const h = tileH - (borderSize * 2);
          return img.resize(w, h);
        });

      const l = col * tileW + borderSize;
      const t = row * tileH + borderSize;
      frameSequenceImage.blit(frameImage, l, t);
    }
  }

  return frameSequenceImage.quality(80);
}

function _deIndent(str) {
  if (!str) {
    return str;
  }

  return str
    .split('\n')
    .map((s) => s.trim())
    .join('\n')
}

function _getEquallyDistributedSubset(frames, maxFrames) {
  if (!Array.isArray(frames) || !maxFrames) {
    return [];
  }

  const step = Math.ceil(frames.length / maxFrames);

  let selected = [];
  const secondPass = [];

  for (let i = 0; i < frames.length; i += 1) {
    if ((i % step) === 0) {
      selected.push(frames[i]);
    } else {
      secondPass.push(frames[i]);
    }

    if (selected.length >= maxFrames) {
      break;
    }
  }

  // fill the frames by the highest laplacians
  const remaining = maxFrames - selected.length;

  if (remaining > 0) {
    secondPass.sort((a, b) =>
      b.laplacian - a.laplacian);

    selected = selected.concat(secondPass.splice(0, remaining));
  }

  selected.sort((a, b) =>
    a.timestamp - b.timestamp);

  return selected;
}

function _getBedrockRuntimeClient(modelRegion) {
  if (_bedrockRuntimeClient === undefined) {
    _bedrockRuntimeClient = xraysdkHelper(new BedrockRuntimeClient({
      region: modelRegion,
      customUserAgent: CustomUserAgent,
      retryStrategy: retryStrategyHelper(4),
    }));
  }

  return _bedrockRuntimeClient;
}

async function _invokeEndpoint(modelId, modelRegion, modelParams) {
  const runtimeClient = _getBedrockRuntimeClient(modelRegion);

  const body = JSON.stringify(modelParams);

  const params = {
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body,
  };

  const command = new InvokeModelCommand(params);

  let response = await runtimeClient.send(command)
    .catch((e) => {
      const payloadSize = Buffer.byteLength(body);
      console.log(`[ERR]: InvokeModelCommand: ${e.name} - ${e.message} [${e.code}] (payload = ${payloadSize})`);
      throw e;
    });

  response = new TextDecoder().decode(response.body);
  response = JSON.parse(response);

  const {
    content = [],
  } = response;

  if ((content[0] || {}).text) {
    const jsonOutput = _parseOutputContent(content[0].text);

    if (jsonOutput === undefined) {
      console.log('WARNING!!! Fail to parse content output?', content[0].text);
    } else {
      response.content[0].json = jsonOutput;
    }
  }

  return response;
}

function _parseOutputContent(text) {
  if (!text) {
    return undefined;
  }

  let jsonstring = text;
  if (jsonstring[0] !== '{') {
    jsonstring = `{${jsonstring}`;
  }

  let data;

  try {
    data = JSON.parse(jsonstring);
    return data;
  } catch (e) {
    console.log(e);
  }

  // try to repair the json
  try {
    data = jsonrepair(jsonstring);
    return data;
  } catch (e) {
    console.log(e);
  }

  // last attempt
  // find '{' and '}' boundary to parse again.
  let idx = jsonstring.indexOf('{');
  if (idx < 0) {
    return undefined;
  }
  jsonstring = jsonstring.slice(idx);

  idx = jsonstring.lastIndexOf('}');
  if (idx < 0) {
    return undefined;
  }
  jsonstring = jsonstring.slice(0, idx + 1);

  try {
    data = JSON.parse(jsonstring);
  } catch (e) {
    console.log(e);
  }

  return data;
}

async function _uploadImages(bucket, prefix, localPath, images) {
  if (!(prefix && localPath)) {
    return [];
  }

  let jpegFiles = images
    .map((image) =>
      image.getBufferAsync(MIME_JPEG));
  jpegFiles = await Promise.all(jpegFiles);

  if (DEBUG_FRAMES && localPath.length > 0) {
    createDir(localPath);
  }

  jpegFiles = jpegFiles
    .map((jpeg, idx) => {
      const name = `sequence-${String(idx).padStart(3, '0')}.jpg`;

      if (DEBUG_FRAMES) {
        const file = join(localPath, name);
        writeFileSync(file, jpeg);
      }

      return uploadFile(bucket, prefix, name, jpeg)
        .then(() => name);
    });
  jpegFiles = await Promise.all(jpegFiles);

  return jpegFiles;
}

module.exports = ContextualHelper;

