// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const FS = require('fs');
const PATH = require('path');
const {
  CommonUtils: {
    download,
    uuid4,
    parseS3Uri,
  },
  Environment: {
    DataAccess: {
      RoleArn: DataAccessRoleArn,
    },
    Solution: {
      Metrics: {
        Uuid: SolutionUuid,
      },
    },
  },
  StateData,
  ServiceToken,
  FrameCaptureModeHelper: {
    suggestFrameCaptureRate,
  },
  FrameCaptureMode: {
    MODE_ALL: EveryFrameMode,
  },
  TranscodeError,
} = require('core-lib');
const {
  BacklogClient: {
    MediaConvertBacklogJob,
  },
} = require('service-backlog-lib');

const CATEGORY = 'transcode';
const API_NAME = 'video';
const CUSTOM_TEMPLATE_S3_PREFIX = 'media2cloud/transcode/template';
const OUTPUT_TYPE_AIML = 'aiml';
// const OUTPUT_TYPE_PROXY = 'proxy';
const OUTPUT_TYPE_FRAMECAPTURE = 'frameCapture';
const OUTPUT_TYPE_EVERYFRAME = 'everyFrame';
const DEFAULT_WXH = [960, 540];
const EVERYFRAME_WXH = [320, 180];
const FORMAT_MPEGTS = 'MPEG-TS';
const FRAMECAPTURE_PREFIX = 'frame';

class StateStartTranscode {
  constructor(stateData) {
    if (!(stateData instanceof StateData)) {
      throw new TranscodeError('stateData not StateData object');
    }
    this.$stateData = stateData;
    this.$outputTypes = [
      OUTPUT_TYPE_AIML,
      // OUTPUT_TYPE_PROXY,
    ];
  }

  get [Symbol.toStringTag]() {
    return 'StateStartTranscode';
  }

  static opSupported(op) {
    return op === 'StateStartTranscode';
  }

  get stateData() {
    return this.$stateData;
  }

  get outputTypes() {
    return this.$outputTypes;
  }

  get uuid() {
    return this.stateData.uuid;
  }

  get input() {
    return this.stateData.input;
  }

  get remixChannels() {
    return this.input.remixChannels || true;
  }

  async process() {
    const src = this.stateData.input || {};
    let missing = [
      'bucket',
      'key',
    ].filter(x => src[x] === undefined);
    if (missing.length) {
      throw new TranscodeError(`missing inputs, ${missing.join(', ')}`);
    }
    const dest = src.destination || {};
    missing = [
      'bucket',
      'prefix',
    ].filter(x => dest[x] === undefined);
    if (missing.length) {
      throw new TranscodeError(`missing destination, ${missing.join(', ')}`);
    }
    const data = this.stateData.data || {};
    if (!data.mediainfo) {
      throw new TranscodeError('missing mediainfo');
    }

    const params = await this.createJobTemplate();

    const stateOutput = await this.createJob(params);

    const output = this.makeOutputPrefix(dest.prefix);
    this.stateData.setStarted();
    this.stateData.setData(CATEGORY, {
      ...stateOutput,
      output,
    });

    const id = stateOutput.backlogId;
    const responseData = this.stateData.toJSON();
    await ServiceToken.register(
      id,
      this.stateData.event.token,
      CATEGORY,
      API_NAME,
      responseData
    );

    return responseData;
  }

  async createJob(params) {
    /* use backlog system */
    const uniqueId = uuid4();

    const backlog = new MediaConvertBacklogJob();
    return backlog.createJob(uniqueId, params)
      .then(() => ({
        startTime: new Date().getTime(),
        backlogId: uniqueId,
      }));
  }

  async createJobTemplate() {
    const src = this.stateData.input;
    const {
      AudioSourceName,
      AudioSelectors,
    } = this.createChannelMappings() || {};

    let ogs = await Promise.all(this.outputTypes.map(outputType =>
      this.makeOutputGroup(outputType, AudioSourceName)));

    // const frameCaptureGroups = await this.useFrameCapture();
    // ogs = ogs.concat(frameCaptureGroups);

    // apply input cropping filter if present
    const inputCrop = _useInputCropFilter();

    const template = {
      Role: DataAccessRoleArn,
      Settings: {
        OutputGroups: ogs.filter(x => x),
        AdAvailOffset: 0,
        Inputs: [
          {
            AudioSelectors,
            VideoSelector: {
              ColorSpace: 'FOLLOW',
              Rotate: 'AUTO',
            },
            FilterEnable: 'AUTO',
            PsiControl: 'USE_PSI',
            FilterStrength: 0,
            DeblockFilter: 'DISABLED',
            DenoiseFilter: 'DISABLED',
            TimecodeSource: 'ZEROBASED',
            FileInput: `s3://${src.bucket}/${src.key}`,
            ...inputCrop,
          },
        ],
      },
      StatusUpdateInterval: 'SECONDS_12',
      AccelerationSettings: {
        Mode: this.useAcceleration() ? 'PREFERRED' : 'DISABLED',
      },
      UserMetadata: this.makeUserMetadata(),
      Queue: await this.useQueue(),
      BillingTagsSource: 'JOB',
    };

    /* sanitize JSON data */
    return JSON.parse(JSON.stringify(template));
  }

  createChannelMappings() {
    return (((this.stateData.data.mediainfo.container || [])[0] || {}).format === FORMAT_MPEGTS)
      ? this.createChannelMappingsMpegTs()
      : this.createChannelMappingsGeneric();
  }

  createChannelMappingsMpegTs() {
    const audio = this.stateData.data.mediainfo.audio || [];
    const name = 'Audio Selector 1';
    const pids = this.parsePIDs(audio);
    return (!pids.length)
      ? undefined
      : {
        AudioSourceName: name,
        AudioSelectors: {
          [name]: {
            Offset: 0,
            DefaultSelection: 'DEFAULT',
            SelectorType: 'PID',
            Pids: pids,
          },
        },
      };
  }

  parsePIDs(audio) {
    /* #1: input has no audio */
    if (!audio.length) {
      return [];
    }
    /* #2: input has one audio track */
    if (audio.length === 1) {
      return [audio[0].iD];
    }
    /* #3: multiple audio tracks and contain stereo track */
    for (let i = 0; i < audio.length; i++) {
      if (this.getChannels(audio[i]) >= 2) {
        return [audio[i].iD];
      }
    }
    /* #4: multiple audio tracks and contain Dolby E track */
    for (let i = 0; i < audio.length; i++) {
      if (audio[i].format === 'Dolby E') {
        return [audio[i].iD];
      }
    }
    /* #5: multiple PCM mono audio tracks, take the first 2 mono tracks */
    let pcms = audio.filter(x => this.getChannels(x) === 1);
    pcms = pcms.sort((a, b) => a.iD - b.iD)
      .map(x => x.iD)
      .slice(0, 2);
    return pcms;
  }

  createChannelMappingsGeneric() {
    const audio = this.stateData.data.mediainfo.audio || [];
    const name = 'Audio Selector 1';
    const tracks = this.parseTracks(audio);

    const remixSettings = this.makeRemixSettings(tracks);

    return (!tracks.length)
      ? undefined
      : {
        AudioSourceName: name,
        AudioSelectors: {
          [name]: {
            Offset: 0,
            DefaultSelection: 'DEFAULT',
            SelectorType: 'TRACK',
            Tracks: tracks,
            ...remixSettings,
          },
        },
      };
  }

  parseTracks(audio) {
    /* #0: reorder audio tracks */
    const reordered = audio.sort((a, b) => {
      const a0 = (a.streamIdentifier !== undefined) ? a.streamIdentifier : a.streamOrder;
      const b0 = (b.streamIdentifier !== undefined) ? b.streamIdentifier : b.streamOrder;
      return a0 - b0;
    }).map((x, idx) => ({
      ...x,
      trackIdx: idx + 1,
    }));
    /* #1: input has no audio */
    if (!reordered.length) {
      return [];
    }
    /* #2: input has one audio track */
    if (reordered.length === 1) {
      return [reordered[0].trackIdx];
    }
    /* #3: multiple audio tracks and contain stereo track */
    for (let i = 0; i < reordered.length; i++) {
      if (this.getChannels(reordered[i]) >= 2) {
        return [reordered[i].trackIdx];
      }
    }
    /* #4: multiple audio tracks and contain Dolby E track */
    for (let i = 0; i < reordered.length; i++) {
      if (reordered[i].format === 'Dolby E') {
        return [reordered[i].trackIdx];
      }
    }

    const pcms = reordered.filter((x) =>
      this.getChannels(x) === 1);

    /* #5: remix all PCM mono audio tracks */
    if (this.remixChannels) {
      return pcms.map((x) =>
        x.trackIdx);
    }

    /* #6: multiple PCM mono audio tracks, take the first 2 mono tracks */
    return pcms.slice(0, 2).map(x => x.trackIdx);
  }

  getChannels(track) {
    return (track.channelS !== undefined)
      ? track.channelS
      : track.channels;
  }

  async makeOutputGroup(ogName, aName) {
    const dest = this.stateData.input.destination;
    const bucket = dest.bucket;
    const prefix = this.makeOutputPrefix(dest.prefix, ogName);
    const og = await this.getJobTemplate(ogName);
    og.CustomName = ogName;
    og.OutputGroupSettings.FileGroupSettings.Destination = `s3://${bucket}/${prefix}`;
    og.Outputs.forEach((o) => {
      if (!aName) {
        delete o.AudioDescriptions;
      } else if (o.AudioDescriptions) {
        o.AudioDescriptions.forEach(a => {
          a.AudioSourceName = aName;
        });
      }
    });
    /* compute output WxH */
    const outputs = og.Outputs.filter(o =>
      o.VideoDescription !== undefined
      && (o.VideoDescription.Width === 0 || o.VideoDescription.Height === 0));
    if (outputs.length > 0) {
      const [
        width,
        height,
      ] = this.downscaleOutput();
      for (let i = 0; i < outputs.length; i++) {
        outputs[i].VideoDescription.Width = width;
        outputs[i].VideoDescription.Height = height;
      }
    }
    /* make sure each output has at least one output stream */
    og.Outputs = og.Outputs.filter(x =>
      x.CaptionDescriptions || x.AudioDescriptions || x.VideoDescription);
    return og;
  }

  makeOutputPrefix(prefix, keyword = '') {
    // eslint-disable-next-line
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    return PATH.join(prefix, CATEGORY, keyword, '/');
  }

  async getJobTemplate(ogName) {
    const dest = this.stateData.input.destination;
    const bucket = dest.bucket;
    const json = `${ogName}.json`;
    // eslint-disable-next-line
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const key = PATH.join(CUSTOM_TEMPLATE_S3_PREFIX, json);
    const tmpl = await download(bucket, key)
      .catch(() => {
        // eslint-disable-next-line
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        const file = PATH.join(__dirname, 'tmpl', json);
        return FS.readFileSync(file);
      });
    return JSON.parse(tmpl);
  }

  useAcceleration() {
    const {
      data: {
        mediainfo = {},
      },
      input: {
        options = {},
      },
    } = this.stateData;
    const disabled = options.useAcceleration === false;
    const useQueue = options.jobQueue;
    const video = (mediainfo.video || [])[0];
    let duration = this.stateData.input.duration || 0;
    duration = Math.floor(duration);
    return (!disabled && !useQueue && video && duration > 5 * 60 * 1000);
  }

  makeUserMetadata() {
    return {
      solutionUuid: SolutionUuid,
    };
  }

  async useQueue() {
    const queue = (this.stateData.input.options || {}).jobQueue;
    if (!queue) {
      return undefined;
    }
    const mediaconvert = (new MediaConvertBacklogJob())
      .getMediaConvertInstance();
    const response = await mediaconvert.getQueue({
      Name: queue,
    }).promise()
      .catch(() =>
        undefined);
    return ((response || {}).Queue || {}).Arn;
  }

  downscaleOutput(defaultWxH = DEFAULT_WXH) {
    let wxh = defaultWxH;

    try {
      const {
        data: {
          mediainfo: {
            video: [
              {
                width,
                height,
              },
            ],
          },
        },
      } = this.stateData;

      if (width <= defaultWxH[0] && height <= defaultWxH[1]) {
        // no need to downscale
        wxh = [width, height];
      } else {
        // check portrait mode
        let factor = defaultWxH[0] / width;
        if (height > width) {
          factor = defaultWxH[0] / height;
        }
        wxh = [(factor * width), (factor * height)];
      }
    } catch (e) {
      console.log(e);
    }

    return [
      Math.round(wxh[0] / 2) * 2,
      Math.round(wxh[1] / 2) * 2,
    ];
  }

  async useFrameCapture() {
    const {
      input: {
        framerate,
        aiOptions,
      },
    } = this.stateData;

    const {
      frameCaptureMode,
      filters,
    } = aiOptions || {};

    const outputGroups = [];

    const fraction = suggestFrameCaptureRate(framerate, frameCaptureMode);
    if (!fraction[0] || !fraction[1]) {
      return outputGroups;
    }

    let outputGroup = await this.makeOutputGroup(OUTPUT_TYPE_FRAMECAPTURE);
    const {
      OutputGroupSettings: {
        FileGroupSettings,
      },
      Outputs: [
        {
          VideoDescription: {
            CodecSettings: {
              FrameCaptureSettings,
            },
          },
        },
      ],
    } = outputGroup;

    FileGroupSettings.Destination += `${FRAMECAPTURE_PREFIX}`;
    FrameCaptureSettings.FramerateNumerator = fraction[0];
    FrameCaptureSettings.FramerateDenominator = fraction[1];
    outputGroups.push(outputGroup);

    // dup the output group to create everyframe
    const {
      everyFrame = false,
    } = (filters || {})[CATEGORY] || {};

    if (everyFrame) {
      outputGroup = this.makeOutputGroupEveryFrame(outputGroup);
      outputGroups.push(outputGroup);
    }

    return outputGroups;
  }

  makeOutputGroupEveryFrame(refGroup) {
    const outputGroup = JSON.parse(JSON.stringify(refGroup));

    const {
      OutputGroupSettings: {
        FileGroupSettings,
      },
      Outputs: [
        {
          VideoDescription,
        },
      ],
    } = outputGroup;

    const {
      CodecSettings: {
        FrameCaptureSettings,
      },
    } = VideoDescription;

    const {
      bucket,
      prefix,
    } = parseS3Uri(FileGroupSettings.Destination);

    const {
      input: {
        framerate,
      },
    } = this.stateData;

    const fraction = suggestFrameCaptureRate(framerate, EveryFrameMode);
    const wxh = this.downscaleOutput(EVERYFRAME_WXH);

    outputGroup.CustomName = OUTPUT_TYPE_EVERYFRAME;
    VideoDescription.Width = wxh[0];
    VideoDescription.Height = wxh[1];
    FrameCaptureSettings.FramerateNumerator = fraction[0];
    FrameCaptureSettings.FramerateDenominator = fraction[1];
    FileGroupSettings.Destination = `s3://${bucket}/${prefix}/${OUTPUT_TYPE_EVERYFRAME}/every`;

    return outputGroup;
  }

  makeRemixSettings(tracks) {
    if (!this.remixChannels || tracks.length < 2) {
      return undefined;
    }

    const inputChannelsL = new Array(tracks.length).fill(-60)
      .map((x, idx) =>
        (0 - (idx % 2) * 60));
    const inputChannelsR = new Array(tracks.length).fill(-60)
      .map((x, idx) =>
        (0 - (1 - (idx % 2)) * 60));

    return {
      RemixSettings: {
        ChannelMapping: {
          OutputChannels: [
            {
              InputChannelsFineTune: inputChannelsL,
            },
            {
              InputChannelsFineTune: inputChannelsR,
            },
          ],
        },
        ChannelsIn: tracks.length,
        ChannelsOut: 2,
      },
    };
  }
}

function _useInputCropFilter() {
  try {
    const {
      input: {
        aiOptions: {
          filters: {
            [CATEGORY]: transcodeSettings,
          },
        },
      },
      data: {
        mediainfo: {
          video: [
            {
              width,
              height,
            },
          ],
        },
      },
    } = this.stateData;

    const srcW = Number(width);
    const srcH = Number(height);

    if (Number.isNaN(srcW) || Number.isNaN(srcH)) {
      throw new Error('invalid srcW or srcH value');
    }

    let {
      cropX = 0,
      cropY = 0,
      keepAR,
    } = transcodeSettings;

    keepAR = (keepAR !== false);

    cropX = Number(cropX);
    cropY = Number(cropY);

    if (
      (Number.isNaN(cropX) || Number.isNaN(cropY)) ||
      ((cropX + cropY) === 0)
    ) {
      throw new Error('invalid cropX or cropY value');
    }

    // rounding to multiplier of 2
    cropX = Math.round(cropX / 2) * 2;
    cropY = Math.round(cropY / 2) * 2;

    let destW = srcW - (cropX * 2);
    let destH = srcH - (cropY * 2);

    if (keepAR) {
      const scale = Math.min((destW / srcW), (destH / srcH));

      destW = Math.round((srcW * scale) / 4) * 4;
      destH = Math.round((srcH * scale) / 4) * 4;
      cropX = Math.round((srcW - destW) / 2);
      cropY = Math.round((srcH - destH) / 2);
    }

    const inputCropping = {
      Crop: {
        X: cropX,
        Y: cropY,
        Width: destW,
        Height: destH,
      },
    };

    return inputCropping;
  } catch (e) {
    console.log(e);
    return undefined;
  }
}

module.exports = StateStartTranscode;
