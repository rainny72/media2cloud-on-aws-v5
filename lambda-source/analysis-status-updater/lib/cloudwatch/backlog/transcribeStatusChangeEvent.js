// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  Environment: {
    StateMachines: {
      AudioExtraction: StateMachineName,
    },
  },
  StateData,
  JobStatusError,
  ServiceToken: {
    getData,
    unregister,
  },
} = require('core-lib');
const BacklogStatusChangeEvent = require('./backlogStatusChangeEvent');

const STATUS_SUCCEEDED = 'COMPLETED';
const STATUS_FAILED = 'FAILED';

const SUPPORTED_STATUSES = [STATUS_SUCCEEDED, STATUS_FAILED];

class TranscribeStatusChangeEvent extends BacklogStatusChangeEvent {
  async process() {
    if (!SUPPORTED_STATUSES.includes(this.status)) {
      console.error(`TranscribeStatusChangeEvent.process: ${this.status} status not handled`);
      return undefined;
    }

    const response = await getData(this.backlogId)
      .catch(() =>
        undefined);

    const {
      data,
      service,
      token,
      api,
    } = response || {};

    if (!service || !token || !api) {
      throw new JobStatusError(`fail to get token, ${this.backlogId}`);
    }

    const category = service;
    response.data.data[category].jobId = this.jobId;
    response.data.data[category].endTime = this.timestamp;

    this.stateData = new StateData(StateMachineName, data, this.context);
    this.token = token;

    // send task result to state machine execution
    if (this.status === STATUS_SUCCEEDED) {
      this.stateData.setCompleted();
      await this.parent.sendTaskSuccess();
    } else if (this.status === STATUS_FAILED) {
      // special handling: if language identification is enabled and fails,
      // it is likely that the file contains no dialogue. Set it as NO_DATA
      const identifyLanguageEnabled = !!(this.detail.serviceParams || {}).IdentifyLanguage;
      if (identifyLanguageEnabled) {
        this.stateData.setNoData();
        await this.parent.sendTaskSuccess();
      } else {
        let error = `${this.jobId} ${this.status}`;
        if (this.errorMessage) {
          error = this.errorMessage;
        }
        error = new JobStatusError(error);
        this.stateData.setFailed(error);
        await this.parent.sendTaskFailure(error);
      }
    }

    // remove record from service token table
    await unregister(this.backlogId)
      .catch(() =>
        undefined);

    return this.stateData.toJSON();
  }
}

module.exports = TranscribeStatusChangeEvent;
