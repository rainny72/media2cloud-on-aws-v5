// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  M2CException,
} = require('core-lib');

const StateMergeScenesAudioSegments = require('./states/merged-scenes-audio-segments');
const StateCreateSequenceImages = require('./states/create-sequence-images');
const StateUpdateSceneShotResults = require('./states/update-scene-shot-results');
const StateSceneSegmentType = require('./states/scene-segment-type');
const StateCreateSegmentEvents = require('./states/create-segment-events');
const StateGenerateAdBreaks = require('./states/generate-ad-breaks');
const StateScenesToChapters = require('./states/scenes-to-chapters');
const StateCreateChapterSequences = require('./states/create-chapter-sequences');
const StateMapIterationCompleted = require('./states/map-iterators-completed');
const StateJobCompleted = require('./states/job-completed');

const REQUIRED_ENVS = [
  'ENV_SOLUTION_ID',
  'ENV_RESOURCE_PREFIX',
  'ENV_SOLUTION_UUID',
  'ENV_PROXY_BUCKET',
];

exports.handler = async (event, context) => {
  console.log(JSON.stringify(event, null, 2));
  console.log(JSON.stringify(context, null, 2));

  try {
    const missing = REQUIRED_ENVS
      .filter((x) =>
        process.env[x] === undefined);

    if (missing.length) {
      throw new M2CException(`missing enviroment variables, ${missing.join(', ')}`);
    }

    // routing
    let instance;

    if (StateMergeScenesAudioSegments.opSupported(event.operation)) {
      instance = new StateMergeScenesAudioSegments(event, context);
    } else if (StateCreateSequenceImages.opSupported(event.operation)) {
      instance = new StateCreateSequenceImages(event, context);
    } else if (StateUpdateSceneShotResults.opSupported(event.operation)) {
      instance = new StateUpdateSceneShotResults(event, context);
    } else if (StateScenesToChapters.opSupported(event.operation)) {
      instance = new StateScenesToChapters(event, context);
    } else if (StateCreateChapterSequences.opSupported(event.operation)) {
      instance = new StateCreateChapterSequences(event, context);
    } else if (StateMapIterationCompleted.opSupported(event.operation)) {
      instance = new StateMapIterationCompleted(event, context);
    } else if (StateSceneSegmentType.opSupported(event.operation)) {
      instance = new StateSceneSegmentType(event, context);
    } else if (StateCreateSegmentEvents.opSupported(event.operation)) {
      instance = new StateCreateSegmentEvents(event, context);
    } else if (StateGenerateAdBreaks.opSupported(event.operation)) {
      instance = new StateGenerateAdBreaks(event, context);
    } else if (StateJobCompleted.opSupported(event.operation)) {
      instance = new StateJobCompleted(event, context);
    } else {
      throw new M2CException('invalid state');
    }

    return instance.process();
  } catch (e) {
    console.error(e);
    throw e;
  }
};
