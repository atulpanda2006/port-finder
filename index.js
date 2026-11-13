'use strict';

/**
 * port-finder - public entry point.
 *
 * Three functions, one job each:
 *
 *   isPortFree(port)  -> is this port bindable right now?          (boolean)
 *   findPort(options) -> which port is free right now?             (number)
 *   findServer(opts)  -> bind a listening server on a free port.   ({ server, port })
 *
 * Everything else in `lib/` is an implementation detail: the binding
 * primitives, the probing strategy and the option parsing are deliberately
 * not exported, so they can change without breaking anyone. Only the
 * documented functions above and the error classes below are public API.
 */

const { isPortFree } = require('./lib/check');
const { findPort } = require('./lib/find');
const { findServer } = require('./lib/server');
const {
  PortFinderError,
  InvalidPortError,
  InvalidRangeError,
  InvalidOptionsError,
  PermissionDeniedError,
  HostUnavailableError,
  NoAvailablePortError,
  AvailabilityUnknownError,
} = require('./lib/errors');

module.exports = {
  // Functions
  isPortFree,
  findPort,
  findServer,

  // Errors. Expected failures reject with a PortFinderError subclass;
  // unexpected operating-system errors are surfaced unchanged. Each subclass
  // is exported so callers can branch on `instanceof` instead of `code`.
  PortFinderError,
  InvalidPortError,
  InvalidRangeError,
  InvalidOptionsError,
  PermissionDeniedError,
  HostUnavailableError,
  NoAvailablePortError,
  AvailabilityUnknownError,
};
