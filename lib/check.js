'use strict';

/**
 * "Can this port be bound right now?" - the single primitive the whole
 * package is built on.
 *
 * Why we bind instead of connecting
 * ---------------------------------
 * An older technique is to try to *connect* to the port: if the connection
 * fails, the port must be free. That is unreliable. A firewall can drop the
 * packet so nothing answers even though a process is listening, and a
 * connect test says nothing about whether *our* process is allowed to bind.
 *
 * The only honest test is to do exactly what a real server does: open a TCP
 * server on the port, and immediately close it. If the operating system lets
 * us listen, the port was available to us.
 *
 * Why the default check probes wildcards AND every local address
 * --------------------------------------------------------------
 * A port is only really usable if BOTH directions are clear, and the two
 * platforms disagree about which direction they enforce:
 *
 *   - Linux: a bind conflicts with any overlapping bind. Binding 0.0.0.0
 *     fails while 127.0.0.1 is held, and binding 127.0.0.1 fails while
 *     0.0.0.0 is held. Either probe alone would be enough.
 *   - macOS and other BSD systems: a bind does NOT conflict with an
 *     overlapping bind (SO_REUSEADDR is on by default). Binding 127.0.0.1
 *     succeeds while 0.0.0.0 is held, and binding 0.0.0.0 succeeds while
 *     127.0.0.1 is held. Neither probe sees the other, so a port with a
 *     server on all interfaces was previously reported free.
 *
 * The only portable answer is to probe the wildcard addresses (0.0.0.0 and
 * ::) *and* each concrete local address. The wildcard probe catches a server
 * listening on every interface; the concrete probe catches a server listening
 * on just one. Both are needed on BSD/macOS, and the extra probes are
 * harmless on Linux.
 *
 * Probes run one at a time. On some systems binding :: reserves the IPv4
 * wildcard too, so overlapping probes running concurrently could collide with
 * each other and invent an EADDRINUSE that no real process caused.
 *
 * An explicit `host` is checked on its own: the caller asked about one
 * address, so that is the address we test. A known limitation follows from
 * this - on BSD/macOS, `{ host: '127.0.0.1' }` cannot see a server that is
 * listening on 0.0.0.0, because the operating system really would let the
 * caller bind that address. Use the default check when the question is "can
 * my server use this port anywhere?", which is the usual intent.
 */

const net = require('node:net');
const os = require('node:os');

const { assertPort, assertHost, isPlainObject } = require('./validate');
const {
  InvalidOptionsError,
  PermissionDeniedError,
  HostUnavailableError,
  AvailabilityUnknownError,
  describeValue,
} = require('./errors');

/** isPortFree supports only these options (the rest belong to findPort). */
const SUPPORTED_OPTIONS = ['host'];

/** The one error code that means the port itself is taken. */
const OCCUPIED_CODE = 'EADDRINUSE';

/** Error codes that mean "we are not allowed to bind here". */
const PERMISSION_CODES = ['EACCES', 'EPERM'];

/**
 * Error codes that describe the ADDRESS rather than the port: it is not on
 * this machine, its address family is unsupported here, an IPv6 link-local
 * address arrived without its zone, or a hostname did not resolve.
 *
 * These are the only error codes we are willing to ignore for addresses we
 * picked ourselves. Anything else - EMFILE, ENFILE, ENOMEM, ENOSPC, ... - means
 * the check could not be performed and must never be read as "free".
 */
const ADDRESS_CODES = [
  'EADDRNOTAVAIL',
  'EAFNOSUPPORT',
  'EINVAL',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NODATA',
];

/**
 * Wildcard addresses. A listener here accepts traffic for every interface,
 * so binding one of them is the only reliable way to notice a server that is
 * listening "everywhere".
 */
const WILDCARD_HOSTS = ['0.0.0.0', '::'];

/**
 * Tries to bind a TCP server to `port`, then closes it again.
 *
 * Resolves with the bound address (`{ address, family, port }`) when the bind
 * succeeded. The port matters when the caller asked for port 0 and let the
 * operating system choose. Rejects with the original Node.js error when it
 * failed, so the caller can decide what each error code means. Keeping this
 * function "dumb" is what makes classification easy to read and test.
 *
 * @param {number} port
 * @param {string|null} host - null means "every local interface".
 */
function tryBind(port, host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let settled = false;

    // Both listeners are removed from every path below, so a finished probe
    // never keeps the server object alive. The 'error' listener deliberately
    // stays attached while close() runs: an error emitted there would
    // otherwise crash the process as an unhandled 'error' event.
    function onError(error) {
      if (settled) return;
      settled = true;
      server.removeListener('listening', onListening);
      reject(error);
    }

    function onListening() {
      if (settled) return;
      settled = true;
      server.removeListener('listening', onListening);

      // Read the address before closing: with port 0 this is where the
      // operating system actually placed us.
      const address = server.address();

      // Close immediately: the goal is to answer the question, not to keep
      // the port. The callback fires once the handle is fully released, so
      // the caller can bind the same port straight away.
      server.close((closeError) => {
        server.removeListener('error', onError);

        if (closeError) {
          reject(closeError);
        } else {
          resolve(address);
        }
      });
    }

    server.once('error', onError);
    server.once('listening', onListening);

    // `exclusive: true` asks Node not to share the handle with other cluster
    // workers, so a successful bind really means this process owns the port.
    // `undefined` host makes Node bind every local interface.
    server.listen({ port, host: host ?? undefined, exclusive: true });
  });
}

/**
 * Every address this machine currently has, IPv4 and IPv6, including
 * loopback. Duplicates are removed because the same address can appear on
 * more than one interface.
 */
function localAddresses() {
  const addresses = new Set();

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry && entry.address) addresses.add(entry.address);
    }
  }

  return [...addresses];
}

/**
 * Asks the operating system for a free ephemeral port: binds port 0, reads
 * the number the kernel assigned, then releases it again.
 *
 * The port was free at the instant it was handed out. It is NOT reserved -
 * the socket is closed before this returns, exactly like a normal check, so
 * the caller can still lose the race to another process.
 *
 * @param {string|null} host - null means "every local interface".
 * @returns {Promise<number>}
 */
async function findEphemeralPort(host = null) {
  try {
    const { port } = await tryBind(0, host);
    return port;
  } catch (error) {
    // Port 0 cannot be occupied or privileged, so the only understandable
    // failure left is the address itself. Everything else is rethrown as-is:
    // an ephemeral port that could not be obtained is not a free port.
    if (classifyProbeError(error, host !== null) === 'host') {
      throw new HostUnavailableError(host, { cause: error });
    }

    throw error;
  }
}

/**
 * The addresses a check of `host` has to probe, in order.
 *
 * With an explicit host there is exactly one target: the address the caller
 * asked about. Otherwise the wildcards come first (the common case is a
 * server bound to every interface) followed by each concrete local address.
 */
function probeTargets(host) {
  if (host !== null) return [host];

  return [...new Set([...WILDCARD_HOSTS, ...localAddresses()])];
}

/**
 * Binds one address and reports the failure instead of throwing it.
 *
 * Resolves with null when the bind succeeded, otherwise with the original
 * Node.js error so the caller can classify it.
 */
async function probeTarget(port, target) {
  try {
    await tryBind(port, target);
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * Decides what a failed probe means.
 *
 * Returns:
 *   'occupied'    - the port is in use; the answer is false.
 *   'permission'  - this process may not bind here; throw, never false.
 *   'host'        - the address itself is unusable; throw when the caller
 *                   chose it, skip when the operating system handed it to us
 *                   (an IPv6 link-local address without a zone, an interface
 *                   that is down, ...) because that says nothing about the
 *                   port.
 *   'unexpected'  - anything else, including resource exhaustion. Throw it:
 *                   a check that could not run must never look like "free".
 */
function classifyProbeError(error, explicitHost) {
  if (error.code === OCCUPIED_CODE) return 'occupied';
  if (PERMISSION_CODES.includes(error.code)) return 'permission';

  if (ADDRESS_CODES.includes(error.code)) {
    return explicitHost ? 'host' : 'skip';
  }

  return 'unexpected';
}

/**
 * Probes every target until something is found, and returns
 * `{ target, error }` for the first address that is already in use.
 * Resolves with null when the port was actually bound on every target it
 * could probe.
 *
 * Throws for anything that is not a plain "occupied" answer. Probes run
 * sequentially: see the note at the top of this file for why.
 *
 * `probed` is the important part: "free" means at least one probe really
 * bound the port. If every probe was skipped - all addresses rejected with
 * EADDRNOTAVAIL and friends - nothing was proven, so availability is unknown
 * rather than true. Reporting `true` there would be the exact false positive
 * this module exists to prevent.
 */
async function findObstacle(port, host) {
  let probed = false;
  let skippedError = null;

  for (const target of probeTargets(host)) {
    const error = await probeTarget(port, target);

    if (error === null) {
      probed = true;
      continue;
    }

    switch (classifyProbeError(error, host !== null)) {
      case 'occupied':
        return { target, error };
      case 'permission':
        throw new PermissionDeniedError(port, host, error);
      case 'host':
        throw new HostUnavailableError(target, { port, cause: error });
      case 'skip':
        skippedError = error;
        continue;
      default:
        throw error;
    }
  }

  if (!probed) {
    throw new AvailabilityUnknownError(port, {
      host: host ?? undefined,
      cause: skippedError ?? undefined,
    });
  }

  return null;
}

/**
 * Validates the small options object accepted by isPortFree.
 * Returns a normalised `{ host }` where null means "every local address".
 */
function normalizeCheckOptions(input) {
  if (input === undefined || input === null) {
    return { host: null };
  }

  if (!isPlainObject(input)) {
    throw new InvalidOptionsError(
      `Invalid options: expected an options object such as { host: "127.0.0.1" }, but received ${describeValue(input)}.`
    );
  }

  for (const key of Object.keys(input)) {
    if (!SUPPORTED_OPTIONS.includes(key)) {
      throw new InvalidOptionsError(
        `Unknown option "${key}". isPortFree only supports the "host" option.`,
        { option: key }
      );
    }
  }

  const { host = null } = input;

  return { host: host === null ? null : assertHost(host) };
}

/**
 * Resolves to true when the port can be bound, false when something else is
 * already using it.
 *
 * Everything that is *not* "occupied" is surfaced as an error instead of a
 * misleading `false`, because callers react to `false` by moving on to the
 * next port. Being told "port 80 is busy" when the real problem is missing
 * privileges would send them scanning thousands of ports for no reason.
 *
 * Rejects (never throws synchronously) so callers only need `try/catch`
 * around an `await`. A rejection is the honest answer for every situation
 * where the question could not be answered - it is never reported as `true`.
 *
 * An omitted `host` means "every local interface": both wildcards and each
 * concrete local address are probed. `true` requires at least one successful
 * bind; if every probe was skipped for address-specific reasons, this rejects
 * with AvailabilityUnknownError (ERR_AVAILABILITY_UNKNOWN) instead of guessing.
 *
 * @param {number} port
 * @param {{ host?: string }} [options]
 * @returns {Promise<boolean>}
 */
async function isPortFree(port, options) {
  assertPort(port);
  const { host } = normalizeCheckOptions(options);

  return (await findObstacle(port, host)) === null;
}

module.exports = {
  isPortFree,
  findEphemeralPort,
  tryBind,
  localAddresses,
  // Shared so the server-binding module applies exactly the same policy to
  // bind failures instead of keeping a second copy of these error codes.
  classifyBindError: classifyProbeError,
};
