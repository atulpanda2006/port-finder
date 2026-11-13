'use strict';

/**
 * Command-line interface for port-finder.
 *
 * This module deliberately contains no process-level concerns (argv, exit,
 * stdout globals) so every command can be tested by injecting its dependencies.
 * `bin/port-finder.js` is the small executable wrapper around `runCli()`.
 */

const { scanListeningPorts } = require('./scanner');
const { isPortFree } = require('./check');
const { findPort } = require('./find');
const { assertHost, assertPort, assertRange } = require('./validate');

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

const HELP = `port-finder - inspect listening TCP ports and find available ones

Usage:
  port-finder
  port-finder check <port|start-end> [--host <host>]
  port-finder find [start-end] [--host <host>]
  port-finder --help | -h

Commands:
  (no command)  List listening TCP ports, process names and PIDs
  check         Check one port or an inclusive range
  find          Find an available port; a range limits the search

Options:
  --host <host> Address to check or bind (default: every local interface)
  -h, --help    Show this help

Examples:
  port-finder
  port-finder check 3000
  port-finder check 3000-4000
  port-finder find
  port-finder find 3000-4000
  port-finder check 3000 --host 127.0.0.1

Platform:
  Listing listening ports currently uses macOS lsof and works on macOS only.
  check and find use Node.js TCP APIs and have only been verified on macOS.

Notes:
  find reports a port that was free when checked; it does not reserve it.

Exit codes:
  0 success, 1 runtime or probe error, 2 invalid usage
`;

/** Invalid command-line input. Reported as usage rather than a package error. */
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function writeDefault(text) {
  process.stdout.write(text);
}

function writeErrorDefault(text) {
  process.stderr.write(text);
}

function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message !== '') {
    return error.message;
  }

  return String(error);
}

function reportFailure(stderr, error) {
  stderr(`Error: ${errorMessage(error)}\n`);
  return EXIT_FAILURE;
}

function usageError(message) {
  throw new UsageError(message);
}

/**
 * Parses one CLI port target. A single port returns `{ start, end }` with equal
 * ends; ranges are inclusive. Shared validation keeps the accepted values
 * identical to the JavaScript API.
 */
function parsePortTarget(value) {
  if (typeof value !== 'string' || value === '') {
    usageError('Expected a port or range, for example 3000 or 3000-4000.');
  }

  const rangeMatch = /^(\d+)-(\d+)$/.exec(value);

  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);

    try {
      assertRange(start, end);
    } catch (error) {
      usageError(error.message);
    }

    return { start, end, isRange: true };
  }

  if (/^\d+$/.test(value)) {
    const port = Number(value);

    try {
      assertPort(port);
    } catch (error) {
      usageError(error.message);
    }

    return { start: port, end: port, isRange: false };
  }

  if (value.includes('-')) {
    usageError(
      `Invalid port range "${value}". Use an inclusive range such as 3000-4000.`
    );
  }

  usageError(
    `Invalid port "${value}". Expected a whole number from 1 to 65535.`
  );
}

/** Parses and validates `--host <host>` and `--host=<host>`. */
function parseHost(value) {
  if (value === undefined) {
    usageError('Option "--host" requires a value, for example --host 127.0.0.1.');
  }

  try {
    return assertHost(value);
  } catch (error) {
    usageError(error.message);
  }
}

/**
 * Reads the optional host and one positional target from command arguments.
 * Options are accepted before or after the target, but repeated hosts, unknown
 * options and extra positional arguments are rejected.
 */
function parseCommandArguments(args, command, { targetRequired = false } = {}) {
  let target = null;
  let host = null;
  let hostSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === '--host') {
      if (hostSeen) {
        usageError('Option "--host" was provided more than once.');
      }

      host = parseHost(args[index + 1]);
      hostSeen = true;
      index += 1;
      continue;
    }

    if (argument.startsWith('--host=')) {
      if (hostSeen) {
        usageError('Option "--host" was provided more than once.');
      }

      host = parseHost(argument.slice('--host='.length));
      hostSeen = true;
      continue;
    }

    if (argument.startsWith('-')) {
      usageError(`Unknown option "${argument}" for ${command}.`);
    }

    if (target !== null) {
      usageError(`Unexpected argument "${argument}" for ${command}.`);
    }

    target = argument;
  }

  if (targetRequired && target === null) {
    usageError(
      `"${command}" requires a port or range, for example ${command} 3000.`
    );
  }

  return { target, host };
}

function processName(value) {
  if (typeof value !== 'string') return '-';

  const name = value.trim().replace(/\s+/g, ' ');
  return name === '' ? '-' : name;
}

function processId(value) {
  return Number.isInteger(value) && value > 0 ? String(value) : '-';
}

/** Sorts by port and removes duplicates defensively, even if a scanner changes. */
function normalizeListeners(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('The port scanner returned an unexpected result.');
  }

  const byPort = new Map();

  for (const entry of entries) {
    if (
      !entry ||
      !Number.isInteger(entry.port) ||
      entry.port < 1 ||
      entry.port > 65535 ||
      byPort.has(entry.port)
    ) {
      continue;
    }

    byPort.set(entry.port, {
      port: entry.port,
      process: processName(entry.process),
      pid: processId(entry.pid),
    });
  }

  return [...byPort.values()].sort((left, right) => left.port - right.port);
}

function listenerTable(entries) {
  const rows = entries.map((entry) => ({
    port: String(entry.port),
    process: entry.process,
    pid: entry.pid,
  }));

  const portWidth = Math.max(4, ...rows.map((row) => row.port.length));
  const processWidth = Math.max(
    'PROCESS'.length,
    ...rows.map((row) => row.process.length)
  );

  const line = (row) =>
    `${row.port.padEnd(portWidth)}  ${row.process.padEnd(processWidth)}  ${row.pid}`;

  const lines = [
    line({ port: 'PORT', process: 'PROCESS', pid: 'PID' }),
    ...rows.map(line),
    '',
    `${rows.length} listening port${rows.length === 1 ? '' : 's'} found.`,
  ];

  return `${lines.join('\n')}\n`;
}

/** Compacts consecutive ports into ranges for readable range-check output. */
function compactPorts(ports) {
  if (ports.length === 0) return 'none';

  const sorted = [...ports].sort((left, right) => left - right);
  const ranges = [];
  let start = sorted[0];
  let end = sorted[0];

  for (const port of sorted.slice(1)) {
    if (port === end + 1) {
      end = port;
      continue;
    }

    ranges.push(start === end ? String(start) : `${start}-${end}`);
    start = port;
    end = port;
  }

  ranges.push(start === end ? String(start) : `${start}-${end}`);
  return ranges.join(', ');
}

async function runList({ scanListeningPorts: scan, stdout }) {
  const entries = normalizeListeners(await scan());

  if (entries.length === 0) {
    stdout('No listening TCP ports found.\n');
    return EXIT_SUCCESS;
  }

  stdout(listenerTable(entries));
  return EXIT_SUCCESS;
}

async function runCheck(args, dependencies) {
  const { target, host } = parseCommandArguments(args, 'check', {
    targetRequired: true,
  });
  const range = parsePortTarget(target);
  const options = host === null ? undefined : { host };
  const location = host === null ? '' : ` on ${host}`;
  const { stdout, stderr, isPortFree: checkPort } = dependencies;

  if (!range.isRange) {
    const free = await checkPort(range.start, options);

    stdout(
      `Port ${range.start}${location} is ${free ? 'available' : 'occupied'}.\n`
    );
    return EXIT_SUCCESS;
  }

  const total = range.end - range.start + 1;
  const available = [];
  const occupied = [];

  stdout(`Checking ${total} port${total === 1 ? '' : 's'} (${range.start}-${range.end})...\n\n`);

  for (let port = range.start; port <= range.end; port += 1) {
    let free;

    try {
      free = await checkPort(port, options);
    } catch (error) {
      stderr(`Error: could not check port ${port}${location}: ${errorMessage(error)}\n`);
      return EXIT_FAILURE;
    }

    (free ? available : occupied).push(port);
  }

  stdout(`Occupied (${occupied.length}): ${compactPorts(occupied)}\n`);
  stdout(`Available (${available.length}): ${compactPorts(available)}\n`);
  return EXIT_SUCCESS;
}

async function runFind(args, dependencies) {
  const { target, host } = parseCommandArguments(args, 'find');
  let range = null;
  let options;

  if (target !== null) {
    if (!/^\d+-\d+$/.test(target)) {
      usageError(
        `"find" expects a range such as 3000-4000, or no port to let the operating system choose.`
      );
    }

    range = parsePortTarget(target);
    options = { start: range.start, end: range.end };
  }

  if (host !== null) {
    options = { ...(options ?? {}), host };
  }

  const port = await dependencies.findPort(options);

  if (range === null) {
    dependencies.stdout(`Available port: ${port}\n`);
  } else {
    dependencies.stdout(
      `Available port in ${range.start}-${range.end}: ${port}\n`
    );
  }

  return EXIT_SUCCESS;
}

/**
 * Runs one CLI invocation. Returns the process exit code instead of exiting, so
 * the executable wrapper and the tests share exactly the same code path.
 *
 * @param {string[]} [argv] - arguments after the executable name
 * @param {object} [injected] - test seams for output and network operations
 * @returns {Promise<number>}
 */
async function runCli(argv = [], injected = {}) {
  const args = Array.isArray(argv) ? argv : [];
  const dependencies = {
    stdout: writeDefault,
    stderr: writeErrorDefault,
    scanListeningPorts,
    isPortFree,
    findPort,
    ...injected,
  };

  try {
    // Help is a global option, so it works after a command too.
    if (args.includes('--help') || args.includes('-h')) {
      dependencies.stdout(HELP);
      return EXIT_SUCCESS;
    }

    if (args[0] === 'help') {
      if (args.length > 1) {
        usageError('The "help" command does not accept additional arguments.');
      }

      dependencies.stdout(HELP);
      return EXIT_SUCCESS;
    }

    if (args.length === 0) {
      return await runList(dependencies);
    }

    const [command, ...commandArgs] = args;

    if (command === 'check') {
      return await runCheck(commandArgs, dependencies);
    }

    if (command === 'find') {
      return await runFind(commandArgs, dependencies);
    }

    if (command.startsWith('-')) {
      usageError(`Unknown option "${command}".`);
    }

    usageError(`Unknown command "${command}".`);
  } catch (error) {
    if (error instanceof UsageError) {
      dependencies.stderr(
        `Error: ${error.message}\n\nTry 'port-finder --help' for usage.\n`
      );
      return EXIT_USAGE;
    }

    // PortFinderError and unexpected failures are both shown without a stack:
    // a CLI user needs the actionable message, not an internal trace.
    return reportFailure(dependencies.stderr, error);
  }
}

module.exports = {
  runCli,
  HELP,
  EXIT_SUCCESS,
  EXIT_FAILURE,
  EXIT_USAGE,
};
