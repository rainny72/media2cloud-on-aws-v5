// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  join,
} = require('path');
const {
  TranscribeClient,
  GetTranscriptionJobCommand,
  TranscribeServiceException,
} = require('@aws-sdk/client-transcribe');
const {
  StateData,
  Environment: {
    Solution: {
      Metrics: {
        CustomUserAgent,
      },
    },
  },
  AnalysisTypes: {
    Transcribe,
  },
  xraysdkHelper,
  retryStrategyHelper,
  M2CException,
} = require('core-lib');

const JOB_COMPLETED = 'COMPLETED';

class StateTranscribeResults {
  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new M2CException('stateData not StateData object');
    }
    this.$stateData = stateData;
  }

  get [Symbol.toStringTag]() {
    return 'StateTranscribeResults';
  }

  get stateData() {
    return this.$stateData;
  }

  async process() {
    try {
      const {
        data: {
          [Transcribe]: {
            jobId,
            output: outPrefix,
          },
        },
      } = this.stateData;

      // get job results
      const jobResult = await this.getJob(jobId);
      const {
        TranscriptionJob: {
          TranscriptionJobStatus,
          FailureReason,
          LanguageCodes,
          LanguageCode,
        },
      } = jobResult;

      if (TranscriptionJobStatus !== JOB_COMPLETED) {
        const message = FailureReason || TranscriptionJobStatus;
        throw new TranscribeServiceException(`${jobId}: ${message};`);
      }

      let languageCode = LanguageCode;
      if (Array.isArray(LanguageCodes)) {
        languageCode = LanguageCodes[0].LanguageCode;
      }

      const output = join(outPrefix, `${jobId}.json`);
      const vtt = join(outPrefix, `${jobId}.vtt`);

      return this.setCompleted({
        languageCode,
        output,
        vtt,
      });
    } catch (e) {
      return this.setNoData(e.message);
    }
  }

  async getJob(jobId) {
    const transcribeClient = xraysdkHelper(new TranscribeClient({
      customUserAgent: CustomUserAgent,
      retryStrategy: retryStrategyHelper(),
    }));

    const command = new GetTranscriptionJobCommand({
      TranscriptionJobName: jobId,
    });

    return transcribeClient.send(command)
      .then((res) => ({
        ...res,
        $metadata: undefined,
      }));
  }

  setNoData(message) {
    this.stateData.setData(Transcribe, {
      errorMessage: message,
      endTime: Date.now(),
    });
    this.stateData.setNoData();
    return this.stateData.toJSON();
  }

  setCompleted(data) {
    this.stateData.setData(Transcribe, {
      ...data,
      endTime: Date.now(),
    });
    this.stateData.setCompleted();
    return this.stateData.toJSON();
  }
}

module.exports = StateTranscribeResults;
