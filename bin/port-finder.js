#!/usr/bin/env node
'use strict';

const { runCli } = require('../lib/cli');

runCli(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    const message =
      error && typeof error.message === 'string' ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  });
