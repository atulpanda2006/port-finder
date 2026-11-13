'use strict';

/**
 * Expected failures are reported with a PortFinderError subclass. Unexpected
 * operating-system errors are surfaced unchanged so they are not mistaken for
 * a package-level conclusion about the port.
 *
 * Two things make these errors useful in real code:
 *   1. `err.code` is a stable, machine-readable string. Check it with
 *      `if (err.code === 'ERR_INVALID_PORT')` instead of matching messages.
 *   2. The classes support `instanceof`, so `err instanceof InvalidPortError`
 *      also works if you prefer.
 */

/**
 * Turns any value into a short, readable description for error messages.
 * `"3000"` becomes `"\"3000\""` so it is obvious the value was a string,
 * not the number 3000 - a common and confusing mistake.
 */
function describeValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);

    // Plain objects (and ones made with Object.create(null)) get a generic
    // description so messages stay short.
    if (prototype === Object.prototype || prototype === null) return 'an object';

    // Anything else gets its class name, so `new Date()` reads as
    // "a Date instance" instead of the useless "an object".
    const name = value.constructor && value.constructor.name;
    return name ? `a ${name} instance` : 'an object';
  }
  return String(value);
}

/** Base class for all errors thrown by port-finder. */
class PortFinderError extends Error {
  constructor(message, { code = 'ERR_PORT_FINDER', port, range, value, cause } = {}) {
    super(message);

    // `this.constructor.name` keeps the name correct for subclasses.
    this.name = this.constructor.name;
    this.code = code;

    // Only attach optional fields when they are actually known, so callers
    // never have to check for properties that are present but undefined.
    if (port !== undefined) this.port = port;
    if (range !== undefined) this.range = range;
    if (value !== undefined) this.value = value;
    if (cause !== undefined) this.cause = cause;

    // Remove this constructor from the stack trace so the first line the
    // user sees is the place that actually called us.
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/** Thrown when a value is not a usable TCP port number. */
class InvalidPortError extends PortFinderError {
  constructor(value, detail = 'Expected an integer between 1 and 65535.') {
    super(`Invalid port ${describeValue(value)}. ${detail}`, {
      code: 'ERR_INVALID_PORT',
      // Only set `port` for usable numbers; the raw input is kept in `value`.
      port: typeof value === 'number' && Number.isInteger(value) ? value : undefined,
      value,
    });
  }
}

/** Thrown when a requested range ends before it starts. */
class InvalidRangeError extends PortFinderError {
  constructor(start, end) {
    super(`Invalid port range ${start}-${end}. "start" must be less than or equal to "end".`, {
      code: 'ERR_INVALID_RANGE',
      range: { start, end },
    });
  }
}

/** Thrown when the options object itself is wrong: bad host, unknown key, ... */
class InvalidOptionsError extends PortFinderError {
  constructor(message, { option, cause } = {}) {
    super(message, { code: 'ERR_INVALID_OPTIONS', cause });
    if (option !== undefined) this.option = option;
  }
}

/**
 * Thrown when the operating system refuses to let this process bind the port.
 * The most common cause is asking for a port below 1024 without privileges.
 */
class PermissionDeniedError extends PortFinderError {
  constructor(port, host, cause) {
    const location = host ? ` on ${host}` : '';

    super(
      `Permission denied when binding to port ${port}${location}. Ports below 1024 are privileged: on macOS and Linux they require root or administrator rights. Choose a port of 1024 or higher.`,
      { code: 'ERR_PERMISSION_DENIED', port, cause }
    );

    if (host) this.host = host;
  }
}

/**
 * Thrown when a search finished without finding a usable port, because every
 * candidate in the requested range is already in use, excluded, or both.
 *
 * `range` is `{ start, end }`, or undefined when an ephemeral port was asked
 * for and the operating system kept offering excluded ports.
 */
class NoAvailablePortError extends PortFinderError {
  constructor(range, { host = null, excludeCount = 0 } = {}) {
    const location = host ? ` on ${host}` : '';
    const subject = range
      ? `the range ${range.start}-${range.end}${location}`
      : `any ephemeral port${location}`;
    const excluded =
      excludeCount > 0
        ? ` ${excludeCount} port${excludeCount === 1 ? ' was' : 's were'} excluded.`
        : '';

    super(
      `No available port in ${subject}.${excluded} Every candidate is in use or excluded. Widen the range, free a port, or remove entries from "exclude".`,
      { code: 'ERR_NO_PORT_FOUND', range: range ?? undefined }
    );

    if (host) this.host = host;
    if (excludeCount > 0) this.excludeCount = excludeCount;
  }
}

/**
 * Thrown when the requested host cannot be bound on this machine, either
 * because the address is not on a local interface or the name does not
 * resolve. Kept separate from "port is occupied" so callers are not sent
 * looking for a process that does not exist.
 */
class HostUnavailableError extends PortFinderError {
  constructor(host, { port, cause } = {}) {
    super(
      `Host ${JSON.stringify(host)} cannot be bound on this machine. Check that the address belongs to a local network interface (for example "127.0.0.1" or "::1"), or that the hostname resolves.`,
      { code: 'ERR_HOST_UNAVAILABLE', port, cause }
    );

    this.host = host;
  }
}

/**
 * Thrown when availability could not be established at all.
 *
 * This is the answer for the one case that must never become `true`: every
 * address probe was skipped before a socket was actually bound (for example,
 * the OS rejected each local address with EADDRNOTAVAIL). The port is not
 * reported as free, because nothing was successfully bound to prove it.
 */
class AvailabilityUnknownError extends PortFinderError {
  constructor(port, { host, cause } = {}) {
    const location = host ? ` on ${host}` : '';

    super(
      `Could not determine whether port ${port}${location} is available. Every address probe failed with an address-specific error, so no socket was actually bound. Check that a loopback or local network interface is available${host ? ` and that ${host} belongs to this machine` : ''}.`,
      { code: 'ERR_AVAILABILITY_UNKNOWN', port, cause }
    );

    if (host) this.host = host;
  }
}

module.exports = {
  PortFinderError,
  InvalidPortError,
  InvalidRangeError,
  InvalidOptionsError,
  PermissionDeniedError,
  HostUnavailableError,
  NoAvailablePortError,
  AvailabilityUnknownError,
  describeValue,
};
