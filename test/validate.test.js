'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MIN_PORT,
  MAX_PORT,
  assertPort,
  assertRange,
  assertHost,
  normalizeExclude,
  normalizeOptions,
} = require('../lib/validate');

const { InvalidPortError, InvalidRangeError, InvalidOptionsError } = require('../lib/errors');

test('assertPort accepts every port that can be bound', () => {
  assert.equal(assertPort(MIN_PORT), 1);
  assert.equal(assertPort(3000), 3000);
  assert.equal(assertPort(1024), 1024);
  assert.equal(assertPort(MAX_PORT), 65535);
});

test('assertPort rejects out-of-range numbers', () => {
  for (const value of [0, -1, -3000, 65536, 100000]) {
    assert.throws(() => assertPort(value), {
      name: 'InvalidPortError',
      code: 'ERR_INVALID_PORT',
    });
  }
});

test('assertPort rejects values that are not whole numbers', () => {
  for (const value of [3000.5, NaN, Infinity, -Infinity]) {
    assert.throws(() => assertPort(value), { code: 'ERR_INVALID_PORT' });
  }
});

test('assertPort rejects non-numbers, including numeric strings', () => {
  for (const value of ['3000', ' 3000 ', true, null, undefined, {}, [], () => 3000]) {
    assert.throws(() => assertPort(value), { code: 'ERR_INVALID_PORT' });
  }
});

test('assertPort explains a wrong type instead of only rejecting it', () => {
  assert.throws(() => assertPort('3000'), /Expected a number, received "3000"/);
});

test('assertRange accepts valid ranges, including a single-port range', () => {
  assert.deepEqual(assertRange(3000, 3010), { start: 3000, end: 3010 });
  assert.deepEqual(assertRange(3000, 3000), { start: 3000, end: 3000 });
});

test('assertRange rejects a range that ends before it starts', () => {
  assert.throws(() => assertRange(3010, 3000), {
    name: 'InvalidRangeError',
    code: 'ERR_INVALID_RANGE',
  });
});

test('assertRange validates both ends as ports', () => {
  assert.throws(() => assertRange(0, 10), { code: 'ERR_INVALID_PORT' });
  assert.throws(() => assertRange(3000, 70000), { code: 'ERR_INVALID_PORT' });
});

test('assertHost accepts the usual IPv4, IPv6 and hostname forms', () => {
  for (const host of ['127.0.0.1', '0.0.0.0', '::1', '::', 'localhost', 'example.test']) {
    assert.equal(assertHost(host), host);
  }
});

test('assertHost rejects empty, blank and non-string values', () => {
  for (const value of ['', '   ', 123, null, undefined, {}]) {
    assert.throws(() => assertHost(value), {
      name: 'InvalidOptionsError',
      code: 'ERR_INVALID_OPTIONS',
      option: 'host',
    });
  }
});

test('normalizeExclude turns arrays, Sets and generators into a Set of ports', () => {
  assert.deepEqual([...normalizeExclude([3001, 3002])], [3001, 3002]);
  assert.deepEqual([...normalizeExclude(new Set([3001]))], [3001]);

  function* generator() {
    yield 3003;
  }
  assert.deepEqual([...normalizeExclude(generator())], [3003]);
});

test('normalizeExclude treats missing values as "nothing excluded"', () => {
  assert.equal(normalizeExclude(undefined).size, 0);
  assert.equal(normalizeExclude(null).size, 0);
});

test('normalizeExclude rejects strings and non-iterables', () => {
  for (const value of ['3001', 3001, {}]) {
    assert.throws(() => normalizeExclude(value), {
      code: 'ERR_INVALID_OPTIONS',
      option: 'exclude',
    });
  }
});

test('normalizeExclude rejects entries that are not valid ports', () => {
  assert.throws(() => normalizeExclude([0]), { code: 'ERR_INVALID_OPTIONS' });
  assert.throws(() => normalizeExclude([3000, '3001']), { code: 'ERR_INVALID_OPTIONS' });
});

test('normalizeExclude reports the bad entry and keeps the original error as the cause', () => {
  assert.throws(
    () => normalizeExclude([3001, 0]),
    (error) => {
      assert.equal(error.code, 'ERR_INVALID_OPTIONS');
      assert.equal(error.option, 'exclude');
      assert.ok(error.cause instanceof InvalidPortError);
      assert.match(error.message, /Invalid "exclude" entry 0/);
      return true;
    }
  );
});

test('normalizeOptions with no argument means "let the OS choose"', () => {
  const options = normalizeOptions();

  assert.equal(options.start, null);
  assert.equal(options.end, null);
  assert.equal(options.host, null);
  assert.equal(options.exclude.size, 0);
});

test('normalizeOptions treats null the same as no argument', () => {
  assert.deepEqual(normalizeOptions(null), normalizeOptions());
});

test('normalizeOptions accepts a bare port number and scans up to 65535', () => {
  const options = normalizeOptions(3000);

  assert.equal(options.start, 3000);
  assert.equal(options.end, MAX_PORT);
  assert.equal(options.host, null);
});

test('normalizeOptions validates the bare port number', () => {
  assert.throws(() => normalizeOptions(0), { code: 'ERR_INVALID_PORT' });
  assert.throws(() => normalizeOptions('3000'), { code: 'ERR_INVALID_OPTIONS' });
});

test('normalizeOptions defaults end to 65535 when only start is given', () => {
  const options = normalizeOptions({ start: 3000 });

  assert.equal(options.start, 3000);
  assert.equal(options.end, MAX_PORT);
});

test('normalizeOptions keeps an explicit range exactly as requested', () => {
  const options = normalizeOptions({ start: 3000, end: 3010 });

  assert.equal(options.start, 3000);
  assert.equal(options.end, 3010);
});

test('normalizeOptions allows the OS to choose when only host is given', () => {
  const options = normalizeOptions({ host: '127.0.0.1' });

  assert.equal(options.start, null);
  assert.equal(options.end, null);
  assert.equal(options.host, '127.0.0.1');
});

test('normalizeOptions parses every option together', () => {
  const options = normalizeOptions({
    start: 3000,
    end: 3010,
    host: '::1',
    exclude: [3001, 3002],
  });

  assert.equal(options.start, 3000);
  assert.equal(options.end, 3010);
  assert.equal(options.host, '::1');
  assert.deepEqual([...options.exclude], [3001, 3002]);
});

test('normalizeOptions rejects a range that ends before it starts', () => {
  assert.throws(() => normalizeOptions({ start: 3010, end: 3000 }), {
    code: 'ERR_INVALID_RANGE',
  });
});

test('normalizeOptions rejects "end" without "start"', () => {
  assert.throws(() => normalizeOptions({ end: 3010 }), {
    code: 'ERR_INVALID_OPTIONS',
    option: 'end',
  });
});

test('normalizeOptions rejects unknown option keys so typos fail loudly', () => {
  assert.throws(() => normalizeOptions({ prot: 3000 }), (error) => {
    assert.equal(error.code, 'ERR_INVALID_OPTIONS');
    assert.equal(error.option, 'prot');
    assert.match(error.message, /Unknown option "prot"/);
    return true;
  });
});

test('normalizeOptions rejects arrays and other non-object input', () => {
  assert.throws(() => normalizeOptions([3000, 3010]), { code: 'ERR_INVALID_OPTIONS' });
  assert.throws(() => normalizeOptions('3000'), { code: 'ERR_INVALID_OPTIONS' });
  assert.throws(() => normalizeOptions(true), { code: 'ERR_INVALID_OPTIONS' });
});

test('normalizeOptions returns a fresh exclude Set on every call', () => {
  const first = normalizeOptions();
  const second = normalizeOptions();

  first.exclude.add(3000);

  assert.equal(first.exclude.size, 1);
  assert.equal(second.exclude.size, 0);
});

test('every validation error is catchable as a single type', () => {
  for (const input of [0, 'x', { start: 3010, end: 3000 }, { nope: 1 }]) {
    assert.throws(
      () => (typeof input === 'object' ? normalizeOptions(input) : assertPort(input)),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(typeof error.code, 'string');
        return true;
      }
    );
  }
});

test('InvalidRangeError from a reversed range keeps both values', () => {
  assert.throws(
    () => normalizeOptions({ start: 3010, end: 3000 }),
    (error) => {
      assert.ok(error instanceof InvalidRangeError);
      assert.deepEqual(error.range, { start: 3010, end: 3000 });
      return true;
    }
  );
});

test('normalizeOptions rejects a numeric string in "start"', () => {
  // A value read from process.env or a query string arrives as a string.
  // Failing loudly beats silently binding a different port.
  assert.throws(() => normalizeOptions({ start: '3000' }), {
    code: 'ERR_INVALID_PORT',
    value: '3000',
  });
});

test('normalizeOptions rejects an out-of-range "end"', () => {
  assert.throws(() => normalizeOptions({ start: 3000, end: 70000 }), {
    code: 'ERR_INVALID_PORT',
    port: 70000,
  });
});

test('assertHost rejects hosts with leading or trailing whitespace', () => {
  for (const value of [' 127.0.0.1 ', 'localhost\n', '\t127.0.0.1']) {
    assert.throws(() => assertHost(value), (error) => {
      assert.equal(error.code, 'ERR_INVALID_OPTIONS');
      assert.equal(error.option, 'host');
      assert.match(error.message, /whitespace/);
      return true;
    });
  }

  // The message suggests the corrected value, so the fix is obvious.
  assert.throws(() => assertHost(' 127.0.0.1 '), /did you mean "127\.0\.0\.1"\?/);
  assert.throws(() => normalizeOptions({ host: ' localhost ' }), {
    code: 'ERR_INVALID_OPTIONS',
    option: 'host',
  });
});

test('normalizeOptions rejects non-plain objects such as Date and Map', () => {
  assert.throws(() => normalizeOptions(new Date()), /received a Date instance/);
  assert.throws(() => normalizeOptions(new Map()), /received a Map instance/);

  for (const value of [new Date(), new Map(), Object.create({ start: 3000 })]) {
    assert.throws(() => normalizeOptions(value), { code: 'ERR_INVALID_OPTIONS' });
  }
});

test('normalizeOptions rejects an exclude list that covers the whole range', () => {
  assert.throws(
    () => normalizeOptions({ start: 3000, end: 3000, exclude: [3000] }),
    (error) => {
      assert.equal(error.code, 'ERR_INVALID_OPTIONS');
      assert.equal(error.option, 'exclude');
      assert.match(error.message, /every port in the range 3000-3000/);
      return true;
    }
  );

  assert.throws(
    () => normalizeOptions({ start: 3000, end: 3002, exclude: [3002, 3000, 3001] }),
    { code: 'ERR_INVALID_OPTIONS', option: 'exclude' }
  );

  // Excluding all but one port is still a usable request, and ports outside
  // the range must not count towards covering it.
  const options = normalizeOptions({ start: 3000, end: 3002, exclude: [3000, 3001, 9999] });
  assert.equal(options.exclude.size, 3);
});

test('normalizeOptions explains array and object input clearly', () => {
  assert.throws(
    () => normalizeOptions([3000, 3010]),
    (error) => {
      assert.match(error.message, /but received an array/);
      assert.doesNotMatch(error.message, /Invalid options an array/);
      return true;
    }
  );

  assert.throws(() => normalizeOptions(new Date()), (error) => {
    assert.match(error.message, /expected a port number or an options object/);
    assert.match(error.message, /but received a Date instance/);
    return true;
  });
});

test('InvalidOptionsError is thrown for a bad host', () => {
  assert.throws(
    () => normalizeOptions({ host: '   ' }),
    (error) => {
      assert.ok(error instanceof InvalidOptionsError);
      assert.equal(error.option, 'host');
      return true;
    }
  );
});
