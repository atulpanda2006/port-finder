'use strict';

/**
 * findServer - bind a TCP server on the first port that is really available.
 *
 * Why this does not call isPortFree()
 * ----------------------------------
 * Checking a port and then binding it leaves a gap: another process can take
 * the port between the two steps. findServer() skips the check and simply
 * tries to listen. "EADDRINUSE" then means "this port is gone, try the next
 * one", which is the only race-free way to answer the question. The server
 * that finally listens is the very same object that is returned, so nothing
 * can steal the port from the caller in between.
 *
 * The caller owns the server
 * --------------------------
 * The returned server is already listening. It has no 'request'/'connection'
 * handler attached: add one (or use it with an existing framework) and call
 * server.close() when done. findServer() keeps no reference to it, so it will
 * not be closed behind the caller's back.
 */

const net = require('node:net');

const { classifyBindError } = require('./check');
const { normalizeOptions } = require('./validate');
const {
  PermissionDeniedError,
  HostUnavailableError,
  NoAvailablePortError,
} = require('./errors');

/** How many ephemeral ports to ask for when some are excluded. */
const EPHEMERAL_ATTEMPTS = 10;

/**
 * The default bind address for findServer().
 *
 * A server is a listening surface, so the safe default is loopback. Binding
 * every interface has to be requested explicitly with "0.0.0.0" or "::".
 */
const DEFAULT_HOST = '127.0.0.1';

/**
 * Creates a server and binds it to `port` (0 means "let the OS choose").
 *
 * Resolves with a listening server. Rejects with the original Node.js error,
 * leaving no listener attached to the failed server. The 'error' listener is
 * removed once listening succeeds, so later errors belong to the caller.
 */
function listenOnce(port, host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let settled = false;

    function onError(error) {
      if (settled) return;
      settled = true;
      server.removeListener('listening', onListening);
      reject(error);
    }

    function onListening() {
      if (settled) return;
      settled = true;
      server.removeListener('error', onError);
      resolve(server);
    }

    server.once('error', onError);
    server.once('listening', onListening);

    // `exclusive: true` makes the bind fail instead of being shared with
    // another process, which is what makes one attempt conclusive.
    server.listen({ port, host: host ?? undefined, exclusive: true });
  });
}

/** Closes a server we decided not to keep, and waits for the handle release. */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Turns a failed bind into the error the caller should see, or null when the
 * port was merely taken and the search should continue.
 */
function failureFor(error, port, host) {
  switch (classifyBindError(error, host !== null)) {
    case 'occupied':
      return null;
    case 'permission':
      return new PermissionDeniedError(port, host, error);
    case 'host':
      return new HostUnavailableError(host, { port, cause: error });
    default:
      // Address problems only exist for addresses the OS chose, and the
      // default bind uses one wildcard target, so anything else - unknown
      // codes, resource exhaustion - is a real failure worth surfacing.
      return error;
  }
}

/** Binds port 0 and retries if the OS happens to pick an excluded port. */
async function bindEphemeral(host, exclude) {
  const attempts = exclude.size === 0 ? 1 : EPHEMERAL_ATTEMPTS;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let server;

    try {
      server = await listenOnce(0, host);
    } catch (error) {
      throw failureFor(error, 0, host) ?? error;
    }

    const port = server.address().port;
    if (!exclude.has(port)) return { server, port };

    // The OS picked a port the caller forbade: hand it back and ask again.
    await closeServer(server);
  }

  throw new NoAvailablePortError(null, { host, excludeCount: exclude.size });
}

/**
 * Binds a listening server on a port that is free right now.
 *
 *   const { server, port } = await findServer();          // ephemeral, loopback
 *   await findServer(3000);                               // 3000, else upwards
 *   await findServer({ start: 3000, end: 3010 });
 *   await findServer({ start: 3000, end: 3010, host: '0.0.0.0' });
 *   await findServer({ start: 3000, end: 3010, exclude: [3003] });
 *
 * `host` defaults to "127.0.0.1": the returned server is reachable from this
 * machine only. Pass "0.0.0.0" (IPv4) or "::" (IPv6) to listen on every
 * interface. `findPort()` and `isPortFree()` are different: they only report
 * availability and default to checking every local interface.
 *
 * A bare number is a preferred port: if it is taken, the search continues
 * upward to 65535. A specified range never scans past `end`; when every
 * candidate is taken or excluded, NoAvailablePortError is thrown.
 *
 * @param {number|object|null} [options]
 * @returns {Promise<{ server: net.Server, port: number }>}
 */
async function findServer(options) {
  const { start, end, host, exclude } = normalizeOptions(options);

  // The caller gets a listening surface, not just a number, so the safe
  // default is loopback. The default is applied here (not in
  // normalizeOptions) because the probing functions keep their own, wider
  // meaning of an omitted host.
  const bindHost = host ?? DEFAULT_HOST;

  if (start === null) {
    return bindEphemeral(bindHost, exclude);
  }

  for (let port = start; port <= end; port += 1) {
    if (exclude.has(port)) continue;

    try {
      const server = await listenOnce(port, bindHost);

      // server.address() is authoritative: it is the port the OS accepted.
      return { server, port: server.address().port };
    } catch (error) {
      const failure = failureFor(error, port, bindHost);
      if (failure === null) continue;

      throw failure;
    }
  }

  throw new NoAvailablePortError({ start, end }, { host: bindHost, excludeCount: exclude.size });
}

module.exports = { findServer };
