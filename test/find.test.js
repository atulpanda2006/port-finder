'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { findPort } = require('../lib/find');
const { isPortFree } = require('../lib/check');
const {
  PortFinderError,
  NoAvailablePortError,
  InvalidOptionsError,
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

test('returns the preferred port when it is free', async () => {
  const { server, port } = await listen();
  await close(server);

  assert.equal(await findPort(port), port);
  assert.equal(await findPort({ start: port, end: port, host: LOOPBACK }), port);
});

test('finds the next free port when the preferred port is occupied', async () => {
  await withOccupiedBlock(1, async (base) => {
    const port = await findPort({ start: base, end: base + 20, host: LOOPBACK });

    assert.notEqual(port, base, 'returned the occupied port');
    assert.ok(port > base && port <= base + 20, `port ${port} is outside the range`);
    assert.equal(await isPortFree(port, { host: LOOPBACK }), true);
  });
});

test('finds a free port inside a requested range', async () => {
  await withOccupiedBlock(2, async (base) => {
    const port = await findPort({ start: base, end: base + 10, host: LOOPBACK });

    assert.ok(port > base + 1 && port <= base + 10, `port ${port} is outside the range`);
  });
});

test('never returns an excluded port', async () => {
  // The occupied port and the excluded port are the only candidates, so a
  // search that ignored "exclude" would return the (free) excluded port.
  await withOccupiedBlock(2, async (base, servers) => {
    await close(servers[1]); // base + 1 is free again, but will be excluded

    await assert.rejects(
      findPort({ start: base, end: base + 1, host: LOOPBACK, exclude: [base + 1] }),
      { code: 'ERR_NO_PORT_FOUND' }
    );
  });
});

test('skips excluded ports while still returning a later one', async () => {
  const { base, servers } = await reserveBlock(3);

  try {
    await Promise.all(servers.map(close)); // base, base + 1, base + 2 are free

    const port = await findPort({
      start: base,
      end: base + 2,
      host: LOOPBACK,
      exclude: [base, base + 1],
    });

    assert.equal(port, base + 2);
  } finally {
    await Promise.all(servers.map((server) => (server.listening ? close(server) : null)));
  }
});

test('throws when every port in the range is occupied, and stops at the range end', async () => {
  await withOccupiedBlock(3, async (base) => {
    await assert.rejects(
      findPort({ start: base, end: base + 2, host: LOOPBACK }),
      (error) => {
        assert.ok(error instanceof NoAvailablePortError);
        assert.ok(error instanceof PortFinderError);
        assert.equal(error.code, 'ERR_NO_PORT_FOUND');
        assert.deepEqual(error.range, { start: base, end: base + 2 });
        assert.equal(error.host, LOOPBACK);
        return true;
      }
    );

    // The port just past the range is free: a search that leaked outside the
    // requested range would have returned it instead of throwing.
    const { server } = await listen(base + 3, LOOPBACK);
    await close(server);
  });
});

test('handles a single-port range', async () => {
  const { server, port } = await listen();
  await close(server);

  assert.equal(await findPort({ start: port, end: port, host: LOOPBACK }), port);

  await withOccupiedBlock(1, async (base) => {
    await assert.rejects(findPort({ start: base, end: base, host: LOOPBACK }), {
      code: 'ERR_NO_PORT_FOUND',
    });
  });
});

test('rejects a range whose every port is excluded', async () => {
  await assert.rejects(findPort({ start: 3000, end: 3002, exclude: [3000, 3001, 3002] }), (error) => {
    assert.ok(error instanceof InvalidOptionsError);
    assert.equal(error.code, 'ERR_INVALID_OPTIONS');
    assert.equal(error.option, 'exclude');
    return true;
  });

  await assert.rejects(findPort({ start: 3000, end: 3000, exclude: [3000] }), {
    code: 'ERR_INVALID_OPTIONS',
    option: 'exclude',
  });
});

test('rejects invalid and reversed ranges through the shared validation', async () => {
  await assert.rejects(findPort({ start: 3010, end: 3000 }), { code: 'ERR_INVALID_RANGE' });
  await assert.rejects(findPort({ start: 0 }), { code: 'ERR_INVALID_PORT' });
  await assert.rejects(findPort({ start: 3000, end: 70000 }), { code: 'ERR_INVALID_PORT' });
  await assert.rejects(findPort('3000'), { code: 'ERR_INVALID_OPTIONS' });
  await assert.rejects(findPort({ prot: 3000 }), { code: 'ERR_INVALID_OPTIONS', option: 'prot' });
  await assert.rejects(findPort({ end: 3010 }), { code: 'ERR_INVALID_OPTIONS', option: 'end' });
});

test('does not swallow host problems while searching', async () => {
  // A host error means the search can never succeed; it must surface instead
  // of being treated as "this port is busy, try the next one".
  await assert.rejects(findPort({ start: 3000, end: 3010, host: UNASSIGNED_ADDRESS }), {
    code: 'ERR_HOST_UNAVAILABLE',
  });
});

test('returns an operating-system chosen port when called without arguments', async () => {
  const port = await findPort();

  assert.equal(Number.isInteger(port), true);
  assert.ok(port >= 1 && port <= 65535, `unexpected port ${port}`);
});

test('returns an operating-system chosen port for an explicit host', async (t) => {
  assert.equal(await findPort({ host: LOOPBACK }) > 0, true);

  if (await canBind('::1')) {
    assert.equal(await findPort({ host: '::1' }) > 0, true);
  } else {
    t.skip('IPv6 is not available on this machine');
  }
});

test('concurrent ephemeral searches return distinct valid ports', async () => {
  const ports = await Promise.all(Array.from({ length: 10 }, () => findPort()));

  for (const port of ports) {
    assert.equal(Number.isInteger(port), true);
    assert.ok(port >= 1 && port <= 65535, `unexpected port ${port}`);
  }

  assert.equal(new Set(ports).size, ports.length, `duplicate ports: ${ports.join(', ')}`);
});

test('concurrent range searches stay inside their own ranges', async () => {
  const { base, servers } = await reserveBlock(4);

  try {
    await Promise.all(servers.map(close));

    const ranges = Array.from({ length: 4 }, (_, index) => ({
      start: base + index,
      end: base + index,
    }));

    const ports = await Promise.all(ranges.map((range) => findPort({ ...range, host: LOOPBACK })));

    assert.deepEqual(ports, ranges.map((range) => range.start));
  } finally {
    await Promise.all(servers.map((server) => (server.listening ? close(server) : null)));
  }
});
