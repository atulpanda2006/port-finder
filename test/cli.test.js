'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runCli } = require('../lib/cli');
const { scanListeningPorts } = require('../lib/scanner');
const { NoAvailablePortError } = require('../lib/errors');

async function invoke(args, dependencies = {}) {
  let stdout = '';
  let stderr = '';

  const exitCode = await runCli(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    ...dependencies,
  });

  return { exitCode, stdout, stderr };
}

test('default command lists listening ports sorted by port', async () => {
  const result = await invoke([], {
    scanListeningPorts: async () => [
      { port: 5000, process: 'ControlCenter', pid: 685 },
      { port: 3000, process: 'node', pid: 1234 },
      { port: 3000, process: 'duplicate', pid: 9999 },
      { port: 7000, process: null, pid: null },
    ],
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^PORT\s+PROCESS\s+PID/m);
  assert.ok(
    result.stdout.indexOf('3000') < result.stdout.indexOf('5000'),
    'ports are not sorted'
  );
  assert.equal((result.stdout.match(/\b3000\b/g) ?? []).length, 1);
  assert.match(result.stdout, /7000\s+-\s+-/);
  assert.match(result.stdout, /3 listening ports found\./);
  assert.equal(result.stderr, '');
});

test('default command handles an empty scanner result', async () => {
  const result = await invoke([], {
    scanListeningPorts: async () => [],
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'No listening TCP ports found.\n');
  assert.equal(result.stderr, '');
});

test('check reports an occupied single port', async () => {
  const result = await invoke(['check', '3000'], {
    isPortFree: async () => false,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'Port 3000 is occupied.\n');
  assert.equal(result.stderr, '');
});

test('check reports an available single port and forwards the host', async () => {
  let received;

  const result = await invoke(['check', '3000', '--host', '127.0.0.1'], {
    isPortFree: async (port, options) => {
      received = { port, options };
      return true;
    },
  });

  assert.deepEqual(received, { port: 3000, options: { host: '127.0.0.1' } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'Port 3000 on 127.0.0.1 is available.\n');
});

test('check reports occupied and available ports in a range', async () => {
  const occupied = new Set([3001, 3003]);

  const result = await invoke(['check', '3000-3004'], {
    isPortFree: async (port) => !occupied.has(port),
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Checking 5 ports \(3000-3004\)/);
  assert.match(result.stdout, /Occupied \(2\): 3001, 3003/);
  assert.match(result.stdout, /Available \(3\): 3000, 3002, 3004/);
  assert.equal(result.stderr, '');
});

test('check compacts consecutive ports in range output', async () => {
  const result = await invoke(['check', '3000-3005'], {
    isPortFree: async (port) => port >= 3002,
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Occupied \(2\): 3000-3001/);
  assert.match(result.stdout, /Available \(4\): 3002-3005/);
});

test('find asks the API for an operating-system chosen port', async () => {
  let received = 'not called';

  const result = await invoke(['find'], {
    findPort: async (options) => {
      received = options;
      return 51234;
    },
  });

  assert.equal(received, undefined);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'Available port: 51234\n');
});

test('find searches only inside the requested range', async () => {
  let received;

  const result = await invoke(['find', '3000-4000', '--host', '::1'], {
    findPort: async (options) => {
      received = options;
      return 3002;
    },
  });

  assert.deepEqual(received, { start: 3000, end: 4000, host: '::1' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'Available port in 3000-4000: 3002\n');
});

test('invalid arguments return the usage exit code', async () => {
  const cases = [
    ['check'],
    ['check', '0'],
    ['check', '65536'],
    ['check', '3000.5'],
    ['check', '3000-2000'],
    ['check', '3000-abc'],
    ['check', '3000', '4000'],
    ['check', '3000', '--port'],
    ['find', '3000'],
    ['find', '3000-4000', 'extra'],
    ['find', '3000-4000', '--host'],
    ['--version'],
  ];

  for (const args of cases) {
    const result = await invoke(args);

    assert.equal(result.exitCode, 2, `expected usage error for ${args.join(' ')}`);
    assert.match(result.stderr, /^Error:/);
    assert.match(result.stderr, /Try 'port-finder --help'/);
    assert.equal(result.stdout, '');
  }
});

test('unknown commands are rejected without a stack trace', async () => {
  const result = await invoke(['scan']);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Unknown command "scan"/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('help is available as --help, -h and help', async () => {
  for (const args of [['--help'], ['-h'], ['help']]) {
    const result = await invoke(args);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /^port-finder - inspect listening TCP ports/m);
    assert.match(result.stdout, /check <port\|start-end>/);
    assert.match(result.stdout, /find \[start-end\]/);
    assert.match(result.stdout, /Platform:/);
    assert.match(result.stdout, /macOS lsof/);
    assert.match(result.stdout, /Exit codes:/);
  }
});

test('help works after a command without running it', async () => {
  let called = false;

  const result = await invoke(['check', '--help'], {
    isPortFree: async () => {
      called = true;
      return true;
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Usage:/);
  assert.equal(called, false);
});

test('scanner failures are reported cleanly', async () => {
  const result = await invoke([], {
    scanListeningPorts: async () => {
      throw new Error('scanner exploded');
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, 'Error: scanner exploded\n');
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('a failed range probe is an error, never an available port', async () => {
  const result = await invoke(['check', '3000-3002'], {
    isPortFree: async (port) => {
      if (port === 3001) {
        throw new Error('socket limit reached');
      }
      return true;
    },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /could not check port 3001: socket limit reached/);
  assert.doesNotMatch(result.stdout, /Available \(/);
});

test('find reports exhaustion without a stack trace', async () => {
  const result = await invoke(['find', '3000-3000'], {
    findPort: async () => {
      throw new NoAvailablePortError({ start: 3000, end: 3000 });
    },
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /No available port in the range 3000-3000/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test('unsupported scanner platforms produce a clear failure', async () => {
  const scanOnLinux = () =>
    scanListeningPorts(async () => {
      throw new Error('the command must not run on an unsupported platform');
    }, 'linux');

  const result = await invoke([], { scanListeningPorts: scanOnLinux });

  assert.equal(result.exitCode, 1);
  assert.equal(
    result.stderr,
    'Error: Listening port scanning is currently supported on macOS only.\n'
  );
  assert.equal(result.stdout, '');
});
