// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  CommonUtils: {
    headObject,
    restoreObject,
  },
  StateData,
  RestoreError,
} = require('core-lib');

const KEY_EXPIRY_DATE = 'expiry-date';
const KEY_ONGOING_REQUEST = 'ongoing-request';
const DEFAULT_RESTORE_TIER = 'Bulk';
// const DEFAULT_RESTORE_DAYS = 1;
const RETRIVAL_TIME_BY_CLASS = {
  GLACIER: {
    Expedited: 5 * 60 * 1000,
    Standard: 5 * 3600 * 1000,
    Bulk: 12 * 3600 * 1000,
  },
  DEEP_ARCHIVE: {
    Expedited: 12 * 3600 * 1000, /* not available, set it to 'Standard' */
    Standard: 12 * 3600 * 1000,
    Bulk: 48 * 3600 * 1000,
  },
};

class StateCheckRestoreStatus {
  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new RestoreError('stateData not StateData object');
    }
    this.$stateData = stateData;
  }

  get [Symbol.toStringTag]() {
    return 'StateCheckRestoreStatus';
  }

  static opSupported(op) {
    return op === 'StateCheckRestoreStatus';
  }

  get stateData() {
    return this.$stateData;
  }

  async process() {
    const src = this.stateData.input;
    if (!src.bucket || !src.key) {
      throw new RestoreError('missing input parameters');
    }

    const response = await headObject(src.bucket, src.key);
    const restoreData = StateCheckRestoreStatus.parseKeyValuePair(response.Restore);

    /* "Restore": "ongoing-request=\"true\"" */
    const expiredAt = restoreData[KEY_EXPIRY_DATE]
      ? new Date(restoreData[KEY_EXPIRY_DATE]).getTime()
      : undefined;

    /* INTELLIGENT_TIERING storage class reports the archive access in ArchiveStatus field */
    let storageClass = response.StorageClass;
    if (response.ArchiveStatus === 'DEEP_ARCHIVE_ACCESS') {
      storageClass = 'DEEP_ARCHIVE';
    } else if (response.ArchiveStatus === 'ARCHIVE_ACCESS') {
      storageClass = 'GLACIER';
    }
    const tier = this.findRestoreRequestTier(storageClass);

    const startTime = ((this.stateData.data || {}).restore || {}).startTime || new Date().getTime();

    if (storageClass !== 'GLACIER' && storageClass !== 'DEEP_ARCHIVE') {
      this.stateData.setCompleted();
    } else if (restoreData[KEY_ONGOING_REQUEST] === 'false') {
      this.stateData.setCompleted();
    } else if (!response.Restore) {
      await this.startRestore(storageClass, tier);
      this.stateData.setStarted();
    } else {
      this.stateData.setProgress(this.computeRetrivalProgress(startTime, storageClass, tier));
    }

    const endTime = (this.stateData.status === StateData.Statuses.Completed)
      ? new Date().getTime()
      : undefined;

    let waitInSeconds;
    if (this.status === StateData.Statuses.Completed) {
      waitInSeconds = 0;
    } else if (tier === 'Expedited') {
      waitInSeconds = 4 * 60;
    } else if (tier === 'Bulk' && storageClass === 'DEEP_ARCHIVE') {
      waitInSeconds = 12 * 3600;
    } else {
      waitInSeconds = 4 * 3600;
    }

    this.stateData.setData('restore', {
      tier,
      storageClass,
      expiredAt,
      startTime,
      endTime,
      waitInSeconds,
    });
    return this.stateData.toJSON();
  }

  static parseKeyValuePair(str) {
    const pair = {};
    let current = str;
    while (current) {
      const result = StateCheckRestoreStatus.reverseLookup(current);
      if (result) {
        pair[result.key] = result.value;
        current = result.next;
      } else {
        current = undefined;
      }
    }
    return pair;
  }

  static reverseLookup(s) {
    try {
      const token = s.substr(-1) === ',' ? s.slice(0, -1) : s;
      let idx = token.lastIndexOf('=');
      if (idx < 0) {
        throw new RangeError(`no more '=' token, ${token}`);
      }
      const value = token.substring(idx + 1).replace(/["']/g, '');
      let next = token.substring(0, idx);
      idx = next.lastIndexOf(' ');

      const key = next.substring(idx + 1);
      next = (idx < 0) ? undefined : token.substring(0, idx);
      return {
        key,
        value,
        next,
      };
    } catch (e) {
      e;
      return undefined;
    }
  }

  findRestoreRequestTier(storageClass = 'DEEP_ARCHIVE') {
    let tier = ((this.stateData.data || {}).restore || {}).tier
      || (this.stateData.input.options || {}).restoreTier
      || DEFAULT_RESTORE_TIER;

    switch (tier) {
      case 'Expedited':
        tier = (storageClass === 'DEEP_ARCHIVE') ? 'Standard' : tier;
        break;
      case 'Standard':
      case 'Bulk':
        break;
      default:
        tier = 'Bulk';
        break;
    }
    return tier;
  }

  async startRestore(storageClass, tier) {
    const src = this.stateData.input || {};
    console.log(`start restore process, s3://${src.bucket}/${src.key} (${storageClass})`);

    // const days =
    //   Number.parseInt((src.options || {}).restoreDays || DEFAULT_RESTORE_DAYS, 10);

    await restoreObject(src.bucket, src.key, {
      RestoreRequest: {
        // Days: days, // <- INTELLIGENT_TIERING CANNOT SPECIFY THIS FIELD!!!
        GlacierJobParameters: {
          Tier: tier,
        },
      },
    });
    return tier;
  }

  computeRetrivalProgress(t0, storageClass, tier) {
    const tdiff = new Date().getTime() - t0;
    return (tdiff / (RETRIVAL_TIME_BY_CLASS[storageClass][tier] || 1000)) * 100;
  }
}

module.exports = StateCheckRestoreStatus;
