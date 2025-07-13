// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  parse,
  join,
} = require('node:path');
const {
  randomBytes,
} = require('node:crypto');
const {
  Environment: {
    Solution: {
      Metrics: {
        Uuid: SolutionUuid,
      },
    },
    DataAccess: {
      RoleArn,
    },
  },
  StateData: {
    Statuses: {
      Started,
    },
  },
  CommonUtils: {
    toISODateTime,
  },
  ServiceToken: {
    register,
  },
  AnalysisError,
} = require('core-lib');
const {
  BacklogClient: {
    TranscribeBacklogJob,
  },
} = require('service-backlog-lib');
const BaseState = require('../shared/base');

const JOBNAME_MAXLEN = 200;

class StateRunAmazonTranscribe extends BaseState {
  static opSupported(op) {
    return op === 'StateRunAmazonTranscribe';
  }

  async process() {
    const {
      input: {
        aiOptions: {
          asrModel,
        },
      },
      data,
      token,
    } = this.stateData;

    if (asrModel !== 'transcribe') {
      throw new AnalysisError(`Invalid asrModel (${asrModel})`);
    }

    const params = _makeParams(this.stateData);

    const {
      TranscriptionJobName: jobId,
      OutputKey: output,
    } = params;

    const backlog = new TranscribeBacklogJob();
    await backlog.startTranscriptionJob(jobId, params);

    data.transcribe = {
      jobId,
      output,
      startTime: Date.now(),
    };

    this.setStarted();
    await register(jobId, token, asrModel, asrModel, this.stateData);

    return this.stateData;
  }

  setStarted() {
    this.stateData.status = Started;
    this.stateData.progress = 0;
  }
}

function _makeParams(stateData) {
  const {
    input: {
      destination: {
        bucket,
        prefix,
      },
      aiOptions: {
        customLanguageModel,
        customVocabulary,
        languageCode,
        asrModel,
      },
    },
    data: {
      audioExtractions,
    },
  } = stateData;

  const {
    output: audioKey,
  } = audioExtractions[0];

  const id = _makeUniqueJobName(audioKey);
  const outPrefix = _makeOutputPrefix(asrModel, prefix)
  const mediaFileUri = `s3://${join(bucket, audioKey)}`;
  const identifyLanguage = (languageCode === undefined);

  const params = {
    TranscriptionJobName: id,
    Media: {
      MediaFileUri: mediaFileUri,
    },
    JobExecutionSettings: {
      AllowDeferredExecution: true,
      DataAccessRoleArn: RoleArn,
    },
    // MediaFormat: 'mp4',
    OutputBucketName: bucket,
    OutputKey: outPrefix,
    OutputEncryptionKMSKeyId: 'alias/aws/s3',
    IdentifyLanguage: identifyLanguage,
    IdentifyMultipleLanguages: identifyLanguage,
    LanguageCode: languageCode,
    Settings: {
      // WORKAROUND:
      // Enabling Channel Identification or SpeakerLabels causes
      // Amazon Transcribe to create invalid timestamps of vtt output
      ChannelIdentification: false,
      // ShowSpeakerLabels: true,
      // MaxSpeakerLabels: 10,
    },
    Subtitles: {
      Formats: ['vtt'],
    },
  };

  if (customLanguageModel) {
    params.ModelSettings = {
      LanguageModelName: customLanguageModel,
    };
  }

  if (customVocabulary !== undefined) {
    params.Settings.VocabularyName = customVocabulary;
  }

  return params;
}

function _makeUniqueJobName(audioKey) {
  // https://docs.aws.amazon.com/transcribe/latest/APIReference/API_StartTranscriptionJob.html#transcribe-StartTranscriptionJob-request-TranscriptionJobName
  const solutionUuid = SolutionUuid;
  const randomId = randomBytes(4).toString('hex');
  const maxLen = JOBNAME_MAXLEN - solutionUuid.length - randomId.length - 2;

  let name = parse(audioKey).name;
  name = name.replace(/[^0-9a-zA-Z._-]/g, '').slice(0, maxLen);

  return [solutionUuid, name, randomId].join('_');
}

function _makeOutputPrefix(asrModel, prefix, timestamp) {
  const isoDateTime = toISODateTime(timestamp);
  let outPrefix = join(prefix, 'raw', isoDateTime, asrModel, '/');

  if (!(/^[a-zA-Z0-9_.!*'()/-]{1,1024}$/.test(outPrefix))) {
    outPrefix = outPrefix.replace(/[^a-zA-Z0-9_.!*'()/-]/g, '_');
  }

  return outPrefix;
}

module.exports = StateRunAmazonTranscribe;
