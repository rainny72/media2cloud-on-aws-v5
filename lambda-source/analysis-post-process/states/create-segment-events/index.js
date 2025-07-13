// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  // parse,
  join,
} = require('node:path');
const {
  CommonUtils: {
    download,
    uploadFile,
    freeHeapMemory,
    debugLocally,
  },
  SimpleGeometry: {
    timeIntersected,
  },
  SegmentHelper: {
    JSON_SMPTE_ELEMENT,
    JSON_SCENE,
    TYPE_BLACKFRAMES,
    TYPE_MONOCHROMEFRAMES,
    TYPE_COLORBARS,
    TYPE_TECHNICAL_SLATE,
    TYPE_COUNTDOWNCLOCK,
    TYPE_IDENTS,
    TYPE_TEXTLESSELEMENT,
    // subtypes within Main Program
    TYPE_RECAP,
    TYPE_INTRO,
    TYPE_OPENINGCREDITS,
    TYPE_TITLE,
    TYPE_TRANSITION,
    TYPE_NEXTEPISODE_CREDITS,
    TYPE_ENDCREDITS,
    TYPE_PROGRAMME,
    // misc. types
    TYPE_POSTCREDITS_SCENE,
    TYPE_UNDEFINED,
    TYPE_RATING,
    // loudness tags
    TAG_ABSOLUTESILENT,
    TAG_VERYQUIET,
    // IMF definitions
    CompositionPlaylist,
  },
} = require('core-lib');
const {
  getDefaultTemplate,
  identifyProgramStructure,
} = require('./sequenceHelper');
const {
  CustomPromptTemplate,
} = require('../shared/defs');
const BaseState = require('../shared/base');

const REK_COLORBARS = 'ColorBars';
const REK_ENDCREDITS = 'EndCredits';
const REK_BLACKFRAMES = 'BlackFrames';
const REK_OPENINGCREDITS = 'OpeningCredits';
const REK_STUDIOLOGO = 'StudioLogo';
const REK_SLATE = 'Slate';
const REK_CONTENT = 'Content';

const LOUDNESS_TAGS = [TAG_ABSOLUTESILENT, TAG_VERYQUIET];

class StateCreateSegmentEvents extends BaseState {
  static opSupported(op) {
    return op === 'StateCreateSegmentEvents';
  }

  async process() {
    const {
      bucket, prefix, shotsToScenes,
    } = this.structural || {};

    let promises = [];

    const outputs = await this.downloadAllOutputs();

    const {
      frameEmbeddings: { frames },
    } = outputs;

    const frameMap = {};
    for (const frame of frames) {
      frameMap[String(frame.frameNum)] = frame;
    }
    delete outputs.frameEmbeddings;
    freeHeapMemory();

    let { sceneShots = [] } = outputs;

    await this.identifyProgramStructure(sceneShots);

    sceneShots = _tagSegmentTypeToScenes(sceneShots, frameMap);

    const groupBySegmentType = _groupScenesBySegmentType(sceneShots);

    let structuralElements = _toStructuralElements(groupBySegmentType);

    structuralElements = _validateTemporalOrder(structuralElements);

    let smpteElements = _toSmpteElements(sceneShots, structuralElements, frameMap);

    const { programName } = sceneShots[0] || {};
    smpteElements = {
      programName,
      smpteElements,
    };

    let scenesOutputV4 = _toSceneOutputV4(structuralElements, sceneShots, frameMap);
    scenesOutputV4 = {
      framePrefix: prefix,
      scene: scenesOutputV4,
    };

    const proxyPrefix = this.proxyPrefix;
    const outData = [
      [prefix, shotsToScenes, sceneShots],
      [prefix, JSON_SMPTE_ELEMENT, smpteElements],
      [join(proxyPrefix, 'metadata/scene'), JSON_SCENE, scenesOutputV4],
    ];

    for (const [outPrefix, name, data] of outData) {
      promises.push(uploadFile(bucket, outPrefix, name, data));
    }

    await Promise.all(promises);
    this.structural.smpteElements = JSON_SMPTE_ELEMENT;

    return this.stateData;
  }

  async downloadAllOutputs() {
    const {
      bucket, prefix, embeddings, shotsToScenes,
    } = this.structural || {};

    const dataFiles = [];
    // shots_to_scenes
    dataFiles.push(['sceneShots', join(prefix, shotsToScenes)]);
    // frame_embeddings
    dataFiles.push(['frameEmbeddings', join(prefix, embeddings)]);

    const outputs = {};

    let promises = [];
    for (const [field, key] of dataFiles) {
      promises.push(download(bucket, key)
        .then((res) => {
          outputs[field] = JSON.parse(res);
        }));
    }
    await Promise.all(promises);

    return outputs;
  }

  async identifyProgramStructure(scenes = []) {
    if (scenes.length === 0) {
      return undefined;
    }

    const { programStructure } = CustomPromptTemplate;
    let instruction = getDefaultTemplate();
    instruction = await this.getUserDefinedTemplate(programStructure, instruction);

    // const model = await getModel('nova-pro');
    const model = await this.getModel('sonnet');

    let programStructureResponse = await identifyProgramStructure(model, scenes, instruction);

    console.log('==== programStructureResponse ===== ');
    console.log(JSON.stringify(programStructureResponse.response.jsonOutput, null, 2));
    scenes[0].programStructureResponse = programStructureResponse;

    return programStructureResponse;
  }
}

function _validateTemporalOrder(structuralElements) {
  // disable the logic for now...
  const enabled = false;
  if (!enabled) {
    return structuralElements;
  }

  const priorTypes = [];

  for (const element of structuralElements) {
    const { type } = element;

    let suggestedType = type;
    if (type === TYPE_TECHNICAL_SLATE) {
      suggestedType = _validateTechnicalSlateType(element, priorTypes);
    } else if (type === TYPE_COUNTDOWNCLOCK) {
      suggestedType = _validateCountdownClockType(element, priorTypes);
    } else if (type === TYPE_RECAP) {
      suggestedType = _validateRecapType(element, priorTypes);
    } else if (type === TYPE_INTRO) {
      suggestedType = _validateIntroType(element, priorTypes);
    } else if (type === TYPE_OPENINGCREDITS) {
      suggestedType = _validateOpenCreditsType(element, priorTypes);
    } else if (type === TYPE_PROGRAMME) {
      suggestedType = _validateProgrammeType(element, priorTypes);
    } else if (type === TYPE_ENDCREDITS) {
      suggestedType = _validateEndCreditsType(element, priorTypes);
    } else if (type === TYPE_TRANSITION) {
      suggestedType = _validateTransitionType(element, priorTypes);
    } else if (type === TYPE_TEXTLESSELEMENT) {
      suggestedType = _validateTextlessElement(element, priorTypes);
    }

    priorTypes.push(suggestedType);

    if (suggestedType !== type) {
      element.misclassified = true;
      element.suggestedType = suggestedType;
    }
  }

  return structuralElements;
}

function _validateTechnicalSlateType(element, priorTypes) {
  const allowList = [
    TYPE_MONOCHROMEFRAMES,
    TYPE_COLORBARS,
    TYPE_COUNTDOWNCLOCK,
    TYPE_TECHNICAL_SLATE,
    TYPE_BLACKFRAMES,
  ];

  if (!_typeAllowed(priorTypes, allowList)) {
    return TYPE_PROGRAMME;
  }

  return element.type;
}

function _validateCountdownClockType(element, priorTypes) {
  const allowList = [
    TYPE_MONOCHROMEFRAMES,
    TYPE_COLORBARS,
    TYPE_TECHNICAL_SLATE,
    TYPE_COUNTDOWNCLOCK,
  ];

  if (!_typeAllowed(priorTypes, allowList)) {
    return _validateTransitionType(element, priorTypes);
  }

  return element.type;
}

function _validateRecapType(element, priorTypes) {
  const allowList = [
    TYPE_MONOCHROMEFRAMES,
    TYPE_COLORBARS,
    TYPE_COUNTDOWNCLOCK,
    TYPE_TECHNICAL_SLATE,
    TYPE_IDENTS,
  ];

  if (!_typeAllowed(priorTypes, allowList)) {
    // check to see if transcript has marked a known type
    const { scenes } = element;
    for (const scene of scenes) {
      const { sequenceType } = scene;
      if (sequenceType !== undefined) {
        return sequenceType;
      }
    }
    return TYPE_INTRO;
  }

  return element.type;
}

function _validateIntroType(element, priorTypes) {
  const allowList = [
    TYPE_MONOCHROMEFRAMES,
    TYPE_COLORBARS,
    TYPE_COUNTDOWNCLOCK,
    TYPE_TECHNICAL_SLATE,
    TYPE_IDENTS,
    TYPE_RECAP,
  ];

  if (!_typeAllowed(priorTypes, allowList)) {
    // check to see if transcript has marked a known type
    const { scenes } = element;
    for (const scene of scenes) {
      const { sequenceType } = scene;
      if (sequenceType !== undefined) {
        return sequenceType;
      }
    }
    return TYPE_PROGRAMME;
  }

  return element.type;
}

function _validateOpenCreditsType(element, priorTypes) {
  const disallowedList = [
    TYPE_ENDCREDITS,
    TYPE_POSTCREDITS_SCENE,
    TYPE_TEXTLESSELEMENT,
  ];

  if (_typeDisallowed(priorTypes, disallowedList)) {
    // check to see if transcript has marked a known type
    const { scenes } = element;
    for (const scene of scenes) {
      const { sequenceType } = scene;
      if (sequenceType !== undefined) {
        return sequenceType;
      }
    }
    return TYPE_PROGRAMME;
  }

  return element.type;
}

function _validateProgrammeType(element, priorTypes) {
  const disallowedList = [
    TYPE_ENDCREDITS,
    TYPE_POSTCREDITS_SCENE,
    TYPE_TEXTLESSELEMENT,
  ];

  if (_typeDisallowed(priorTypes, disallowedList)) {
    const { scenes } = element;
    for (const scene of scenes) {
      const { loudnessLevel, transcripts = [] } = scene;
      // scene after endcredits with dialogues
      if (transcripts.length > 0) {
        return TYPE_POSTCREDITS_SCENE;
      }
      // scene after endcredits but not silent
      if (!LOUDNESS_TAGS.includes(loudnessLevel)) {
        return TYPE_UNDEFINED;
      }
    }
    // scene after endcredits and silent
    return TYPE_TEXTLESSELEMENT;
  }

  return element.type;
}

function _validateEndCreditsType(element, priorTypes) {
  priorTypes;
  return element.type;
}

function _validateTransitionType(element, priorTypes) {
  priorTypes;

  if (_isTransitionType(element.scenes)) {
    return TYPE_TRANSITION;
  }

  // assume it is part of the programme
  return TYPE_PROGRAMME;
}

function _validateTextlessElement(element, priorTypes) {
  // textless element must have endcredits prior to it.
  if (!priorTypes.includes(TYPE_ENDCREDITS)) {
    return TYPE_PROGRAMME;
  }
  return element.type;
}

function _isTransitionType(scenes) {
  // see if it is qualified to be a divider scene
  let sceneArray = scenes;
  if (!Array.isArray(sceneArray)) {
    sceneArray = [scenes];
  }

  for (const scene of sceneArray) {
    if (_isTransitionSegment(scene)) {
      return true;
    }
  }
  return false;
}

function _typeAllowed(types, allowList) {
  const extendedList = allowList.concat([
    TYPE_BLACKFRAMES,
    TYPE_UNDEFINED,
  ]);

  for (const type of types) {
    if (!extendedList.includes(type)) {
      return false;
    }
  }
  return true;
}

function _typeDisallowed(types, disallowList) {
  for (const type of types) {
    if (disallowList.includes(type)) {
      return true;
    }
  }
  return false;
}

function _tagSegmentTypeToScenes(sceneShots, frameMap) {
  if (sceneShots.length === 0) {
    return sceneShots;
  }

  // clean up
  if (debugLocally()) {
    for (const scene of sceneShots) {
      delete scene.programName;
      delete scene.segmentType;
      delete scene.segmentTypeGroup;
    }
  }

  const scene0 = sceneShots[0];
  const {
    programStructureResponse: {
      response: { jsonOutput },
    },
  } = scene0;
  const {
    program_name, list_of_key_elements,
  } = jsonOutput;

  scene0.programName = program_name || TYPE_UNDEFINED;

  for (const scene of sceneShots) {
    const { timestampRange: [tmin, tmax] } = scene;

    _tagKnownSegmentType(scene, frameMap);

    // tag based on nova program structure analysis
    for (const element of list_of_key_elements) {
      const { start, end, sequence_type } = element;
      if (timeIntersected([start, end], [tmin, tmax], false)) {
        scene.segmentTypeGroup = sequence_type;
        if (scene.segmentType === undefined) {
          scene.segmentType = sequence_type;
        }
      }
    }

    if (scene.segmentTypeGroup === undefined) {
      scene.segmentTypeGroup = TYPE_UNDEFINED;
    }
    if (scene.segmentType === undefined) {
      scene.segmentType = TYPE_UNDEFINED;
    }
  }

  return sceneShots;
}

function _tagKnownSegmentType(scene, frameMap) {
  const { knownType } = scene;

  let segmentType;
  let segmentTypeGroup;

  const mappings = [
    [TYPE_BLACKFRAMES, TYPE_BLACKFRAMES],
    [TYPE_MONOCHROMEFRAMES, TYPE_TRANSITION],
  ];

  for (const [from, to] of mappings) {
    if (knownType === from) {
      segmentTypeGroup = to;
      segmentType = to;
    }
  }

  // make sure blackframes is not being misclassified
  if (segmentType === TYPE_BLACKFRAMES
    && _isBlackFrameSegment(scene, frameMap) === false) {
    segmentTypeGroup = TYPE_TRANSITION;
    segmentType = TYPE_TRANSITION;
  }
  if (segmentType === TYPE_TRANSITION
    && _isTransitionSegment(scene) === false) {
    segmentTypeGroup = TYPE_PROGRAMME;
    segmentType = TYPE_PROGRAMME;
  }

  scene.segmentTypeGroup = segmentTypeGroup;
  scene.segmentType = segmentType;
}

function _toSmpteElements(sceneShots, structuralElements, frameMap) {
  let smpteElements = [];
  let elements;

  // recap
  elements = _smpteRecap(sceneShots, frameMap);
  smpteElements = smpteElements.concat(elements);

  // opening credits
  elements = _smpteOpeningCredits(sceneShots, frameMap);
  smpteElements = smpteElements.concat(elements);

  // closing credits
  elements = _smpteClosingCredits(sceneShots, frameMap);
  smpteElements = smpteElements.concat(elements);

  // Next Episode
  elements = _smpteNextEpisode(sceneShots, frameMap);
  smpteElements = smpteElements.concat(elements);

  // first/last frame of composition
  elements = _smpteComposition(structuralElements, frameMap);
  smpteElements = smpteElements.concat(elements);

  for (const element of structuralElements) {
    const elements = _smpteElement(element, frameMap);
    smpteElements = smpteElements.concat(elements);
  }

  smpteElements.sort((a, b) =>
    a.timestampMillis - b.timestampMillis);

  return smpteElements;
}

function _smpteComposition(structuralElements, frameMap) {
  const compositionStart = [
    TYPE_OPENINGCREDITS,
    TYPE_RECAP, TYPE_INTRO, TYPE_PROGRAMME,
    TYPE_RATING, TYPE_TITLE, TYPE_TRANSITION,
  ];
  const compositionEnd = [
    TYPE_ENDCREDITS, TYPE_NEXTEPISODE_CREDITS, TYPE_PROGRAMME,
  ];

  let FFOC;
  let LFOC;

  for (const element of structuralElements) {
    if (compositionStart.includes(element.type)) {
      FFOC = element;
      break;
    }
  }

  if (FFOC) {
    const reversedOrder = structuralElements.slice();
    reversedOrder.sort((a, b) =>
      b.timestampRange[0] - a.timestampRange[0]);

    for (const element of reversedOrder) {
      if (compositionEnd.includes(element.type)) {
        LFOC = element;
        break;
      }
    }
  }

  const smpteElements = [];
  if (FFOC && LFOC) {
    FFOC = _makeSmpteElement('FFOC', FFOC, frameMap);
    smpteElements.push(FFOC);

    LFOC = _makeSmpteElement('LFOC', LFOC, frameMap, true);
    smpteElements.push(LFOC);
  }

  return smpteElements;
}

function _smpteRecap(scenes, frameMap) {
  const recap = [];
  for (const scene of scenes) {
    const { segmentTypeGroup } = scene;
    if (segmentTypeGroup === TYPE_RECAP) {
      recap.push(scene);
    }
  }

  const smpteElements = [];
  if (recap.length === 0) {
    return [];
  }
  recap.sort((a, b) => a.scene - b.scene);

  const structural = { type: TYPE_RECAP, scenes: recap };

  let element = _makeSmpteElement('FFER', structural, frameMap);
  smpteElements.push(element);

  element = _makeSmpteElement('LFER', structural, frameMap, true);
  smpteElements.push(element);

  return smpteElements;
}

function _smpteOpeningCredits(scenes, frameMap) {
  // Group both Title sequence and opening credits
  const sequences = [TYPE_OPENINGCREDITS, TYPE_TITLE];
  const opening = [];
  for (const scene of scenes) {
    const { segmentTypeGroup } = scene;
    if (sequences.includes(segmentTypeGroup)) {
      opening.push(scene);
    }
    if (segmentTypeGroup === TYPE_PROGRAMME) {
      break;
    }
  }

  const smpteElements = [];
  if (opening.length === 0) {
    return [];
  }
  opening.sort((a, b) => a.scene - b.scene);

  const structural = { type: TYPE_OPENINGCREDITS, scenes: opening };

  let element = _makeSmpteElement('FFTC', structural, frameMap);
  smpteElements.push(element);

  element = _makeSmpteElement('LFTC', structural, frameMap, true);
  smpteElements.push(element);

  return smpteElements;
}

function _smpteClosingCredits(scenes, frameMap) {
  const closing = [];
  for (const scene of scenes) {
    const { segmentTypeGroup } = scene;
    if (segmentTypeGroup === TYPE_ENDCREDITS) {
      closing.push(scene);
    }
  }

  const smpteElements = [];
  if (closing.length === 0) {
    return [];
  }
  closing.sort((a, b) => a.scene - b.scene);

  const structural = { type: TYPE_ENDCREDITS, scenes: closing };

  let element = _makeSmpteElement('FFEC', structural, frameMap);
  smpteElements.push(element);

  element = _makeSmpteElement('LFEC', structural, frameMap, true);
  smpteElements.push(element);

  return smpteElements;
}

function _smpteNextEpisode(scenes, frameMap) {
  const nextEpisode = [];
  for (const scene of scenes) {
    const { segmentTypeGroup } = scene;
    if (segmentTypeGroup === TYPE_NEXTEPISODE_CREDITS) {
      nextEpisode.push(scene);
    }
  }

  const smpteElements = [];
  if (nextEpisode.length === 0) {
    return [];
  }
  nextEpisode.sort((a, b) => a.scene - b.scene);

  const structural = { type: TYPE_NEXTEPISODE_CREDITS, scenes: nextEpisode };

  let element = _makeSmpteElement('FFUN', structural, frameMap);
  smpteElements.push(element);

  element = _makeSmpteElement('LFUN', structural, frameMap, true);
  smpteElements.push(element);

  return smpteElements;
}

function _smpteElement(element, frameMap) {
  const type = element.type;
  let firstFrameXX;
  let lastFrameXX;
  let fixedPointInsertion; // commercial break insertion

  if (type === TYPE_COLORBARS) {
    firstFrameXX = 'FFBT';
    lastFrameXX = 'LFBT';
  } else if (type === TYPE_BLACKFRAMES) {
    firstFrameXX = 'FFCB';
    lastFrameXX = 'LFCB';
    // } else if (type === TYPE_TITLE) {
    //   firstFrameXX = 'FFCB';
    //   lastFrameXX = 'LFCB';
  } else if (type === TYPE_TECHNICAL_SLATE) {
    firstFrameXX = 'FFHS';
    lastFrameXX = 'LFHS';
  } else if (type === TYPE_IDENTS) {
    firstFrameXX = 'FFCL';
    lastFrameXX = 'LFCL';
  } else if (type === TYPE_RATING) {
    firstFrameXX = 'FFOB';
    lastFrameXX = 'LFOB';
  } else if (type === TYPE_TEXTLESSELEMENT) {
    firstFrameXX = 'FTXM';
    lastFrameXX = 'LTXM';
  } else if (type === TYPE_TRANSITION) {
    fixedPointInsertion = 'FPCI';
  }

  if (fixedPointInsertion) {
    const smpteElement = _makeSmpteElement(fixedPointInsertion, element, frameMap);
    return [smpteElement];
  }

  if (firstFrameXX) {
    const smpteElementFF = _makeSmpteElement(firstFrameXX, element, frameMap);
    const smpteElementLF = _makeSmpteElement(lastFrameXX, element, frameMap, true);

    return [smpteElementFF, smpteElementLF];
  }

  return [];
}

function _makeSmpteElement(label, element, frameMap, useLastFrame = false) {
  let frame = element.scenes[0].frameRange[0];
  if (useLastFrame) {
    frame = element.scenes[element.scenes.length - 1].frameRange[1];
  }

  if (frameMap[String(frame)] === undefined) {
    throw new Error(`Fail to find Frame#${frame}`);
  }

  const {
    frameNum,
    smpteTimecode,
    timestampMillis,
  } = frameMap[String(frame)];

  const desc = _lookupIMFCompositionPlaylist(label);

  return {
    type: element.type,
    label,
    desc,
    frameNum,
    smpteTimecode,
    timestampMillis,
  };
}

function _lookupIMFCompositionPlaylist(label) {
  for (const item of CompositionPlaylist) {
    if (label === item.label) {
      return item.desc;
    }
  }
  return undefined;
}

function _groupScenesBySegmentType(sceneShots) {
  if (sceneShots.length === 0) {
    return sceneShots;
  }

  const segmentTypeGroups = [];
  let curGroup = [sceneShots[0]];

  for (let i = 1; i < sceneShots.length; i += 1) {
    const pre = curGroup[curGroup.length - 1];
    const cur = sceneShots[i];

    const { segmentTypeGroup: groupA } = pre;
    const { segmentTypeGroup: groupB } = cur;

    if (groupA !== groupB) {
      segmentTypeGroups.push(curGroup);
      curGroup = [cur];
      continue;
    }

    curGroup.push(cur);
  }

  if (curGroup.length > 0) {
    segmentTypeGroups.push(curGroup);
  }

  return segmentTypeGroups;
}

function _makeStructuralElement(group, type = TYPE_UNDEFINED) {
  if (group.length === 0) {
    return undefined;
  }

  group.sort((a, b) =>
    a.scene - b.scene);

  const timestampRange = [
    group[0].timestampRange[0],
    group[group.length - 1].timestampRange[1],
  ];

  return { type, timestampRange, scenes: group };
}

function _toStructuralElements(groupBySegmentType) {
  const structuralElements = [];

  for (const group of groupBySegmentType) {
    const { segmentTypeGroup } = group[0];

    const element = _makeStructuralElement(group, segmentTypeGroup);
    if (element) {
      structuralElements.push(element);
    }
  }

  structuralElements.sort((a, b) =>
    a.timestampRange[0] - b.timestampRange[0]);

  return structuralElements;
}

function _isBlackFrameSegment(scene, frameMap) {
  const {
    knownType, frameRange: [fmin, fmax],
  } = scene;

  if (knownType !== TYPE_BLACKFRAMES) {
    // goes into the frame level
    for (let i = fmin; i <= fmax; i += 1) {
      const frame = frameMap[String(i)];

      if (frame !== undefined) {
        const {
          laplacian, loudnessLevel, colorProps,
        } = frame;

        // no color property, won't be a black frame
        if (colorProps === undefined) {
          return false;
        }

        const {
          blackCoveragePercentage,
          dominantColor: [R, G, B],
          dominantColorName,
          isMonochrome,
        } = colorProps;

        // monocolor, no audio, dominate color close to black, assume BlackFrames
        if (isMonochrome && LOUDNESS_TAGS.includes(loudnessLevel) && dominantColorName.indexOf('black') >= 0) {
          continue;
        }

        if (laplacian > 0) {
          return false;
        }

        if (blackCoveragePercentage < 99.0 || (R + G + B) > 0) {
          return false;
        }
      }
    }
  }

  return true;
}

function _isTransitionSegment(scene) {
  const {
    knownType, loudnessLevel, transcripts = [],
  } = scene;
  if (transcripts.length === 0) {
    if (knownType === TYPE_MONOCHROMEFRAMES || LOUDNESS_TAGS.includes(loudnessLevel)) {
      return true;
    }
  }
  return false;
}

function _toSceneOutputV4(structuralElements, sceneShots, frameMap) {
  if (structuralElements.length === 0) {
    throw new Error('structuralElements is empty');
  }

  const groups = [];

  // if first element does not start scene 0, add start padding
  if (structuralElements[0].scenes[0].scene > 0) {
    const { scene } = structuralElements[0].scenes[0];
    groups.push({
      type: TYPE_PROGRAMME,
      sceneRange: [0, scene - 1],
    });
  }

  for (const { type, scenes } of structuralElements) {
    const sceneStart = scenes[0].scene;
    const sceneEnd = scenes[scenes.length - 1].scene;
    const sceneRange = [sceneStart, sceneEnd];

    // pad in-between scenes
    const preGroup = groups[groups.length - 1];
    if (preGroup !== undefined) {
      const { sceneRange: [, preSceneEnd] } = preGroup;
      if ((sceneStart - preSceneEnd) > 1) {
        groups.push({
          type: TYPE_PROGRAMME,
          sceneRange: [preSceneEnd + 1, sceneStart - 1],
        });
      }
    }

    groups.push({
      type,
      sceneRange,
    });
  }

  // pad end
  const lastSceneId = sceneShots[sceneShots.length - 1].scene;
  if (groups[groups.length - 1].sceneRange[1] < lastSceneId) {
    const preSceneEnd = groups[groups.length - 1].sceneRange[1];
    groups.push({
      type: TYPE_PROGRAMME,
      sceneRange: [preSceneEnd + 1, lastSceneId],
    });
  }

  // ensure the order is correct
  for (let i = 1; i < groups.length; i += 1) {
    const pre = groups[i - 1];
    const cur = groups[i];
    if ((cur.sceneRange[0] - pre.sceneRange[1]) !== 1) {
      throw new Error('mismatch sceneRange');
    }
  }

  const sceneMap = {};
  for (const scene of sceneShots) {
    const { scene: sceneNo } = scene;
    sceneMap[String(sceneNo)] = scene;
  }

  const credits = [TYPE_OPENINGCREDITS, TYPE_ENDCREDITS];
  // Now, generate V4 scene output
  const scenesV4 = [];
  for (const { type, sceneRange: [start, end] } of groups) {
    const sceneStart = sceneMap[String(start)];
    const sceneEnd = sceneMap[String(end)];

    let overrideType = type;
    const { segmentTypeGroup } = sceneStart;
    if (credits.includes(segmentTypeGroup) && type !== TYPE_BLACKFRAMES) {
      overrideType = segmentTypeGroup;
    }

    const {
      frameRange: [frameStart,],
      shotRange: [shotStart,],
      timestampRange: [timeStart,],
      smpteTimecodes: [smpteStart,],
    } = sceneStart;
    const {
      frameRange: [, frameEnd],
      shotRange: [, shotEnd],
      timestampRange: [, timeEnd],
      smpteTimecodes: [, smpteEnd],
    } = sceneEnd;

    const duration = timeEnd - timeStart;
    const technicalCueType = _toRekognitionTechnicalCueType(overrideType);

    const keyStart = frameMap[String(frameStart)].name;
    const keyEnd = frameMap[String(frameEnd)].name;

    const scene = {
      sceneNo: scenesV4.length,
      sceneRangeV5: [sceneStart.scene, sceneEnd.scene],
      shotStart,
      frameStart,
      timeStart,
      smpteStart,
      keyStart,
      shotEnd,
      frameEnd,
      timeEnd,
      smpteEnd,
      keyEnd,
      duration,
      technicalCueType,
    };
    scenesV4.push(scene);
  }

  return scenesV4;
}

function _toRekognitionTechnicalCueType(type) {
  let technicalCueType = type;

  // map to rekognition technical cue type
  if (technicalCueType === TYPE_COLORBARS) {
    technicalCueType = REK_COLORBARS;
  } else if (technicalCueType === TYPE_BLACKFRAMES) {
    technicalCueType = REK_BLACKFRAMES;
  } else if (technicalCueType === TYPE_OPENINGCREDITS) {
    technicalCueType = REK_OPENINGCREDITS;
  } else if (technicalCueType === TYPE_ENDCREDITS) {
    technicalCueType = REK_ENDCREDITS;
  } else if (technicalCueType === TYPE_TECHNICAL_SLATE) {
    technicalCueType = REK_SLATE;
  } else if (technicalCueType === TYPE_IDENTS) {
    technicalCueType = REK_STUDIOLOGO;
  } else {
    technicalCueType = REK_CONTENT;
  }

  return technicalCueType;
}

module.exports = StateCreateSegmentEvents;
