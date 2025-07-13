// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  TranscribeClient,
  GetTranscriptionJobCommand,
  TranscribeServiceException,
} = require('@aws-sdk/client-transcribe');
const {
  StateData: {
    Statuses: {
      Completed,
      NoData,
    },
  },
  Environment: {
    Solution: {
      Metrics: {
        CustomUserAgent,
      },
    },
  },
  xraysdkHelper,
  retryStrategyHelper,
} = require('core-lib');
const BaseState = require('../shared/base');

const JOB_COMPLETED = 'COMPLETED';

class StateGetTranscribeResults extends BaseState {
  static opSupported(op) {
    return op === 'StateGetTranscribeResults';
  }

  async process() {
    try {
      const {
        data: {
          transcribe: {
            jobId,
            output: outPrefix,
          },
        },
      } = this.stateData;

      const response = await _getTranscriptionJob(jobId);

      const {
        TranscriptionJob: {
          TranscriptionJobStatus,
          FailureReason,
          LanguageCodes,
          LanguageCode,
        },
      } = response;

      if (TranscriptionJobStatus !== JOB_COMPLETED) {
        const message = FailureReason || TranscriptionJobStatus;
        throw new TranscribeServiceException(`${jobId}: ${message};`);
      }

      let languageCode = LanguageCode;
      if (Array.isArray(LanguageCodes)) {
        languageCode = LanguageCodes[0].LanguageCode;
      }

      const output = `${jobId}.json`;
      const vtt = `${jobId}.vtt`;

      return this.setCompleted({
        prefix: outPrefix,
        output,
        vtt,
        languageCode,
      });
    } catch (e) {
      return this.setNoData(e.message);
    }
  }

  setCompleted(params) {
    const { data } = this.stateData;

    const transcribe = {
      ...data.transcribe,
      ...params,
      status: Completed,
      endTime: Date.now(),
    };

    return { transcribe };
  }

  setNoData(message) {
    const { data } = this.stateData;

    const transcribe = {
      ...data.transcribe,
      status: NoData,
      errorMessage: message,
      endTime: Date.now(),
    };

    return { transcribe };
  }
}

async function _getTranscriptionJob(id) {
  const transcribeClient = xraysdkHelper(new TranscribeClient({
    customUserAgent: CustomUserAgent,
    retryStrategy: retryStrategyHelper(),
  }));

  const command = new GetTranscriptionJobCommand({
    TranscriptionJobName: id,
  });

  return transcribeClient.send(command)
    .then((res) => ({
      ...res,
      $metadata: undefined,
    }));
}

module.exports = StateGetTranscribeResults;
