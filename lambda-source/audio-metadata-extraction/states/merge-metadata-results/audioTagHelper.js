// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
} = require('node:path');
const {
  CommonUtils: {
    download,
    uploadFile,
    toHHMMSS,
  },
} = require('core-lib');

const JSON_AUDIOTAGS = 'audio_tags.json';
const AUDIOTAG_MODEL = 'panns';

async function _merge(outBucket, outPrefix, iterators, totalDuration) {
  totalDuration;

  if (iterators.length === 0) {
    return {};
  }

  let promises = [];

  let startTime = Number.MAX_SAFE_INTEGER;
  let endTime = Number.MIN_SAFE_INTEGER;

  for (const iterator of iterators) {
    const {
      tsta,
      tend,
      segmentAudio: {
        itemId,
        durationInOut,
        startTime: ssta,
        endTime: send,
      },
    } = iterator;

    startTime = Math.min(startTime, tsta, ssta);
    endTime = Math.max(endTime, tend, send);

    promises.push(_downloadIterator(iterator)
      .then((res) => ({
        itemId,
        durationInOut,
        audioTags: res,
      })));
  }

  promises = await Promise.all(promises);

  promises.sort((a, b) =>
    a.itemId - b.itemId);

  const audioTags = _mergeOverlapped(promises);

  const outputs = [
    [JSON_AUDIOTAGS, audioTags],
  ];

  for (const [name, data] of outputs) {
    promises.push(uploadFile(outBucket, outPrefix, name, data));
  }

  await Promise.all(promises);

  return {
    audiotagging: {
      model: AUDIOTAG_MODEL,
      prefix: outPrefix,
      output: JSON_AUDIOTAGS,
      startTime,
      endTime,
    },
  };
}

async function _downloadIterator(iterator) {
  const {
    bucket,
    prefix,
    audioTags: audioTagsJson,
    segmentAudio: { durationInOut },
  } = iterator;

  const audioTags = await download(bucket, join(prefix, audioTagsJson))
    .then((res) =>
      JSON.parse(res))
    .catch(() => undefined);

  if (audioTags === undefined || audioTags.length === 0) {
    return [];
  }

  const parsed = [];
  const fields = ['label', 'start', 'end', 'max_score', 'mean_score'];
  const offset = durationInOut[0];
  for (const segment of audioTags) {
    let dropSegment = false;
    for (const field of fields) {
      if (segment[field] === undefined) {
        dropSegment = true;
        break;
      }
    }
    if (dropSegment) {
      continue;
    }

    const { label, start, end, max_score, mean_score } = segment;
    parsed.push({
      label,
      start: Math.round((Number(start) * 1000) + offset),
      end: Math.round((Number(end) * 1000) + offset),
      maxScore: max_score,
      meanScore: mean_score,
    });
  }

  return parsed;
}

function _mergeOverlapped(iteratorResults) {
  const mappings = {};
  for (const { audioTags } of iteratorResults) {
    for (const segment of audioTags) {
      const { label } = segment;
      if (mappings[label] === undefined) {
        mappings[label] = [];
      }
      mappings[label].push(segment);
    }
  }

  let allSegments = [];
  for (const [, items] of Object.entries(mappings)) {
    const labelSegments = _mergeLabelSegments(items);
    allSegments = allSegments.concat(labelSegments);
  }

  allSegments = _sortByStartAndDuration(allSegments);
  return allSegments;
}

function _sortByStartAndDuration(items) {
  // sort by start time and then by duration
  items.sort((a, b) => {
    if (a.start < b.start) {
      return -1;
    }
    if (a.start > b.start) {
      return 1;
    }
    return ((b.end - b.start) > (a.end - a.start));
  });
  return items;
}

function _mergeLabelSegments(items = []) {
  const sorted = _sortByStartAndDuration(items);
  if (sorted.length < 2) {
    return sorted;
  }

  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const pre = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.start <= pre.end) {
      const start = Math.min(pre.start, cur.start);
      const end = Math.max(pre.end, cur.end);
      console.log(`=== MERGING ${pre.label}: [${toHHMMSS(pre.start, true)}/${toHHMMSS(pre.end, true)}][${toHHMMSS(cur.start, true)}/${toHHMMSS(cur.end, true)}] --> [${toHHMMSS(start, true)}/${toHHMMSS(end, true)}]`);
      pre.start = start;
      pre.end = end;
      pre.maxScore = (pre.maxScore + cur.maxScore) / 2;
      pre.meanScore = (pre.meanScore + cur.meanScore) / 2;
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

////////////////////////////////////////////////////
// Functions to export
////////////////////////////////////////////////////
async function merge(outBucket, outPrefix, iterators, totalDuration) {
  return _merge(outBucket, outPrefix, iterators, totalDuration);
}

module.exports = {
  merge,
};
