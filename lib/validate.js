'use strict';

/**
 * All input checking lives in this one file.
 *
 * Why a dedicated validation module instead of `if` statements sprinkled
 * through the code? Because invalid input is the most common reason a
 * utility like this misbehaves, and it deserves its own tested home.
 *
 * The rules enforced here:
 *   - A port is a whole number between 1 and 65535 (inclusive).
 *   - 0 is NOT a port you can ask for: it is handled separately as
 *     "let the operating system choose a free port".
 *   - Strings such as "3000" are rejected on purpose. Silently accepting
 *     them hides typos and leads to surprising behaviour.
 *   - Unknown option keys are rejected so typos like `{ prot: 3000 }` fail
 *     loudly instead of being ignored.
 */

const {
  InvalidPortError,
  InvalidRangeError,
  InvalidOptionsError,
  describeValue,
} = require('./errors');

const MIN_PORT = 1;
const MAX_PORT = 65535;

/** Option names accepted by findPort/isPortFree/findServer. */
const SUPPORTED_OPTIONS = ['start', 'end', 'host', 'exclude'];

/**
 * Checks one port number and returns it unchanged, so it can be used inline.
 * Throws InvalidPortError if the value is not a valid port.
 */
function assertPort(value) {
  if (typeof value !== 'number') {
    throw new InvalidPortError(
      value,
      `Expected a number, received ${describeValue(value)}.`
    );
  }

  if (!Number.isInteger(value)) {
    throw new InvalidPortError(value, 'Ports must be whole numbers.');
  }

  if (value < MIN_PORT || value > MAX_PORT) {
    throw new InvalidPortError(
      value,
      `Expected an integer between ${MIN_PORT} and ${MAX_PORT}.`
    );
  }

  return value;
}

/**
 * Checks that both ends of a range are valid ports and that they are in the
 * right order. `start` may equal `end` (a one-port range is legitimate).
 */
function assertRange(start, end) {
  assertPort(start);
  assertPort(end);

  if (start > end) {
    throw new InvalidRangeError(start, end);
  }

  return { start, end };
}

/**
 * Checks a host string. We do not try to resolve it here: resolution is a
 * network operation that belongs to the checking step, and this function
 * stays synchronous and side-effect free.
 */
function assertHost(value) {
  if (typeof value !== 'string') {
    throw new InvalidOptionsError(
      `Invalid "host": expected a non-empty string such as "127.0.0.1" or "localhost", but received ${describeValue(value)}.`,
      { option: 'host' }
    );
  }

  if (value.trim() === '') {
    throw new InvalidOptionsError(
      `Invalid "host" ${JSON.stringify(value)}: the value is empty or contains only whitespace.`,
      { option: 'host' }
    );
  }

  // A padded host would fail much later, inside the network layer, with a
  // confusing ENOTFOUND. Rejecting it here gives the caller a clear fix.
  if (value !== value.trim()) {
    throw new InvalidOptionsError(
      `Invalid "host" ${JSON.stringify(value)}: remove the leading or trailing whitespace (did you mean ${JSON.stringify(value.trim())}?).`,
      { option: 'host' }
    );
  }

  return value;
}

/**
 * Normalises the `exclude` option into a Set for fast lookups.
 * Accepts any iterable of port numbers (array, Set, generator...).
 * Strings are rejected even though they are iterable, because a string here
 * is almost certainly a bug.
 */
function normalizeExclude(value) {
  if (value === null || value === undefined) {
    return new Set();
  }

  if (typeof value === 'string' || typeof value[Symbol.iterator] !== 'function') {
    throw new InvalidOptionsError(
      `Invalid "exclude": expected an array or iterable of port numbers, but received ${describeValue(value)}.`,
      { option: 'exclude' }
    );
  }

  const ports = new Set();

  for (const item of value) {
    try {
      ports.add(assertPort(item));
    } catch (error) {
      throw new InvalidOptionsError(
        `Invalid "exclude" entry ${describeValue(item)}: expected an integer between ${MIN_PORT} and ${MAX_PORT}.`,
        { option: 'exclude', cause: error }
      );
    }
  }

  return ports;
}

/**
 * True only for plain objects: object literals, objects parsed from JSON, and
 * objects created with Object.create(null). A Date, a Map or a class instance
 * is not an options object; treating it as empty options would silently
 * ignore whatever the caller meant to ask for.
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * True when every port from `start` to `end` appears in `exclude`.
 * Such a request can never succeed, so it is rejected while validating
 * instead of being scanned and failing later.
 */
function isRangeFullyExcluded(start, end, exclude) {
  const rangeSize = end - start + 1;
  if (exclude.size < rangeSize) return false;

  let covered = 0;

  for (const port of exclude) {
    if (port >= start && port <= end) {
      covered += 1;
      if (covered === rangeSize) return true;
    }
  }

  return false;
}

/**
 * Turns every accepted calling style into one predictable shape:
 *
 *   normalizeOptions()                                   -> random port
 *   normalizeOptions(3000)                               -> 3000, then upwards
 *   normalizeOptions({ start: 3000, end: 3010 })         -> inside the range
 *   normalizeOptions({ host: '127.0.0.1' })              -> random port on that host
 *
 * `start: null` means "let the operating system pick" and `end: null` means
 * "no upper limit applies". Returning a single shape keeps the searching
 * logic simple, because it only ever deals with one set of fields.
 */
function normalizeOptions(input) {
  if (input === undefined || input === null) {
    return { start: null, end: null, host: null, exclude: new Set() };
  }

  // A bare number is the beginner-friendly shorthand for "this port, then up".
  if (typeof input === 'number') {
    return {
      start: assertPort(input),
      end: MAX_PORT,
      host: null,
      exclude: new Set(),
    };
  }

  if (!isPlainObject(input)) {
    throw new InvalidOptionsError(
      `Invalid options: expected a port number or an options object such as { start: 3000, end: 3010 }, but received ${describeValue(input)}.`
    );
  }

  for (const key of Object.keys(input)) {
    if (!SUPPORTED_OPTIONS.includes(key)) {
      throw new InvalidOptionsError(
        `Unknown option "${key}". Supported options are: ${SUPPORTED_OPTIONS.join(', ')}.`,
        { option: key }
      );
    }
  }

  // Destructuring defaults only apply to `undefined`, so an explicit
  // `{ start: null }` and an omitted `start` behave the same way.
  const { start = null, end = null, host = null, exclude = null } = input;

  if (start === null && end !== null) {
    throw new InvalidOptionsError(
      'Option "end" requires "start", because the scan has to begin somewhere. Pass both, or omit both to let the operating system choose a port.',
      { option: 'end' }
    );
  }

  // assertRange validates both ends exactly once and returns the range that
  // will actually be searched, so nothing needs to be checked twice.
  const range = start === null ? null : assertRange(start, end === null ? MAX_PORT : end);

  const hostValue = host === null ? null : assertHost(host);
  const excludePorts = normalizeExclude(exclude);

  if (range !== null && isRangeFullyExcluded(range.start, range.end, excludePorts)) {
    throw new InvalidOptionsError(
      `Option "exclude" lists every port in the range ${range.start}-${range.end}, so no port could ever be found. Remove some ports from "exclude" or widen the range.`,
      { option: 'exclude' }
    );
  }

  return {
    start: range === null ? null : range.start,
    end: range === null ? null : range.end,
    host: hostValue,
    exclude: excludePorts,
  };
}

module.exports = {
  MIN_PORT,
  MAX_PORT,
  assertPort,
  assertRange,
  assertHost,
  isPlainObject,
  normalizeExclude,
  normalizeOptions,
};
