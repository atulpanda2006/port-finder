'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function scanListeningPorts(runCommand = execFileAsync, platform = process.platform) {
  if (platform !== 'darwin') {
    throw new Error(
      'Listening port scanning is currently supported on macOS only.'
    );
  }

  let stdout;

  try {
    const result = await runCommand(
      '/usr/sbin/lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']
    );

    stdout = result.stdout;
  } catch (error) {
    if (error.code === 1 && !error.stdout) {
      return [];
    }

    if (error.code === 1 && error.stdout) {
      stdout = error.stdout;
    } else {
      throw error;
    }
  }

  const ports = new Map();

  let currentPid = null;
  let currentProcess = null;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      currentPid = Number(line.slice(1));
    } else if (line.startsWith('c')) {
      currentProcess = line.slice(1);
    } else if (line.startsWith('n')) {
      const address = line.slice(1);
      const separator = address.lastIndexOf(':');

      if (separator === -1) continue;

      const port = Number(address.slice(separator + 1));

      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        continue;
      }

      if (!ports.has(port)) {
        ports.set(port, {
          port,
          protocol: 'TCP',
          process: currentProcess,
          pid: currentPid,
        });
      }
    }
  }

  return [...ports.values()].sort((a, b) => a.port - b.port);
}

module.exports = { scanListeningPorts };
