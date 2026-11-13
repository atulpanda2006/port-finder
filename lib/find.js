'use strict';

/**
 * findPort - port discovery on top of the availability check.
 *
 * Checking is not reserving
 * -------------------------
 * findPort() answers "which port is free right now?". It does not keep the
 * port: the probe socket is closed before the promise resolves, because a
 * port held open by us could not be bound by the caller's own server.
 *
 * That means there is always a small window between the answer and the
 * caller's `server.listen()`. If another process grabs the port in that
 * window, binding fails with EADDRINUSE. Nothing can close that window from
 * inside this package - reserving the port would require handing the caller a
 * socket instead of a number. Treat findPort() as a well-informed guess, not
 * a lock, and retry if the caller loses the race.
 */

const { isPortFree, findEphemeralPort } = require('./check');
const { normalizeOptions } = require('./validate');
const { NoAvailablePortError } = require('./errors');

/** How many ephemeral ports we are willing to ask the OS for. */
const EPHEMERAL_ATTEMPTS = 10;

/**
 * Asks the operating system for an ephemeral port that is not excluded.
 *
 * The OS picks freely, so an excluded port has to be rejected after the fact
 * and another one requested. The attempt limit keeps a pathological `exclude`
 * (for example every port on the machine) from looping forever.
 */
async function chooseEphemeralPort(host, exclude) {
  if (exclude.size === 0) return findEphemeralPort(host);

  for (let attempt = 0; attempt < EPHEMERAL_ATTEMPTS; attempt += 1) {
    const port = await findEphemeralPort(host);

    if (!exclude.has(port)) return port;
  }

  throw new NoAvailablePortError(null, { host, excludeCount: exclude.size });
}

/**
 * Finds a TCP port that can be bound right now.
 *
 *   await findPort()                                    // ephemeral port
 *   await findPort(3000)                                // 3000, else upwards
 *   await findPort({ start: 3000, end: 3010 })          // inside the range
 *   await findPort({ start: 3000, end: 3010, host: '127.0.0.1', exclude: [3003] })
 *
 * The search is strictly bounded by `end`: if nothing in the range is usable
 * this throws NoAvailablePortError instead of quietly returning a port the
 * caller did not ask for. Permission and host problems are not swallowed
 * either - they come from isPortFree as their own errors, because scanning
 * further would never fix them.
 *
 * An omitted `host` means "every local interface": each candidate is probed
 * on both wildcards and every concrete local address, and an ephemeral port is
 * verified the same way. That is deliberately wider than findServer(), which
 * binds loopback by default because it hands back a live server.
 *
 * Every call keeps its own state, so concurrent calls do not interfere.
 * They can still be handed the same port, because the check never reserves.
 *
 * @param {number|object|null} [options]
 * @returns {Promise<number>}
 */
async function findPort(options) {
  const { start, end, host, exclude } = normalizeOptions(options);

  // No range was requested: let the operating system choose. "Preferred port"
  // and "specified range" are both handled by the loop below.
  if (start === null) {
    return chooseEphemeralPort(host, exclude);
  }

  // Reused for every candidate, so the options object is created once.
  const checkOptions = host === null ? undefined : { host };

  for (let port = start; port <= end; port += 1) {
    if (exclude.has(port)) continue;

    if (await isPortFree(port, checkOptions)) return port;
  }

  throw new NoAvailablePortError({ start, end }, { host, excludeCount: exclude.size });
}

module.exports = { findPort };
