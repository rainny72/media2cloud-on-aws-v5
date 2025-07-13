// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
let https = require('node:https');
const {
  M2CException,
} = require('core-lib');

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

const SUCCESS = 'SUCCESS';
const FAILED = 'FAILED';

/**
 * @class CloudFormationResponse
 */
class CloudFormationResponse {
  constructor(event, context) {
    this.$event = null;
    this.$context = null;
    this.$initError = null;

    this.initialize(event, context);
  }

  initialize(event, context) {
    this.$event = event;
    this.$context = context;

    /* sanity check on the response */
    let missing = [
      'StackId',
      'RequestId',
      'ResponseURL',
      'LogicalResourceId',
    ].filter(x => this.$event[x] === undefined);
    if (missing.length) {
      throw new M2CException(`event missing ${missing.join(', ')}`);
    }

    missing = [
      'logStreamName',
    ].filter(x => this.$context[x] === undefined);
    if (missing.length) {
      throw new M2CException(`context missing ${missing.join(', ')}`);
    }
  }

  get event() {
    return this.$event;
  }

  get context() {
    return this.$context;
  }

  get stackId() {
    return this.event.StackId;
  }

  get requestId() {
    return this.event.RequestId;
  }

  get responseUrl() {
    return this.event.ResponseURL;
  }

  get logicalResourceId() {
    return this.event.LogicalResourceId;
  }

  get physicalResourceId() {
    return this.event.PhysicalResourceId;
  }

  get logStreamName() {
    return this.context.logStreamName;
  }

  isUnitTest() {
    return !!(this.event.ResourceProperties.PS_UNIT_TEST);
  }

  static parseResponseData(data) {
    if (data instanceof Error) {
      return [
        FAILED,
        {
          Error: data.message,
          Stack: data.stack,
          StatusCode: data.StatusCode || 500,
        },
      ];
    }

    return [
      SUCCESS,
      data,
    ];
  }

  /**
   * @static
   * @function pause - execution for specified duration
   * @param {number} duration - in milliseconds
   */
  static async pause(duration = 0) {
    return new Promise((resolve) => {
      setTimeout(() =>
        resolve(), duration);
    });
  }

  /**
   * @function sendRequest
   * @description wrap HTTP request into a function so we could do retry
   * @param {objcet} params
   * @param {object} body
   */
  async sendRequest(params, body) {
    return new Promise((resolve, reject) => {
      let result = '';

      const request = https.request(params, (response) => {
        response.setEncoding('utf8');

        response.on('data', (chunk) => {
          result += chunk.toString();
        });

        response.on('end', () => {
          if (response.statusCode >= 400) {
            const e = new M2CException(`${params.method} ${params.path} ${response.statusCode}`);
            e.statusCode = response.statusCode;
            reject(e);
          } else {
            resolve(result);
          }
        });
      });

      request.once('error', (e) => {
        e.message = `${params.method} ${params.path} - ${e.message}`;
        reject(e);
      });

      if (body.length > 0) {
        request.write(body);
      }
      request.end();
    });
  }

  async send(data, physicalResourceId) {
    const [
      responseStatus,
      responseData,
    ] = CloudFormationResponse.parseResponseData(data);
    console.log(`parseResponseData = ${JSON.stringify({ responseStatus, responseData }, null, 2)}`);

    let Reason = `See details in CloudWatch Log Stream: ${this.logStreamName}`;
    if (responseStatus === FAILED) {
      Reason = `${responseData.Error}. ${Reason}`;
    }

    const responseBody = JSON.stringify({
      Status: responseStatus,
      Reason,
      PhysicalResourceId: physicalResourceId || this.physicalResourceId || this.logStreamName,
      StackId: this.stackId,
      RequestId: this.requestId,
      LogicalResourceId: this.logicalResourceId,
      Data: responseData,
    });
    const url = new URL(this.responseUrl);
    const params = {
      hostname: url.hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: 'PUT',
      headers: {
        'Content-Type': '',
        'Content-Length': responseBody.length,
      },
    };
    let response;
    let tries = 0;
    const maxTries = 10;
    do {
      try {
        response = await this.sendRequest(params, responseBody);
      } catch (e) {
        console.log(`ERR: send[${tries}]: ${e.message}. retry again...${new Date().toISOString()}`);
        await CloudFormationResponse.pause(1 * 1000);
      } finally {
        tries++;
      }
    } while (response === undefined && tries < maxTries);

    return response;
  }
}

module.exports = CloudFormationResponse;
