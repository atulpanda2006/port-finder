'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { scanListeningPorts } = require('../lib/scanner');

function listen() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);

    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
      });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test('scanner discovers a real occupied TCP port', async () => {
  const { server, port } = await listen();

  try {
    const results = await scanListeningPorts();

    assert.ok(
      results.some((entry) => entry.port === port)
    );
  } finally {
    await close(server);
  }
});

test('scanner returns process information for a listening port', async () => {
  const { server, port } = await listen();

  try {
    const results = await scanListeningPorts();
    const entry = results.find((item) => item.port === port);

    assert.ok(entry);
    assert.equal(entry.pid, process.pid);
    assert.equal(typeof entry.process, 'string');
    assert.equal(entry.protocol, 'TCP');
  } finally {
    await close(server);
  }
});

test('scanner returns no duplicate entries for the same port', async () => {
  const { server, port } = await listen();

  try {
    const results = await scanListeningPorts();
    const matchingEntries = results.filter(
      (entry) => entry.port === port
    );

    assert.equal(matchingEntries.length, 1);
  } finally {
    await close(server);
  }
});

test('scanner returns an empty array when no ports are found', async () => {
  const noPortsCommand = async () => {
    const error = new Error('No listening ports found');
    error.code = 1;
    error.stdout = '';
    throw error;
  };

  const results = await scanListeningPorts(noPortsCommand);
  assert.deepEqual(results, []);
});

test('scanner propagates unexpected command errors', async () => {
  const failingCommand = async () => {
    const error = new Error('Command failed');
    error.code = 127;
    throw error;
  };

  await assert.rejects(
    scanListeningPorts(failingCommand),
    { code: 127 }
  );
});
