// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const PATH = require('node:path');
const {
  StateData: {
    Statuses: {
      Removed,
      AnalysisCompleted,
    },
  },
  AnalysisTypes: {
    Rekognition: {
      Celeb,
      FaceMatch,
    },
    Scene,
  },
  CommonUtils: {
    listObjects,
    download,
    uploadFile,
    deleteObject,
    validateUuid,
    toHHMMSS,
  },
  PromptHelper: {
    enumLevels: {
      FrameLevel,
      ClipLevel,
      SceneLevel,
    },
  },
} = require('core-lib');
const BaseState = require('../shared/baseState');

const AMAZONQ_BUCKET = process.env.ENV_AMAZONQ_BUCKET;
const AMAZONQ_REGION = process.env.ENV_AMAZONQ_REGION;
const M2C_ENDPOINT = process.env.ENV_M2C_ENDPOINT;
const JSON_DOCUMENT = 'document.json';
const JSON_DOCUMENT_METADATA = `${JSON_DOCUMENT}.metadata.json`;
const IGNORED_FIELDS = ['usage', 'apiCount', 'inferenceTime', 'frameSequenceNames', 'framePrefix', 'level', 'skipped'];
const REGEX_SPLIT = /[A-Z]?[a-z]+|[0-9]+|[A-Z]+(?![a-z])/g;
const KNOWN_TAXONOMY = {
  iabtaxonomy: {
    key: 'iab_taxonomy',
    text: 'IAB Taxonomy',
  },
  description: {
    key: 'description',
    text: 'description',
  },
  garmtaxonomy: {
    key: 'garm_taxonomy',
    text: 'Global Alliance for Responsible Media (GARM) Taxonomy',
  },
  brandandlogos: {
    key: 'brands_and_logos',
    text: 'brands and logos',
  },
  tags: {
    key: 'relevant_tags',
    text: 'most relevant tags',
  },
  sentiment: {
    key: 'sentiment',
    text: 'sentiment level',
  },
  mpaarating: {
    key: 'mpaa_rating',
    text: 'Motion Picture Association film rating system (MPAA)',
  },
  ustvrating: {
    key: 'us_tv_rating',
    text: 'US TV Parental Guidelines system',
  },
  camerashotevents: {
    key: 'camera_shot_descriptions',
    text: 'camera shot descriptions',
  },
  // additional image taxonomies
  alttext: {
    key: 'alternative_text',
    text: 'alternative text (ALT_TEXT)',
  },
  filename: {
    key: 'suggested_image_name',
    text: 'image file name',
  },
};

class StateUpdateAmazonQBucket extends BaseState {
  static canHandle(op) {
    return op === 'StateUpdateAmazonQBucket';
  }

  async process() {
    const {
      status,
    } = this.event;

    let response;

    if (!AMAZONQ_BUCKET || !AMAZONQ_REGION || !M2C_ENDPOINT) {
      return this.event;
    }

    if (status === Removed) {
      response = await this.removeRecord();
    } else if (status === AnalysisCompleted) {
      response = await this.updateMedata();
    }

    if (response) {
      response = await this.startDataSourceSync();
    }

    response = {
      ...response,
      ...this.event,
    };

    return response;
  }

  async removeRecord() {
    const {
      uuid,
    } = this.event;

    const region = AMAZONQ_REGION;
    const bucket = AMAZONQ_BUCKET;
    const prefix = PATH.join(uuid, '/');

    let response;
    do {
      const params = {
        ContinuationToken: (response || {}).NextContinuationToken,
        MaxKeys: 300,
      };

      response = await listObjects(bucket, prefix, params, region);

      if ((response || {}).Contents) {
        let promises = [];

        for (const content of response.Contents) {
          const {
            Key: key = '',
          } = content;

          if (key.length > 0) {
            promises.push(deleteObject(bucket, key, region));
          }
        }

        promises = await Promise.all(promises);
      }
    } while ((response || {}).NextContinuationToken);

    return { response };
  }

  async updateMedata() {
    const {
      uuid,
      input: {
        key = '',
        request = {},
      },
      data: {
        video,
        audio,
        image,
        document,
        src: {
          type,
        },
      },
    } = this.event;

    let doc;

    if (video !== undefined) {
      doc = await this.parseVideoMetadata();
    } else if (audio !== undefined) {
      doc = await this.parseAudioMetadata();
    } else if (image !== undefined) {
      doc = await this.parseImageMetadata();
    } else if (document !== undefined) {
      doc = await this.parseDocumentMetadata();
    }

    const title = PATH.parse(key).name;
    let createdAt = Date.now();
    if (request.timestamp) {
      createdAt = new Date(request.timestamp);
    }

    const lastModified = Date.now();

    let promises = [];

    if (doc) {
      const docMetadata = await this.createDocumentMetadataFile(uuid, title, type, createdAt, lastModified);

      const region = AMAZONQ_REGION;
      const bucket = AMAZONQ_BUCKET;
      const prefix = PATH.join(uuid, '/');

      promises.push(uploadFile(bucket, prefix, JSON_DOCUMENT, doc, region));
      promises.push(uploadFile(bucket, prefix, JSON_DOCUMENT_METADATA, docMetadata, region));

      promises = await Promise.all(promises);
    }

    return {
      response: promises,
    };
  }

  async createDocumentMetadataFile(uuid, title, type, createdAt, lastModified) {
    let collectionType;

    if (type === 'video') {
      collectionType = 'Video';
    } else if (type === 'audio') {
      collectionType = 'Podcast';
    } else if (type === 'image') {
      collectionType = 'Photo';
    } else if (type === 'document') {
      collectionType = 'Document';
    }

    let sourceUri = M2C_ENDPOINT;
    if (collectionType) {
      sourceUri = `${M2C_ENDPOINT}/#Collection/${collectionType}/${uuid}`;
    }

    const region = AMAZONQ_REGION;
    const bucket = AMAZONQ_BUCKET;
    const key = PATH.join(uuid, JSON_DOCUMENT_METADATA);

    let doc = await download(bucket, key, true, region)
      .then((res) =>
        JSON.parse(res))
      .catch(() =>
        undefined);

    if (!doc) {
      doc = {
        DocumentId: uuid,
        Title: title,
        ContentType: 'application/json',
        Attributes: {
          _source_uri: sourceUri,
          _version: 1,
          _created_at: new Date(createdAt).toISOString(),
          _last_updated_at: new Date(lastModified).toISOString(),
        },
      };
    } else {
      doc.title = title;
      doc.Attributes._source_uri = sourceUri;
      doc.Attributes._version += 1;
      doc.Attributes._last_updated_at = new Date(lastModified).toISOString();
    }

    return doc;
  }

  async parseVideoMetadata() {
    const {
      uuid,
      input: {
        destination: {
          bucket,
        },
        key = '',
        duration,
      },
      data: {
        video: {
          rekognition,
        },
      },
    } = this.event;

    let doc = await this.parseAudioMetadata();

    if (!rekognition) {
      return doc;
    }

    const {
      [Scene]: sceneData,
      [Celeb]: celebData,
      [FaceMatch]: facematchData,
    } = rekognition;

    const title = PATH.parse(key).name;

    let promises = [];

    if ((sceneData || {}).metadata) {
      promises.push(download(bucket, sceneData.metadata)
        .then((res) => ({
          scene: JSON.parse(res),
        })));
    }

    if ((celebData || {}).metadata) {
      promises.push(download(bucket, celebData.metadata)
        .then((res) => ({
          celeb: JSON.parse(res),
        })));
    }

    if ((facematchData || {}).metadata) {
      promises.push(download(bucket, facematchData.metadata)
        .then((res) => ({
          facematch: JSON.parse(res),
        })));
    }

    promises = await Promise.all(promises);

    promises = promises.reduce((a, b) => ({
      ...a,
      ...b,
    }), doc);

    const hhmmss = toHHMMSS(duration);

    doc = _parseVideoMetadata(promises);

    doc = {
      ...doc,
      title: `The title of this video media file is ${title}. The duration is ${hhmmss}. The media asset identifier (UUID) is ${uuid}.`,
    }

    return doc;
  }

  async parseAudioMetadata() {
    const {
      uuid,
      input: {
        destination: {
          bucket,
        },
        key = '',
        duration,
      },
      data: {
        audio,
      },
    } = this.event;

    if (!audio) {
      return undefined;
    }

    const {
      transcribe: {
        output: transcriptOutput,
        conversations,
      },
    } = audio;

    const title = PATH.parse(key).name;

    let promises = [];

    if (transcriptOutput) {
      promises.push(download(bucket, transcriptOutput)
        .then((res) => ({
          transcript: JSON.parse(res),
        })));
    }

    if (conversations) {
      promises.push(download(bucket, conversations)
        .then((res) => ({
          conversations: JSON.parse(res),
        })));
    }

    promises = await Promise.all(promises);
    promises = promises.reduce((a, b) => ({
      ...a,
      ...b,
    }));

    let doc = _parseAudioMetadata(promises);

    if (Object.keys(doc).length === 0) {
      return undefined;
    }

    const hhmmss = toHHMMSS(duration);

    doc = {
      ...doc,
      title: `The title of this audio media file is ${title}. The duration is ${hhmmss} and the media asset identifier (UUID) is ${uuid}.`,
    };

    return doc;
  }

  async parseImageMetadata() {
    const {
      uuid,
      input: {
        destination: {
          bucket,
        },
        key = '',
      },
      data: {
        image: {
          'rekog-image': rekognition,
        },
      },
    } = this.event;

    if (!rekognition) {
      return undefined;
    }

    const {
      [Celeb]: celebData,
      [FaceMatch]: facematchData,
      caption,
    } = rekognition;

    const title = PATH.parse(key).name;

    let promises = [];

    if ((celebData || {}).output) {
      promises.push(download(bucket, celebData.output)
        .then((res) => ({
          celeb: JSON.parse(res),
        })));
    }

    if ((facematchData || {}).output) {
      promises.push(download(bucket, facematchData.output)
        .then((res) => ({
          facematch: JSON.parse(res),
        })));
    }

    if ((caption || {}).output) {
      promises.push(download(bucket, caption.output)
        .then((res) => ({
          caption: JSON.parse(res),
        })));
    }

    promises = await Promise.all(promises);
    promises = promises.reduce((a, b) => ({
      ...a,
      ...b,
    }));

    let doc = _parseImageMetadata(promises);

    if (Object.keys(doc).length === 0) {
      return undefined;
    }

    doc = {
      ...doc,
      title: `The title of the photo/image file is ${title}. The media asset identifier (UUID) is ${uuid}.`,
    };

    return doc;
  }

  async parseDocumentMetadata() {
    return undefined;
  }

  async startDataSourceSync() {
    return undefined;
  }
}

function _parseVideoMetadata(metadata) {
  const {
    celeb,
    facematch,
    scene,
  } = metadata;

  let knownFaces = [];

  if (celeb) {
    for (const items of Object.values(celeb)) {
      knownFaces = knownFaces.concat(items);
    }
  }

  if (facematch) {
    for (const name of Object.keys(facematch)) {
      if (!validateUuid(name)) {
        knownFaces = knownFaces.concat(facematch[name]);
      }
    }
  }

  let famousPeople = knownFaces
    .map((face) =>
      face.name);
  famousPeople = [...new Set(famousPeople)];

  let frameContextuals = [];
  let sceneContextuals = [];
  let clipContextuals = [];

  if (scene) {
    for (const sceneItem of scene.scene) {
      const {
        details,
        timeStart,
        timeEnd,
      } = sceneItem;

      const timestamps = [timeStart, timeEnd];

      for (const detail of details) {
        const {
          level,
        } = detail;

        if (level === FrameLevel.description) {
          const frameLevel = _buildFrameLevelContextual(detail, timestamps);
          frameContextuals = frameContextuals.concat(frameLevel);
          continue;
        }

        const people = _findKnownPeople(detail, knownFaces);

        if (level === ClipLevel.description) {
          const clipLevel = _buildClipLevelContextual(detail, timestamps, people);
          clipContextuals = clipContextuals.concat(clipLevel);
          continue;
        }

        if (level === SceneLevel.description || level === undefined) {
          const sceneLevel = _buildSceneLevelContextual(detail, timestamps, people);
          sceneContextuals = sceneContextuals.concat(sceneLevel);
        }
      }
    }
  }

  let contextuals = {};

  if (famousPeople.length) {
    contextuals.casts = `The casts, famous people, or celebrities appeared in this media file include ${famousPeople.join(', ')}.`;
  }

  if (clipContextuals.length) {
    contextuals.overall_contextual_information = clipContextuals;
  }

  if (sceneContextuals.length) {
    contextuals.scene_level_contextual_information = sceneContextuals;
  }

  if (frameContextuals.length) {
    contextuals.frame_level_contextual_information = frameContextuals;
  }

  return contextuals;
}

function _parseAudioMetadata(metadata) {
  const {
    conversations,
    transcript,
  } = metadata;

  const doc = {};

  if (((conversations || {}).chapters || []).length > 0) {
    const output = conversations.chapters
      .map((chapter) => {
        const {
          start: timeStart,
          end: timeEnd,
          reason,
        } = chapter;

        const startTimestamp = toHHMMSS(timeStart);
        const endTimestamp = toHHMMSS(timeEnd);

        return {
          conversation_topic: `${reason}. This conversation took place between ${startTimestamp} and ${endTimestamp}`,
          start_timestamp: startTimestamp,
          end_timestamp: endTimestamp,
        };
      });
    doc.conversations = output;
  }

  if ((((transcript || {}).results || {}).transcripts || []).length) {
    const fullTranscript = (transcript.results.transcripts[0] || {}).transcript;
    doc.full_transcript = fullTranscript;

    if (transcript.results.language_code) {
      doc.language_code = transcript.results.language_code;
    }
  }

  return doc;
}

function _parseImageMetadata(metadata) {
  const {
    celeb,
    // facematch,
    caption,
  } = metadata;

  let contextuals = {};

  let famousPeople = [];
  if (((celeb || {}).CelebrityFaces || []).length > 0) {
    famousPeople = celeb.CelebrityFaces
      .map((x) =>
        x.Name);
  }
  famousPeople = [...new Set(famousPeople)];

  if (famousPeople.length) {
    contextuals.famous_people = `${famousPeople.join(', ')} are the celebrities and famous people identified in this image file.`;
  }

  if (caption) {
    const fields = Object.keys(caption)
      .filter((x) =>
        !IGNORED_FIELDS.includes(x));

    for (const field of fields) {
      let contextual = _flattenJsonObject(field, caption[field]);
      contextuals = {
        ...contextuals,
        ...contextual,
      };
    }
  }

  return contextuals;
}

function _findKnownPeople(scene, knownFaces = []) {
  let knownPeople = [];

  if (knownFaces.length === 0) {
    return knownPeople;
  }

  const {
    timeStart,
    timeEnd,
  } = scene;

  for (const face of knownFaces) {
    const {
      name,
      begin,
      end,
    } = face;

    if (begin >= timeStart && end <= timeEnd) {
      knownPeople.push(name);
    }
  }

  knownPeople = [...new Set(knownPeople)];
  return knownPeople;
}

function _buildFrameLevelContextual(item, timestamps) {
  timestamps;
  let frameContextuals = [];

  if (((item || {}).frames || []).length === 0) {
    return frameContextuals;
  }

  for (const frame of item.frames) {
    let frameDetails = {};

    if ((frame['frame'] || {}).timestamp === undefined) {
      continue;
    }

    const timestamp = toHHMMSS(frame['frame'].timestamp);

    for (const field of Object.keys(frame)) {
      // ignore frame object
      if (field === 'frame') {
        continue;
      }

      let frameDetail = _flattenJsonObject(field, frame[field], `at ${timestamp}`);
      frameDetails = {
        ...frameDetails,
        ...frameDetail,
      };
    }

    if (Object.keys(frameDetails).length > 0) {
      const frameContextual = {
        ...frameDetails,
        timestamp,
      };

      frameContextuals.push(frameContextual);
    }
  }

  return frameContextuals;
}

function _buildSceneLevelContextual(item, timestamps, people = []) {
  const fields = Object.keys(item)
    .filter((x) => !IGNORED_FIELDS.includes(x));

  const startTimestamp = toHHMMSS(timestamps[0]);
  const endTimestamp = toHHMMSS(timestamps[1]);

  let contextuals = {}

  for (const field of fields) {
    let contextual = _flattenJsonObject(field, item[field], `from ${startTimestamp} to ${endTimestamp}`);
    contextuals = {
      ...contextuals,
      ...contextual,
    };
  }

  if (people.length > 0) {
    contextuals.famous_people = `${people.join(', ')} are the celebrities and famous people who appear at this scene from ${startTimestamp} to ${endTimestamp}.`;
  }

  if (Object.keys(contextuals).length > 0) {
    contextuals = {
      ...contextuals,
      start_timestamp: startTimestamp,
      end_timestamp: endTimestamp,
    };
  }

  return [contextuals];
}

function _buildClipLevelContextual(item, timestamps, people = []) {
  const contextuals = _buildSceneLevelContextual(item, timestamps, people);

  if (contextuals.length > 0 && people.length > 0) {
    contextuals[0].famous_people = `${people.join(', ')} are the celebrities and famous people who appear in the media file.`;
  }

  return contextuals;
}

function _flattenJsonObject(key, value, temporal = '') {
  let name = key;
  let pronoun = key;

  let matched = KNOWN_TAXONOMY[key.toLowerCase()];

  if (matched) {
    name = matched.key;
    pronoun = matched.text;
  } else {
    matched = key.match(REGEX_SPLIT);
    if (matched && matched.length > 0) {
      name = matched.map((x) => x.toLowerCase()).join('_');
      pronoun = matched.join(' ');
    }
  }

  let texts = [];
  let additionalInfo = [];

  if (Array.isArray(value)) {
    for (const subValue of value) {
      const [subText, subInfo] = _toTextAndAdditionalInfo(subValue);
      texts = texts.concat(subText);
      additionalInfo = additionalInfo.concat(subInfo);
    }
  } else if (typeof value === 'object') {
    [texts, additionalInfo] = _toTextAndAdditionalInfo(value);
  } else if (typeof value === 'string' || typeof value === 'number') {
    texts = [String(value)];
  }

  const response = {};

  if (texts.length > 0) {
    let pluralOrSingular = 'is';
    if (texts.length > 1) {
      pluralOrSingular = 'are';
    }

    response[name] = {
      ...response[name],
      description: `${texts.join(', ')} ${pluralOrSingular} the ${pronoun} identified ${temporal} timestamp(s).`,
    };
  }

  if (additionalInfo.length > 0) {
    response[name] = {
      ...response[name],
      additional_information: additionalInfo,
    };
  }

  return response;
}

function _toTextAndAdditionalInfo(value) {
  const texts = [];
  const additionalInfo = [];

  const subFields = Object.keys(value)
    .filter((x) =>
      x !== 'score');

  for (const subField of subFields) {
    if (typeof value[subField] === 'object') {
      additionalInfo.push({
        [subField]: value[subField],
      });
    } else if (typeof value[subField] === 'string') {
      texts.push(value[subField]);
    }
  }

  return [texts, additionalInfo];
}

module.exports = StateUpdateAmazonQBucket;
