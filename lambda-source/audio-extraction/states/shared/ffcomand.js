// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
const {
  cpus,
} = require('node:os');
const {
  spawnSync,
  spawn,
} = require('node:child_process');

const FFOPTS = [
  '-y',
  '-threads',
  cpus().length,
  '-v',
  'quiet',
];

async function _runFFCommand(commands) {
  const promise = new Promise((resolve, reject) => {
    const cmdOpts = [...FFOPTS, ...commands];
    console.log(`cmdOpts: ${cmdOpts.join(' ')}`)

    const output = cmdOpts[cmdOpts.length - 1];

    const shOptions = {
      cwd: undefined,
      env: process.env,
      maxBuffer: 60 * 1024 * 1024,
    };

    let stdouts = [];
    let stderrs = [];

    const spawned = spawn('ffmpeg', cmdOpts, shOptions);

    spawned.on('error', (e) => {
      console.log(`spawn.error: ${e}`);
      reject(e);
    });

    spawned.on('exit', (code) => {
      console.log(`spawn.exit: ${code}`);

      stdouts = Buffer.concat(stdouts).toString('utf8');
      stderrs = Buffer.concat(stderrs).toString('utf8');

      if (code !== 0) {
        reject(new Error(`ERR: error with exit code (${code})`));
        return;
      }
      resolve(output);
    });

    spawned.stdout.on('data', (chunk) => {
      console.log(`spawn.stdout.data: ${chunk.toString('utf8')}`);
      stdouts.push(chunk);
    });

    spawned.stderr.on('data', (chunk) => {
      console.log(`spawn.stdout.data: ${chunk.toString('utf8')}`);
      stderrs.push(chunk);
    });
  });

  return await promise;
}

async function _runFFCommandSync(commands) {
  const cmdOpts = [...FFOPTS, ...commands];

  console.log(`cmdOpts: ${cmdOpts.join(' ')}`)

  const shOptions = {
    cwd: undefined,
    env: process.env,
    maxBuffer: 60 * 1024 * 1024,
  };

  const response = spawnSync('ffmpeg', cmdOpts, shOptions);

  if (response.error !== undefined) {
    console.log(response.error);
    throw new Error(response.error);
  }

  if (response.status !== 0) {
    console.log(response);

    if (response.stdout instanceof Buffer) {
      console.log('stdout:', response.stdout.toString('utf8'));
    } else if (typeof response.stdout === 'string') {
      console.log('stdout:', response.stdout);
    }

    if (response.stderr instanceof Buffer) {
      console.log('stderr:', response.stderr.toString('utf8'));
    } else if (typeof response.stderr === 'string') {
      console.log('stderr:', response.stderr);
    }

    throw new Error(`exitcode not zero: ${response.status}`);
  }

  const output = cmdOpts[cmdOpts.length - 1];
  return output;
}

async function runFFCommand(commands, modeAsync = true) {
  if (modeAsync) {
    return await _runFFCommand(commands);
  }
  return await _runFFCommandSync(commands);
}

module.exports = {
  runFFCommand,
};
