// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  join,
} = require('node:path');
const {
  StateData: {
    Statuses: {
      Completed,
    },
  },
  CommonUtils: {
    download,
    uploadFile,
    toHHMMSS,
  },
  WebVttHelper: {
    compile: toWebVTT,
  },
} = require('core-lib');

const JSON_TRANSCRIPT_WHISPERX = 'transcript_whisperx.json';
const JSON_TRANSCRIPT_TRANSCRIBE = 'transcript_transcribe.json';
const VTT_TRANSCRIPT = 'transcript.vtt';
const WHISPERX_MODEL = 'whisperx';

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
        transcripts: res,
      })));
  }

  promises = await Promise.all(promises);

  promises.sort((a, b) =>
    a.itemId - b.itemId);

  const whisperxOutput = _mergeOverlapped(promises);
  const vtt = _makeWebVtt(whisperxOutput);

  // convert to Amazon Transcribe format
  let id = iterators[0].prefix.split('/').shift();
  id = `${id}_audio`;
  const amazonTranscribeOutput = _toAmazonTranscribeOutput(whisperxOutput, id);

  const outputs = [
    [JSON_TRANSCRIPT_WHISPERX, whisperxOutput],
    [JSON_TRANSCRIPT_TRANSCRIBE, amazonTranscribeOutput],
    [VTT_TRANSCRIPT, vtt]
  ];

  for (const [name, data] of outputs) {
    promises.push(uploadFile(outBucket, outPrefix, name, data));
  }

  await Promise.all(promises);

  const languageCode = whisperxOutput.languageCodes[0] || '';

  return {
    transcribe: {
      model: WHISPERX_MODEL,
      prefix: outPrefix,
      output: JSON_TRANSCRIPT_TRANSCRIBE,
      vtt: VTT_TRANSCRIPT,
      transcript: JSON_TRANSCRIPT_WHISPERX,
      startTime,
      endTime,
      jobId: id,
      languageCode,
    },
  };
}

async function _downloadIterator(iterator) {
  const {
    bucket,
    prefix,
    transcript: transcriptJson,
    segmentAudio: {
      // itemId,
      durationInOut,
    },
  } = iterator;

  let transcripts = { segments: [] };

  const response = await download(bucket, join(prefix, transcriptJson))
    .then((res) =>
      JSON.parse(res))
    .catch(() => undefined);

  if (response === undefined || response.segments === undefined) {
    return transcripts;
  }

  if (response.language_code) {
    transcripts.language_code = response.language_code;
  }

  const offset = durationInOut[0];
  for (const segment of response.segments) {
    if (segment.start === undefined || segment.end === undefined) {
      throw new Error(`Segment missing timestamps. (${segment.text})`);
    }

    const words = [];
    for (const word of segment.words) {
      const item = {
        word: word.word.trim(),
      };

      if (word.start !== undefined) {
        item.start = Math.round((word.start * 1000) + offset);
      }

      if (word.end !== undefined) {
        item.end = Math.round((word.end * 1000) + offset);
      }

      if (word.score !== undefined) {
        item.score = word.score;
      }

      words.push(item);
    }

    transcripts.segments.push({
      start: Math.round((segment.start * 1000) + offset),
      end: Math.round((segment.end * 1000) + offset),
      text: segment.text.trim(),
      words,
    });
  }

  return transcripts;
}

function _mergeOverlapped(iteratorResults) {
  // check for overlap timestamps and merge
  let segments = [];
  let languageCodes = [];

  const durationInOut = [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];

  for (let i = 0; i < iteratorResults.length; i += 1) {
    const {
      durationInOut: durationInOutIter,
      transcripts: {
        language_code,
        segments: _curSegments,
      },
    } = iteratorResults[i];

    const overlapEnd = durationInOutIter[1];

    durationInOut[0] = Math.min(durationInOutIter[0], durationInOut[0]);
    durationInOut[1] = Math.max(durationInOutIter[1], durationInOut[1]);

    // drop invalid segment timestamp
    const curSegments = [];
    for (const segment of _curSegments) {
      if (segment.start > segment.end) {
        console.log(`DROPPING: Invalid segment timestamp: ${toHHMMSS(segment.start, true)} -> ${toHHMMSS(segment.end, true)}: "${segment.text}"`);
        continue;
      }
      curSegments.push(segment);
    }

    if (language_code !== undefined) {
      languageCodes.push(language_code);
    }

    // nothing to check
    if (iteratorResults[i + 1] === undefined) {
      segments = segments.concat(curSegments);
      continue;
    }

    const {
      durationInOut: [overlapStart,],
      transcripts: {
        segments: nexSegments,
      },
    } = iteratorResults[i + 1];

    // no overlapping
    if ((overlapStart - overlapEnd) === 0) {
      segments = segments.concat(curSegments);
      continue;
    }

    // find overlap chunks
    const overlapChunks = [];
    for (const transcript of curSegments) {
      const { start, end } = transcript;
      if (start > overlapStart) {
        break;
      }

      if (end < overlapStart) {
        segments.push(transcript);
        continue;
      }
      overlapChunks.push(transcript);
    }

    // no overlap chunk? all good!
    if (overlapChunks.length === 0) {
      continue;
    }

    // Has potential overlap chunks
    console.log('OVERLAPPING SEGMENTS');

    let timestamps = [];
    for (const chunk of overlapChunks) {
      timestamps = timestamps.concat([chunk.start, chunk.end]);
      console.log(`${toHHMMSS(chunk.start, true)} -> ${toHHMMSS(chunk.end, true)}`);
    }
    timestamps = [Math.min(...timestamps), Math.max(...timestamps)];

    // find the merge candidates in the next diarisations
    const mergedCandidates = [];

    console.log('----------');
    console.log('NEXT ITERATION SEGMENTS');
    for (const chunk of nexSegments) {
      if (chunk.start > timestamps[1]) {
        break;
      }

      console.log(`${toHHMMSS(chunk.start, true)} -> ${toHHMMSS(chunk.end, true)}`);

      // make sure the start time is at the top of the hour 
      if ((chunk.start - overlapStart) < 1000) {
        mergedCandidates.push(chunk);
      }
    }

    // no candidate found, push the overlapped chunks
    if (mergedCandidates.length === 0) {
      for (const chunk of overlapChunks) {
        segments.push(chunk);
      }
      continue;
    }

    // has candidate, merge the longest segment timestamps
    overlapChunks.sort((a, b) =>
      (b.end - b.start) - (a.end - a.start));
    mergedCandidates.sort((a, b) =>
      (b.end - b.start) - (a.end - a.start));

    const newSegment = _mergeSegment(overlapChunks[0], mergedCandidates[0]);
    if (newSegment) {
      console.log(`MERGING: ${toHHMMSS(overlapChunks[0].start, true)}/${toHHMMSS(overlapChunks[0].end, true)} -> ${toHHMMSS(mergedCandidates[0].start, true)}/${toHHMMSS(mergedCandidates[0].end, true)}`);
      console.log(`A: ${overlapChunks[0].text}`);
      console.log(`B: ${mergedCandidates[0].text}`);
      console.log(`COMBINED: ${newSegment.text}`);

      segments.push(newSegment);
      nexSegments.shift();
    }
  }

  languageCodes = [...new Set(languageCodes)];

  segments.sort((a, b) =>
    a.start - b.start);

  let duration = durationInOut[1] - durationInOut[0];
  if (segments.length > 0) {
    duration = segments[segments.length - 1].end - segments[0].start;
  }

  return {
    model: WHISPERX_MODEL,
    duration,
    segments,
    languageCodes,
  };
}

function _santizeWord(str) {
  return str.toLowerCase()
    .replace(/\p{Punctuation}/gv, '')
    .replace(/\s+/g, ' ');
}

//
// IMPORTANT NOTE: only works for latin languages
//
function _mergeSegment(segmentA, segmentB) {
  // scan words to see where two segments overlapped
  const bowA = segmentA.words.map((x) =>
    _santizeWord(x.word));

  const bowB = segmentB.words.map((x) =>
    _santizeWord(x.word));

  const start = segmentA.start;
  const end = segmentB.end;

  let indices = [];
  while (bowA.length) {
    indices = [];
    for (const word of bowB) {
      const idx = bowA.lastIndexOf(word);
      if (idx < 0) {
        break;
      }

      if (indices.length > 0 && idx < indices[indices.length - 1]) {
        // indice out of order. Reset the array.
        indices = [];
      }
      indices.push(idx);
    }

    if (indices.length > 1) {
      break;
    }

    bowA.pop();
  }

  if (indices.length > 1) {
    // Bingo! Now, find the match index
    let anchor = bowA[indices[0]];
    anchor = bowB.indexOf(anchor);

    if (anchor >= 0) {
      let words = segmentA.words.slice(0, indices[0]);
      words = words.concat(segmentB.words.slice(anchor));

      const text = words.map((x) => x.word).join(' ').trim();
      return { start, end, text, words };
    }
  }

  // use timestamp to concatenate
  let words = [];
  for (const word of segmentA.words) {
    if (word.start !== undefined && word.start > segmentB.start) {
      break;
    }
    words.push(word);
  }

  let text;
  if (words.length === 0) {
    words = words.concat(segmentB.words);
    text = segmentB.text;
  } else if (segmentB.words.length === 0) {
    words = words.concat(segmentA.words);
    text = segmentA.text;
  } else {
    // remove the duplicated border word
    const borderA = _santizeWord(words[words.length - 1].word);
    const borderB = _santizeWord(segmentB.words[0].word);
    if (borderA === borderB) {
      words.pop();
    }

    words = words.concat(segmentB.words);
    text = words.map((x) => x.word).join(' ').trim();
  }

  return { start, end, text, words };
}

function _makeWebVtt(transcripts) {
  const { segments } = transcripts;

  const cues = [];

  for (let i = 0; i < segments.length; i += 1) {
    const { start, end, text } = segments[i];
    cues.push({
      identifier: String(i + 1),
      start: start / 1000,
      end: end / 1000,
      text,
      styles: '',
    });
  }

  const webvtt = toWebVTT({
    valid: true,
    cues,
  });

  return webvtt;
}

function _toAmazonTranscribeOutput(transcripts, id) {
  const transcript = [];
  const audioSegments = [];

  const { segments, languageCodes } = transcripts;

  for (const segment of segments) {
    const { start, end, text } = segment;

    const audioSegment = {
      id: audioSegments.length,
      transcript: text,
      start_time: (start / 1000).toFixed(3),
      end_time: (end / 1000).toFixed(3),
    };

    if (languageCodes[0] !== undefined) {
      audioSegment.language_code = languageCodes[0];
    }

    audioSegments.push(audioSegment);

    transcript.push(text);
  }

  const amazonTranscribeFormat = {
    model: WHISPERX_MODEL,
    jobName: id,
    accountId: '',
    status: Completed,
    results: {
      transcripts: [{
        transcript: transcript.join(' '),
      }]
    },
    items: [],
    audio_segments: audioSegments,
  };

  if (languageCodes[0]) {
    let duration = 0;
    if (segments.length > 0) {
      duration = (segments[segments.length - 1].end - segments[0].start) / 1000;
    }
    amazonTranscribeFormat.language_codes = [{
      language_code: languageCodes[0],
      duration_in_seconds: duration,
    }];
  }

  return amazonTranscribeFormat;
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
