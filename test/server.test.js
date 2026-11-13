'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { findServer } = require('../lib/server');
const {
  PortFinderError,
  PermissionDeniedError,
  HostUnavailableError,
  NoAvailablePortError,
} = require('../lib/errors');

const LOOPBACK = '127.0.0.1';

// TEST-NET-3 (RFC 5737): reserved for documentation, never a local address.
const UNASSIGNED_ADDRESS = '203.0.113.1';

/** Binds a real server so tests use genuinely occupied ports. */
function listen(port = 0, host = LOOPBACK) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ port, host, exclusive: true }, () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Reserves `count` consecutive ports on loopback. Ports found by binding port
 * 0 are random, so a block is located by trying random starting points; this
 * keeps the tests independent of whatever a developer's machine happens to be
 * running.
 */
async function reserveBlock(count, host = LOOPBACK) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const base = 20000 + Math.floor(Math.random() * (30000 - count));
    const servers = [];

    try {
      for (let offset = 0; offset < count; offset += 1) {
        const { server } = await listen(base + offset, host);
        servers.push(server);
      }

      return { base, servers };
    } catch {
      await Promise.all(servers.map(close));
    }
  }

  throw new Error(`could not reserve ${count} consecutive ports`);
}

/** Runs `body` with `count` really-occupied consecutive ports. */
async function withOccupiedBlock(count, body) {
  const { base, servers } = await reserveBlock(count);

  try {
    await body(base, servers);
  } finally {
    // A test body may close one of the servers itself; closing twice throws.
    await Promise.all(servers.filter((server) => server.listening).map(close));
  }
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

/** Opening a TCP connection to `port` succeeds only for a listening server. */
function canConnect(port, host = LOOPBACK) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Number of live TCP server handles. Used to prove that a failed search does
 * not leave a listening socket behind. A failed bind releases its handle on
 * the next tick(s), so callers poll instead of reading this once.
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

test('binds an available port and returns a listening server', async () => {
  const { server: probe, port } = await listen();
  await close(probe);

  const { server, port: found } = await findServer({ start: port, end: port, host: LOOPBACK });

  try {
    assert.equal(server.listening, true, 'the returned server is not listening');
    assert.equal(server.address().port, found, 'the returned port is not the bound port');
    assert.equal(found, port, 'the requested free port was not used');
    assert.ok(server instanceof net.Server);

    // A real bound socket accepts connections; a checked-but-unbound port
    // would not.
    assert.equal(await canConnect(found), true, 'nothing is listening on the returned port');
  } finally {
    await close(server);
  }
});

test('the returned server keeps the port while the caller owns it', async () => {
  const { server, port } = await findServer({ host: LOOPBACK });

  try {
    // findServer keeps no reference and must not close the server later.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(server.listening, true, 'the library closed the server behind the caller');

    // A second bind on the same port therefore fails: the port is held by the
    // returned server rather than merely reported as free.
    await assert.rejects(listen(port, LOOPBACK), { code: 'EADDRINUSE' });
  } finally {
    await close(server);
  }
});

test('closing the returned server releases the port for the caller', async () => {
  const { server: probe, port } = await listen();
  await close(probe);

  const { server } = await findServer({ start: port, end: port, host: LOOPBACK });
  await close(server);

  const again = await listen(port, LOOPBACK);
  assert.equal(again.server.address().port, port);
  await close(again.server);
});

test('uses the preferred port when it is free', async () => {
  const { server: probe, port } = await listen();
  await close(probe);

  const { server, port: found } = await findServer(port);

  try {
    assert.equal(found, port);
    assert.equal(server.address().port, port);
    assert.equal(server.listening, true);
  } finally {
    await close(server);
  }
});

test('skips occupied ports inside a requested range', async () => {
  await withOccupiedBlock(2, async (base) => {
    const { server, port } = await findServer({ start: base, end: base + 5, host: LOOPBACK });

    try {
      assert.ok(port > base + 1 && port <= base + 5, `port ${port} is outside the range`);
      assert.equal(server.address().port, port);
      assert.equal(server.listening, true);
    } finally {
      await close(server);
    }
  });
});

test('a preferred port that is taken scans upward', async () => {
  await withOccupiedBlock(1, async (base) => {
    // An explicit host is what makes the bind conflict visible on every
    // platform: see the wildcard note in PROGRESS.md.
    const { server, port } = await findServer({ start: base, host: LOOPBACK });

    try {
      assert.ok(port > base, `expected a port above ${base}, got ${port}`);
      assert.equal(server.address().port, port);
      assert.equal(server.listening, true);
    } finally {
      await close(server);
    }
  });
});

test('honours exclude and host while binding', async () => {
  const { base, servers } = await reserveBlock(3);

  try {
    await Promise.all(servers.map(close)); // base, base + 1, base + 2 are free

    const { server, port } = await findServer({
      start: base,
      end: base + 2,
      host: LOOPBACK,
      exclude: [base, base + 1],
    });

    try {
      assert.equal(port, base + 2);
      assert.equal(server.address().address, LOOPBACK);
      assert.equal(server.listening, true);
    } finally {
      await close(server);
    }
  } finally {
    await Promise.all(servers.map((server) => (server.listening ? close(server) : null)));
  }
});

test('returns an operating-system chosen port on loopback when called without arguments', async () => {
  const { server, port } = await findServer();

  try {
    assert.equal(Number.isInteger(port), true);
    assert.ok(port >= 1 && port <= 65535, `unexpected port ${port}`);
    assert.equal(server.address().port, port);
    assert.equal(server.address().address, LOOPBACK, 'the default bind address is not loopback');
    assert.equal(server.listening, true);
  } finally {
    await close(server);
  }
});

test('the default host respects a listener that already holds 127.0.0.1', async () => {
  // With a wildcard default this would succeed on BSD/macOS even though the
  // port is taken on loopback. The safe default must see the conflict.
  await withOccupiedBlock(1, async (base) => {
    await assert.rejects(findServer({ start: base, end: base }), (error) => {
      assert.ok(error instanceof NoAvailablePortError);
      assert.equal(error.code, 'ERR_NO_PORT_FOUND');
      assert.equal(error.host, LOOPBACK);
      return true;
    });
  });
});

test('binds every interface only when the caller asks for it', async () => {
  const { base, servers } = await reserveBlock(1);
  await close(servers[0]);

  const { server, port } = await findServer({ start: base, end: base, host: '0.0.0.0' });

  try {
    assert.equal(server.address().address, '0.0.0.0');
    assert.equal(server.address().port, port);
    assert.equal(await canConnect(port, LOOPBACK), true);
  } finally {
    await close(server);
  }
});

test('binds an ephemeral port for an explicit host', async (t) => {
  const ipv4 = await findServer({ host: LOOPBACK });

  try {
    assert.equal(ipv4.server.address().address, LOOPBACK);
    assert.ok(ipv4.port > 0);
    assert.equal(ipv4.server.address().port, ipv4.port);
  } finally {
    await close(ipv4.server);
  }

  if (await canBind('::1')) {
    const ipv6 = await findServer({ host: '::1' });

    try {
      assert.equal(ipv6.server.address().address, '::1');
      assert.ok(ipv6.port > 0);
      assert.equal(ipv6.server.address().port, ipv6.port);
    } finally {
      await close(ipv6.server);
    }
  } else {
    t.skip('IPv6 is not available on this machine');
  }
});

test('throws when every port in the range is occupied, and stops at the range end', async () => {
  await withOccupiedBlock(3, async (base) => {
    await assert.rejects(
      findServer({ start: base, end: base + 2, host: LOOPBACK }),
      (error) => {
        assert.ok(error instanceof NoAvailablePortError);
        assert.ok(error instanceof PortFinderError);
        assert.equal(error.code, 'ERR_NO_PORT_FOUND');
        assert.deepEqual(error.range, { start: base, end: base + 2 });
        assert.equal(error.host, LOOPBACK);
        return true;
      }
    );

    // The next port is free: a search that leaked outside the requested range
    // would have returned it instead of throwing.
    const { server } = await listen(base + 3, LOOPBACK);
    await close(server);
  });
});

test('a privileged port is reported as a permission problem', async (t) => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  if (process.platform === 'win32' || isRoot) {
    t.skip('ports below 1024 are not restricted on Windows or for root');
    return;
  }

  await assert.rejects(findServer({ start: 80, end: 80, host: LOOPBACK }), (error) => {
    assert.ok(error instanceof PermissionDeniedError);
    assert.equal(error.code, 'ERR_PERMISSION_DENIED');
    assert.equal(error.port, 80);
    assert.match(error.message, /below 1024/);
    return true;
  });
});

test('host problems surface instead of being treated as "occupied"', async () => {
  await assert.rejects(findServer({ start: 3000, end: 3010, host: UNASSIGNED_ADDRESS }), (error) => {
    assert.ok(error instanceof HostUnavailableError);
    assert.equal(error.code, 'ERR_HOST_UNAVAILABLE');
    assert.equal(error.host, UNASSIGNED_ADDRESS);
    return true;
  });

  // The .invalid TLD can never resolve (RFC 2606).
  await assert.rejects(
    findServer({ start: 3000, end: 3010, host: 'port-finder-does-not-exist.invalid' }),
    { code: 'ERR_HOST_UNAVAILABLE' }
  );
});

test('resource and unknown errors surface instead of looking "occupied"', async (t) => {
  // A search must never read EMFILE (or an unknown code) as "the port is
  // taken": that would send the caller scanning ports for no reason.
  t.mock.method(net, 'createServer', () =>
    failingServer(Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }))
  );
  t.after(() => t.mock.restoreAll());

  await assert.rejects(findServer({ start: 3000, end: 3010, host: LOOPBACK }), { code: 'EMFILE' });
  await assert.rejects(findServer({ host: LOOPBACK }), { code: 'EMFILE' });
});

test('concurrent calls with distinct single-port ranges return distinct ports', async () => {
  const { base, servers } = await reserveBlock(4);

  try {
    await Promise.all(servers.map(close));

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        findServer({ start: base + index, end: base + index, host: LOOPBACK })
      )
    );

    try {
      assert.deepEqual(results.map(({ port }) => port), [base, base + 1, base + 2, base + 3]);

      for (const { server, port } of results) {
        assert.equal(server.listening, true);
        assert.equal(server.address().port, port);
      }

      // All four sockets are held at the same time, so the ports really are
      // distinct rather than reused one after another.
      assert.equal(new Set(results.map(({ port }) => port)).size, results.length);
    } finally {
      await Promise.all(results.map(({ server }) => close(server)));
    }
  } finally {
    await Promise.all(servers.map((server) => (server.listening ? close(server) : null)));
  }
});

test('concurrent calls for the same single port give exactly one server', async () => {
  const { base, servers } = await reserveBlock(1);
  await close(servers[0]);

  const outcome = await Promise.allSettled([
    findServer({ start: base, end: base, host: LOOPBACK }),
    findServer({ start: base, end: base, host: LOOPBACK }),
  ]);

  const winners = outcome.filter((result) => result.status === 'fulfilled');
  const losers = outcome.filter((result) => result.status === 'rejected');

  assert.equal(winners.length, 1, 'more than one caller was told it owns the port');
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason.code, 'ERR_NO_PORT_FOUND');
  assert.equal(winners[0].value.port, base);

  await close(winners[0].value.server);
});

test('a failed search leaves no listening servers or listeners behind', async (t) => {
  const before = tcpServerCount();

  const { base, servers: occupants } = await reserveBlock(2);
  await close(occupants[1]); // base + 1 is free but will be excluded

  // Record every server findServer creates so their listeners can be checked.
  const created = [];
  const realCreateServer = net.createServer;
  t.mock.method(net, 'createServer', (...args) => {
    const server = realCreateServer.apply(net, args);
    created.push(server);
    return server;
  });
  t.after(() => t.mock.restoreAll());

  try {
    // base is occupied and base + 1 is excluded: the search must fail, having
    // created one probe server that it throws away.
    await assert.rejects(
      findServer({ start: base, end: base + 1, host: LOOPBACK, exclude: [base + 1] }),
      { code: 'ERR_NO_PORT_FOUND' }
    );

    assert.ok(created.length > 0, 'findServer did not create a probe server');

    for (const probe of created) {
      assert.equal(probe.listening, false, 'a failed search left a server listening');
      assert.equal(probe.listenerCount('listening'), 0, 'a "listening" listener leaked');
      assert.equal(probe.listenerCount('error'), 0, 'an "error" listener leaked');
    }

    if (before !== null) {
      assert.ok(
        await waitUntil(() => tcpServerCount() <= before + 1),
        `expected at most ${before + 1} TCP servers, found ${tcpServerCount()}`
      );
    }
  } finally {
    await close(occupants[0]);
  }
});

test('rejects invalid options through the shared validation', async () => {
  await assert.rejects(findServer({ start: 3010, end: 3000, host: LOOPBACK }), {
    code: 'ERR_INVALID_RANGE',
  });
  await assert.rejects(findServer({ start: 0 }), { code: 'ERR_INVALID_PORT' });
  await assert.rejects(findServer('3000'), { code: 'ERR_INVALID_OPTIONS' });
  await assert.rejects(findServer({ prot: 3000 }), {
    code: 'ERR_INVALID_OPTIONS',
    option: 'prot',
  });
});
