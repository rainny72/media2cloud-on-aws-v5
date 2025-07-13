// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const {
  xraysdkHelper,
  retryStrategyHelper,
  M2CException,
} = require('core-lib');
const ZIP = require('adm-zip');
const {
  getType,
} = require('mime');
let https = require('node:https');
const mxBaseResponse = require('../shared/mxBaseResponse');

/* wrapper https in xray sdk */
if (process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined) {
  try {
    const {
      captureHTTPs,
    } = require('aws-xray-sdk-core');
    https = captureHTTPs(require('node:https'));
  } catch (e) {
    e;
    console.log('aws-xray-sdk-core not loaded');
  }
}

const CUSTOM_USER_AGENT = process.env.ENV_CUSTOM_USER_AGENT;
const EXPECTED_BUCKET_OWNER = process.env.ENV_EXPECTED_BUCKET_OWNER;

class WebContent extends mxBaseResponse(class { }) {
  constructor(event, context) {
    super(event, context);
    /* sanity check */
    const data = event.ResourceProperties.Data;
    this.sanityCheck(data);
    this.$data = data;
    this.$data.packageUrl = new URL(`https://${data.Source.Bucket}.s3.amazonaws.com/${data.Source.Key}`);
  }

  sanityCheck(data) {
    /* solution id, source, and destination must exist */
    let missing = [
      'SolutionId',
      'Source',
      'Destination',
    ].filter((x) =>
      data[x] === undefined);

    if (missing.length) {
      throw new M2CException(`missing ${missing.join(', ')}`);
    }

    /* source bucket & key must exist */
    missing = [
      'Bucket',
      'Key',
    ].filter((x) =>
      data.Source[x] === undefined);

    if (missing.length) {
      throw new M2CException(`missing Source.${missing.join(', ')}`);
    }

    /* destination bucket must exist */
    missing = [
      'Bucket',
    ].filter((x) =>
      data.Destination[x] === undefined);

    if (missing.length) {
      throw new M2CException(`missing Destination.${missing.join(', ')}`);
    }
  }

  get data() {
    return this.$data;
  }

  get solutionId() {
    return this.data.SolutionId;
  }

  get source() {
    return this.data.Source;
  }

  get packageUrl() {
    return this.data.packageUrl;
  }

  get destination() {
    return this.data.Destination;
  }

  async downloadHTTP() {
    try {
      console.log(`downloadHTTP: ${this.packageUrl}`);

      let promise = new Promise((resolve, reject) => {
        const buffers = [];

        const request = https.get(this.packageUrl, (response) => {
          response.on('data', (chunk) => {
            buffers.push(chunk);
          });

          response.on('end', () => {
            if (response.statusCode >= 400) {
              reject(new M2CException(`${response.statusCode} ${response.statusMessage} ${this.packageUrl.toString()}`));
              return;
            }
            resolve(Buffer.concat(buffers));
          });
        });

        request.on('error', (e) => {
          reject(e);
        });

        request.end();
      });

      promise = await promise;

      return promise;
    } catch (e) {
      console.log(`downloadHTTP failed. ${e.message}`);
      throw e;
    }
  }

  async downloadS3() {
    try {
      console.log(`downloadS3: ${this.source.Bucket}/${this.source.Key}`);

      const s3Client = xraysdkHelper(new S3Client({
        customUserAgent: CUSTOM_USER_AGENT,
        retryStrategy: retryStrategyHelper(),
      }));

      const command = new GetObjectCommand({
        Bucket: this.source.Bucket,
        Key: this.source.Key,
      });

      let response = await s3Client.send(command);
      response = await response.Body.transformToByteArray();
      response = Buffer.from(response);

      return response;
    } catch (e) {
      console.log(`downloadS3 failed. ${e.message}`);
      throw e;
    }
  }

  async downloadPackage() {
    return this.downloadS3()
      .catch(() =>
        this.downloadHTTP());
  }

  async copyFiles(buffer) {
    const files = [];

    const bucket = this.destination.Bucket;
    const unzip = new ZIP(buffer);

    const s3Client = xraysdkHelper(new S3Client({
      customUserAgent: CUSTOM_USER_AGENT,
      retryStrategy: retryStrategyHelper(),
    }));

    for (const entry of unzip.getEntries()) {
      const { isDirectory, entryName } = entry;

      if (isDirectory) {
        continue;
      }

      const contentType = getType(entryName);
      const body = unzip.readFile(entryName);

      console.log(`copyFiles: ${entryName} (${contentType})`);

      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: entryName,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
        ExpectedBucketOwner: EXPECTED_BUCKET_OWNER,
      });

      await s3Client.send(command);

      files.push(entryName);
    }

    console.log(`copyFiles: total ${files.length} files copied`);

    return files;
  }

  /**
   * @function create
   * @description subscribe a list of emails to SNS topic
   */
  async create() {
    const buffer = await this.downloadPackage();
    const files = await this.copyFiles(buffer);

    this.storeResponseData('Uploaded', files.length);
    this.storeResponseData('LastUpdated', new Date().toISOString());
    this.storeResponseData('Status', 'SUCCESS');

    return this.responseData;
  }

  /**
   * @function purge
   * @description not implememted (not needed)
   */
  async purge() {
    this.storeResponseData('Status', 'SKIPPED');
    return this.responseData;
  }
}

module.exports = WebContent;
