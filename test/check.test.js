'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { isPortFree, tryBind } = require('../lib/check');
const {
  PortFinderError,
  PermissionDeniedError,
  HostUnavailableError,
  AvailabilityUnknownError,
} = require('../lib/errors');

const LOOPBACK = '127.0.0.1';

// TEST-NET-3 (RFC 5737) is reserved for documentation. No machine has it on a
// real interface, so binding it must fail with EADDRNOTAVAIL.
const UNASSIGNED_ADDRESS = '203.0.113.1';

/** Binds a real server so tests use genuinely occupied ports. */
function listen(port = 0, host = LOOPBACK) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port, host }, () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Runs the test body while a second server holds a real port. */
async function withOccupiedPort(run) {
  const { server, port } = await listen();
  try {
    await run(port);
  } finally {
    await close(server);
  }
}

/** Runs the test body with a port that was really free a moment ago. */
async function withFreePort(run) {
  const { server, port } = await listen();
  await close(server);
  await run(port);
}

/** True when this machine can actually listen on `host`. */
async function canBind(host) {
  try {
    const { server } = await listen(0, host);
    await close(server);
    return true;
  } catch {
    return false;
  }
}

/**
 * Number of live TCP server handles. Used to prove that a probe does not
 * leave anything behind. The handle is released when close() finishes but
 * the wrapper can survive until the next tick, so callers wait for a while.
 */
function tcpServerCount() {
  if (typeof process.getActiveResourcesInfo !== 'function') return null;
  return process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap').length;
}

/** Waits until `predicate` is true, or gives up after `timeout` milliseconds. */
async function waitUntil(predicate, timeout = 1000) {
  const deadline = Date.now() + timeout;

  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return true;
}

test('isPortFree resolves true for a port nobody is using', async () => {
  await withFreePort(async (port) => {
    assert.equal(await isPortFree(port), true);
  });
});

test('isPortFree resolves false for a port that is already listening', async () => {
  await withOccupiedPort(async (port) => {
    assert.equal(await isPortFree(port), false);
    assert.equal(await isPortFree(port, { host: LOOPBACK }), false);
  });
});

test('checking a port leaves it free for the caller to bind', async () => {
  await withFreePort(async (port) => {
    // This is the bug the test exists to catch: if tryBind forgot to close its
    // server, the check would leak the port and this next bind would fail.
    assert.equal(await isPortFree(port), true);

    const { server } = await listen(port);
    assert.equal(server.address().port, port);
    await close(server);

    // ...and after the caller closes, the port is available again.
    assert.equal(await isPortFree(port), true);
  });
});

test('the default host notices a loopback-only listener', async () => {
  await withOccupiedPort(async (port) => {
    // The listener is on 127.0.0.1 only. A server bound to every interface
    // would not be able to reach the port, so the answer must be false.
    assert.equal(await isPortFree(port), false);
  });
});

test('the default host notices a listener bound to every IPv4 interface', async (t) => {
  if (!(await canBind('0.0.0.0'))) {
    t.skip('this machine cannot bind the IPv4 wildcard address');
    return;
  }

  const { server, port } = await listen(0, '0.0.0.0');
  try {
    // This is the macOS/BSD trap: there, binding 127.0.0.1 succeeds even
    // while 0.0.0.0 is held, so only a wildcard probe can see this listener.
    assert.equal(await isPortFree(port), false);
    assert.equal(await isPortFree(port, { host: '0.0.0.0' }), false);
  } finally {
    await close(server);
  }
});

test('an explicit host is checked on its own address', async () => {
  await withOccupiedPort(async (port) => {
    // The listener and the check use the same address, which every supported
    // platform reports as EADDRINUSE. Cross-address visibility (a wildcard
    // listener seen from a loopback check) differs per platform and is not
    // asserted here on purpose: see the note in lib/check.js.
    assert.equal(await isPortFree(port, { host: LOOPBACK }), false);
  });
});

test('a listener on every IPv6 interface is noticed by the default host', async (t) => {
  if (!(await canBind('::'))) {
    t.skip('IPv6 is not available on this machine');
    return;
  }

  const { server, port } = await listen(0, '::');
  try {
    assert.equal(await isPortFree(port), false);
    assert.equal(await isPortFree(port, { host: '::' }), false);
  } finally {
    await close(server);
  }
});

test('an IPv6 loopback-only listener is noticed by the default host', async (t) => {
  if (!(await canBind('::1'))) {
    t.skip('IPv6 is not available on this machine');
    return;
  }

  const { server, port } = await listen(0, '::1');
  try {
    assert.equal(await isPortFree(port), false);
    assert.equal(await isPortFree(port, { host: '::1' }), false);
  } finally {
    await close(server);
  }
});

test('a free port stays free for IPv4 and IPv6 checks alike', async (t) => {
  if (!(await canBind('::1'))) {
    t.skip('IPv6 is not available on this machine');
    return;
  }

  await withFreePort(async (port) => {
    assert.equal(await isPortFree(port), true);
    assert.equal(await isPortFree(port, { host: LOOPBACK }), true);
    assert.equal(await isPortFree(port, { host: '::1' }), true);
  });
});

test('isPortFree validates the port number', async () => {
  for (const port of [0, -1, 65536, 3000.5, '3000', null, undefined]) {
    await assert.rejects(isPortFree(port), { code: 'ERR_INVALID_PORT' });
  }
});

test('isPortFree validates the options object', async () => {
  await assert.rejects(isPortFree(3000, LOOPBACK), { code: 'ERR_INVALID_OPTIONS' });
  await assert.rejects(isPortFree(3000, { start: 3000 }), {
    code: 'ERR_INVALID_OPTIONS',
    option: 'start',
  });
  await assert.rejects(isPortFree(3000, { host: ' 127.0.0.1 ' }), {
    code: 'ERR_INVALID_OPTIONS',
    option: 'host',
  });
  await assert.rejects(isPortFree(3000, new Date()), { code: 'ERR_INVALID_OPTIONS' });
});

test('isPortFree rejects rather than throwing synchronously', async () => {
  // Callers should only ever need try/catch around an await.
  const result = isPortFree('not-a-port');
  assert.ok(result instanceof Promise);
  await assert.rejects(result, { code: 'ERR_INVALID_PORT' });
});

test('an unassigned address is reported as a host problem, not "occupied"', async () => {
  await withFreePort(async (port) => {
    await assert.rejects(isPortFree(port, { host: UNASSIGNED_ADDRESS }), (error) => {
      assert.ok(error instanceof HostUnavailableError);
      assert.ok(error instanceof PortFinderError);
      assert.equal(error.code, 'ERR_HOST_UNAVAILABLE');
      assert.equal(error.host, UNASSIGNED_ADDRESS);
      assert.equal(error.port, port);
      assert.ok(error.cause, 'the original Node.js error is kept as the cause');
      return true;
    });
  });
});

test('an unresolvable hostname is reported as a host problem', async () => {
  // The .invalid TLD can never resolve (RFC 2606).
  await assert.rejects(isPortFree(3000, { host: 'port-finder-does-not-exist.invalid' }), {
    code: 'ERR_HOST_UNAVAILABLE',
  });
});

test('a privileged port is reported as a permission problem, not "occupied"', async (t) => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  if (process.platform === 'win32' || isRoot) {
    t.skip('ports below 1024 are not restricted on Windows or for root');
    return;
  }

  await assert.rejects(isPortFree(80), (error) => {
    assert.ok(error instanceof PermissionDeniedError);
    assert.ok(error instanceof PortFinderError);
    assert.equal(error.code, 'ERR_PERMISSION_DENIED');
    assert.equal(error.port, 80);
    assert.match(error.message, /below 1024/);
    assert.ok(error.cause);
    return true;
  });
});

test('tryBind rejects with the original error when the port is occupied', async () => {
  await withOccupiedPort(async (port) => {
    await assert.rejects(tryBind(port, LOOPBACK), (error) => {
      assert.equal(error.code, 'EADDRINUSE');
      return true;
    });
  });
});

test('tryBind releases the port straight after a successful probe', async (t) => {
  const hosts = ['0.0.0.0', LOOPBACK];
  if (await canBind('::1')) hosts.push('::1');
  else t.diagnostic('IPv6 is not available on this machine; skipped ::1');

  // Let the OS assign the port. Re-binding a port returned by withFreePort()
  // races every other process on the machine: another process may legitimately
  // take it between close() and listen(), which says nothing about tryBind.
  // Inspect the probe server directly instead; a server that forgot to close
  // is still listening and still has a bound address.
  const servers = captureServers(t);

  for (const host of hosts) {
    const before = servers.length;
    const address = await tryBind(0, host);
    const probe = servers[before];

    assert.ok(address.port > 0, `tryBind did not return a port for ${host}`);
    assert.ok(probe, `tryBind did not create a server for ${host}`);
    assert.equal(probe.listening, false, `the probe server is still listening on ${host}`);
    assert.equal(probe.address(), null, `the probe server is still bound on ${host}`);
    assert.equal(probe.listenerCount('listening'), 0);
    assert.equal(probe.listenerCount('error'), 0);
  }
});

/**
 * Records every real net.Server that tryBind creates, so a test can inspect
 * the listeners that were attached to it.
 */
function captureServers(t) {
  const servers = [];
  const realCreateServer = net.createServer;

  t.mock.method(net, 'createServer', (...args) => {
    const server = realCreateServer.apply(net, args);
    servers.push(server);
    return server;
  });

  t.after(() => t.mock.restoreAll());

  return servers;
}

test('tryBind removes its listeners after a successful probe', async (t) => {
  const servers = captureServers(t);

  await withFreePort(async (port) => {
    await tryBind(port, LOOPBACK);
  });

  // The last server created is the one tryBind used; earlier ones belong to
  // the test's own listen() helper.
  const probe = servers.at(-1);
  assert.ok(probe, 'tryBind did not create a server');
  assert.equal(probe.listening, false, 'the probe server is still listening');
  assert.equal(probe.listenerCount('listening'), 0);
  assert.equal(probe.listenerCount('error'), 0);
});

test('tryBind removes its listeners when the bind fails', async (t) => {
  const servers = captureServers(t);

  await withOccupiedPort(async (port) => {
    await assert.rejects(tryBind(port, LOOPBACK), { code: 'EADDRINUSE' });
  });

  const probe = servers.at(-1);
  assert.ok(probe, 'tryBind did not create a server');
  assert.equal(probe.listening, false);
  assert.equal(probe.listenerCount('listening'), 0);
  assert.equal(probe.listenerCount('error'), 0);
});

test('checking a port leaves no TCP servers behind', async (t) => {
  if (tcpServerCount() === null) {
    t.skip('process.getActiveResourcesInfo is not available in this Node.js version');
    return;
  }

  const before = tcpServerCount();

  await withFreePort(async (port) => {
    assert.equal(await isPortFree(port), true);
  });

  assert.ok(
    await waitUntil(() => tcpServerCount() <= before),
    `expected ${before} TCP servers after the check, found ${tcpServerCount()}`
  );
});

test('resource exhaustion is reported, never mistaken for a free port', async (t) => {
  const realCreateServer = net.createServer;

  // Simulate the kernel refusing a new socket. A real EMFILE is hard to force
  // in a test, and faking the failure is precise about the code path.
  t.mock.method(net, 'createServer', () =>
    failingServer(Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }))
  );
  t.after(() => t.mock.restoreAll());

  await assert.rejects(isPortFree(3000), { code: 'EMFILE' });
  await assert.rejects(isPortFree(3000, { host: LOOPBACK }), { code: 'EMFILE' });

  t.mock.restoreAll();
  assert.equal(net.createServer, realCreateServer);
});

test('an unknown networking error is reported, never mistaken for a free port', async (t) => {
  t.mock.method(net, 'createServer', () =>
    failingServer(Object.assign(new Error('socket exploded'), { code: 'ESOMETHINGNEW' }))
  );
  t.after(() => t.mock.restoreAll());

  await assert.rejects(isPortFree(3000), { code: 'ESOMETHINGNEW' });
  await assert.rejects(isPortFree(3000, { host: LOOPBACK }), { code: 'ESOMETHINGNEW' });
});

test('some successful probes keep the port free when other addresses are skipped', async (t) => {
  // Every local address can fail in ways that say nothing about the port
  // (an IPv6 link-local address without a zone, an interface that is down).
  // Those are skipped; one real successful bind is still proof the port is
  // available.
  mockProbes(t, ['ok', Object.assign(new Error('cannot assign requested address'), { code: 'EADDRNOTAVAIL' })]);

  assert.equal(await isPortFree(3000), true);
});

test('availability is unknown when every probe is skipped', async (t) => {
  // Nothing was ever bound, so "free" would be a false positive. The call has
  // to reject with a structured error instead.
  mockProbes(t, [Object.assign(new Error('cannot assign requested address'), { code: 'EADDRNOTAVAIL' })]);

  await assert.rejects(isPortFree(3000), (error) => {
    assert.ok(error instanceof AvailabilityUnknownError);
    assert.ok(error instanceof PortFinderError);
    assert.equal(error.code, 'ERR_AVAILABILITY_UNKNOWN');
    assert.equal(error.port, 3000);
    assert.ok(error.cause, 'the skipped probe error should be kept as the cause');
    return true;
  });
});

/**
 * Replaces net.createServer with probes that follow `outcomes` in order; the
 * last outcome repeats. Each entry is either "ok" or the error to fail with.
 */
function mockProbes(t, outcomes) {
  let index = 0;

  t.mock.method(net, 'createServer', () => {
    const outcome = outcomes[Math.min(index, outcomes.length - 1)];
    index += 1;
    return probeServer(outcome);
  });
  t.after(() => t.mock.restoreAll());
}

/** A stand-in for net.Server that "binds" or fails with one outcome. */
function probeServer(outcome) {
  const handlers = new Map();

  return {
    once(event, handler) {
      handlers.set(event, handler);
      return this;
    },
    removeListener(event, handler) {
      if (handlers.get(event) === handler) handlers.delete(event);
      return this;
    },
    listen() {
      queueMicrotask(() => {
        if (outcome === 'ok') {
          const onListening = handlers.get('listening');
          if (onListening) onListening();
        } else {
          const onError = handlers.get('error');
          if (onError) onError(outcome);
        }
      });
      return this;
    },
    address() {
      return { address: '127.0.0.1', family: 'IPv4', port: 3000 };
    },
    close(callback) {
      if (callback) queueMicrotask(callback);
      return this;
    },
  };
}

/** A stand-in for net.Server that fails every bind with `error`. */
function failingServer(error) {
  const handlers = new Map();

  return {
    once(event, handler) {
      handlers.set(event, handler);
      return this;
    },
    removeListener(event, handler) {
      if (handlers.get(event) === handler) handlers.delete(event);
      return this;
    },
    listen() {
      queueMicrotask(() => {
        const onError = handlers.get('error');
        if (onError) onError(error);
      });
      return this;
    },
    close(callback) {
      if (callback) queueMicrotask(callback);
      return this;
    },
  };
}

test('several different ports can be checked in parallel', async () => {
  const ports = [];

  for (let index = 0; index < 3; index += 1) {
    const { server, port } = await listen();
    await close(server);
    ports.push(port);
  }

  const results = await Promise.all(ports.map((port) => isPortFree(port)));

  assert.deepEqual(results, [true, true, true]);
});
