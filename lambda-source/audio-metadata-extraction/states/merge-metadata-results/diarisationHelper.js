// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
} = require('node:path');
const {
  OPTICS,
} = require('core-lib/node_modules/density-clustering');
const {
  CommonUtils: {
    download,
    uploadFile,
    toHHMMSS,
  },
  SimpleGeometry: {
    timeIntersected,
  },
  SimpleMath: {
    cosim,
  },
  SegmentHelper: {
    JSON_DIARISATIONS,
    JSON_SPEAKEREMBEDDINGS,
    JSON_PAUSEINDIALOGUES,
  },
} = require('core-lib');

const PYANNOTE_MODEL = 'pyannote';
const MERGED_TIMESTAMP_THRESHOLD = 800; // set to 0 to disable merging adjacent timestamps on same speaker

async function _merge(outBucket, outPrefix, iterators, totalDuration) {
  if (iterators.length === 0) {
    return {};
  }

  let startTime = Number.MAX_SAFE_INTEGER;
  let endTime = Number.MIN_SAFE_INTEGER;
  let promises = [];
  for (const iterator of iterators) {
    const {
      tsta,
      tend,
      segmentAudio: {
        itemId, durationInOut,
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
        ...res,
      })));
  }
  promises = await Promise.all(promises);

  promises.sort((a, b) => a.itemId - b.itemId);

  const speakerEmbeddings = _mergeSpeakerEmbeddings(promises);

  const diarisations = _mergeDiarisations(speakerEmbeddings);

  const pauseInDialogues = _collectionPausesInDialogues(diarisations, totalDuration);

  const outputs = [
    [JSON_DIARISATIONS, diarisations],
    [JSON_SPEAKEREMBEDDINGS, speakerEmbeddings],
    [JSON_PAUSEINDIALOGUES, pauseInDialogues]
  ];

  promises = [];
  for (const [name, data] of outputs) {
    promises.push(uploadFile(outBucket, outPrefix, name, data));
  }
  await Promise.all(promises);

  return {
    diarisation: {
      model: PYANNOTE_MODEL,
      prefix: outPrefix,
      output: JSON_DIARISATIONS,
      pauseOutput: JSON_PAUSEINDIALOGUES,
      speakerEmbeddings: JSON_SPEAKEREMBEDDINGS,
      startTime,
      endTime,
    },
  };
}

async function _downloadIterator(iterator) {
  const {
    bucket,
    prefix,
    output,
    segmentAudio: { itemId, durationInOut },
  } = iterator;

  const key = join(prefix, output);
  const response = await download(bucket, key)
    .then((res) =>
      JSON.parse(res))
    .catch(() => ({}));

  const {
    speaker_diarisations = [],
    speaker_embeddings = [],
  } = response;

  const offset = durationInOut[0];

  const speakerEmbeddings = [];
  for (const { speaker_id, embedding } of speaker_embeddings) {
    let newId = speaker_id.split('_').pop();
    newId = `SPEAKER_${itemId}_${newId}`;
    speakerEmbeddings.push({
      speaker_id: newId,
      embedding,
    });
  }

  let diarisations = [];
  for (let { start, end, speaker_id } of speaker_diarisations) {
    start = Math.round((start * 1000) + offset);
    end = Math.round((end * 1000) + offset);

    let newId = speaker_id.split('_').pop();
    speaker_id = `SPEAKER_${itemId}_${newId}`;
    diarisations.push({ start, end, speaker_id });
  }

  diarisations.sort((a, b) => {
    if (a.start < b.start) {
      return -1;
    }
    if (a.start > b.start) {
      return 1;
    }
    return b.end - a.end;
  });

  // merge adjacent timestamps on same speaker
  if (MERGED_TIMESTAMP_THRESHOLD > 0 && diarisations.length > 1) {
    const merged = [];
    merged.push(diarisations[0]);

    for (let i = 1; i < diarisations.length; i += 1) {
      const pre = merged[merged.length - 1];
      const cur = diarisations[i];

      if (pre.speaker_id !== cur.speaker_id) {
        merged.push(cur);
        continue;
      }

      if (timeIntersected([pre.start, pre.end], [cur.start, cur.end], true)
        || (cur.start - pre.end) <= MERGED_TIMESTAMP_THRESHOLD) {
        pre.start = Math.min(pre.start, cur.start);
        pre.end = Math.max(pre.end, cur.end);
        continue;
      }

      console.log(`Not merged: ${pre.speaker_id}/${cur.speaker_id}: ${cur.start - pre.end}ms difference`);
      merged.push(cur);
    }

    diarisations = merged;
  }


  return { diarisations, speakerEmbeddings };
}

function _bruteForceClustering(dataset, minClusterSize, initialEpsilon = 0.18, step = 0.01, numRun = 24) {
  // find where the cluster starts to saturate
  const distanceFn = (a, b) => 1 - cosim(a, b);

  let optimalCluster;
  let clusters = {};

  let epsilon = initialEpsilon;
  for (let i = 0; i < numRun; i += 1, epsilon += step) {
    const optics = new OPTICS(dataset, epsilon, 2, distanceFn);
    const cluster = optics.run();

    if (cluster.length < minClusterSize) {
      continue;
    }

    console.log(`epsilon = ${epsilon.toFixed(3)}, cluster = ${cluster.length}`);

    const size = String(cluster.length);
    if (clusters[size] === undefined) {
      clusters[size] = [];
    }
    clusters[size].push([epsilon, cluster]);

    // early stop when the cluster starts to saturate
    // if (clusters[size].length >= 4) {
    //   optimalCluster = clusters[size][clusters[size].length - 1];
    //   break;
    // }
  }

  if (!optimalCluster) {
    clusters = Object.values(clusters);
    clusters.sort((a, b) => {
      if (b.length < a.length) {
        return -1;
      }
      if (b.length > a.length) {
        return 1;
      }
      return b[0][0] - a[0][0];
    });
    optimalCluster = clusters[0][clusters[0].length - 1];
  }

  return optimalCluster;
}

function _mergeSpeakerEmbeddings(iteratorResults) {
  let speakerEmbeddings = [];
  let diarisations = [];

  let minSpeakers = Number.MIN_SAFE_INTEGER;
  for (const iterator of iteratorResults) {
    speakerEmbeddings = speakerEmbeddings.concat(iterator.speakerEmbeddings);
    minSpeakers = Math.max(minSpeakers, iterator.speakerEmbeddings.length);
    diarisations = diarisations.concat(iterator.diarisations);
  }

  const [epsilon, cluster] = _bruteForceClustering(speakerEmbeddings.map((x) => x.embedding), minSpeakers);
  const groups = [];
  for (const ids of cluster) {
    const subGroup = [];
    for (const id of ids) {
      subGroup.push(speakerEmbeddings[id]);
    }
    groups.push(subGroup);
  }
  groups.sort((a, b) => b.length - a.length);

  let speakerMappings = {};
  const speakerGroups = [];
  for (let i = 0; i < groups.length; i += 1) {
    const speakerId = `SPK_${String(i).padStart(3, '0')}`;
    const relatedTo = [];
    const embeddings = [];
    const speaker = {
      epsilon, speakerId, relatedTo, embeddings,
    };

    for (const { speaker_id, embedding } of groups[i]) {
      embeddings.push(embedding);
      relatedTo.push(speaker_id);
      speakerMappings[speaker_id] = speaker;
    }
    speakerGroups.push(speaker);
  }

  // assign new speaker id to diarisations
  // collect speaker segments
  for (const diarisation of diarisations) {
    const { speaker_id } = diarisation;

    const speaker = speakerMappings[speaker_id];
    diarisation.original_id = speaker_id;
    diarisation.speaker_id = speaker.speakerId;

    if (speaker.segments === undefined) {
      speaker.segments = [];
    }
    speaker.segments.push(diarisation);
  }

  for (const speaker of speakerGroups) {
    const { speakerId, segments } = speaker;
    speaker.segments = _mergeTimestamps(speakerId, segments);
  }

  return speakerGroups;
}

function _mergeDiarisations(speakers) {
  let segments = [];
  for (const speaker of speakers) {
    segments = segments.concat(speaker.segments);
  }
  // Deep clone before merging crosstalk
  segments = JSON.parse(JSON.stringify(segments));
  segments = _mergeTimestamps('CROSSTALK', segments);

  return segments;
}

function _mergeTimestamps(speakerId, segments) {
  segments.sort((a, b) => {
    if (a.start < b.start) {
      return -1;
    }
    if (a.start > b.start) {
      return 1;
    }
    return b.end - a.end;
  });

  if (segments.length < 3) {
    return segments;
  }

  console.log(`=== MERGE ${speakerId} Timestamps ===`);
  const merged = [];
  merged.push(segments[0]);
  for (let i = 1; i < segments.length; i += 1) {
    const pre = merged[merged.length - 1];
    const cur = segments[i];
    if (timeIntersected([pre.start, pre.end], [cur.start, cur.end], true)) {
      console.log(`OVERLAPPED: ${toHHMMSS(pre.start, true)}/${toHHMMSS(pre.end, true)} and ${toHHMMSS(cur.start, true)}/${toHHMMSS(cur.end, true)}`);
      pre.start = Math.min(pre.start, cur.start);
      pre.end = Math.max(pre.end, cur.end);
      continue;
    }
    merged.push(cur);
  }

  return merged;
}

function _collectionPausesInDialogues(diarisations, totalDuration) {
  if (diarisations.length === 0) {
    return [];
  }

  const pauseGroups = [];
  const timeRanges = [];

  for (const { start, end } of diarisations) {
    timeRanges.push([start, end]);
  }

  // prepend the initial pause
  if (timeRanges[0][0] > 200) {
    pauseGroups.push([0, timeRanges[0][0] - 100]);
  }

  for (let i = 1; i < timeRanges.length; i += 1) {
    const pre = timeRanges[i - 1];
    const cur = timeRanges[i];

    // if ((cur[0] - pre[1]) >= NORMAL_PAUSE) {
    if ((cur[0] - pre[1]) >= 300) {
      pauseGroups.push([pre[1] + 10, cur[0] - 10]);
    } else {
      console.log(`Ignore short pauses: ${toHHMMSS(pre[1], true)} -> ${toHHMMSS(cur[0], true)} [${cur[0] - pre[1]}ms]`);
    }
  }

  // append the end pause
  if ((totalDuration - timeRanges[timeRanges.length - 1][1]) > 200) {
    pauseGroups.push([timeRanges[timeRanges.length - 1][1] + 100, totalDuration]);
  }

  console.log(`# of pauses in dialogue: ${pauseGroups.length} from ${timeRanges.length} diarisations`);

  return pauseGroups;
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
