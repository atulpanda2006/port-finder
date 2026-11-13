'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PortFinderError,
  InvalidPortError,
  InvalidRangeError,
  InvalidOptionsError,
  describeValue,
} = require('../lib/errors');

test('describeValue makes each kind of input unambiguous', () => {
  assert.equal(describeValue(3000), '3000');
  assert.equal(describeValue('3000'), '"3000"');
  assert.equal(describeValue(undefined), 'undefined');
  assert.equal(describeValue(null), 'null');
  assert.equal(describeValue([1, 2]), 'an array');
  assert.equal(describeValue({}), 'an object');
  assert.equal(describeValue(Object.create(null)), 'an object');
  assert.equal(describeValue(new Date()), 'a Date instance');
  assert.equal(describeValue(new Map()), 'a Map instance');
  assert.equal(describeValue(NaN), 'NaN');
  assert.equal(describeValue(Infinity), 'Infinity');
});

test('PortFinderError is a normal Error with a default code', () => {
  const error = new PortFinderError('something failed');

  assert.ok(error instanceof Error);
  assert.equal(error.name, 'PortFinderError');
  assert.equal(error.message, 'something failed');
  assert.equal(error.code, 'ERR_PORT_FINDER');
  assert.ok(error.stack.includes('something failed'));
});

test('PortFinderError only attaches optional fields it was given', () => {
  const error = new PortFinderError('boom', { port: 3000, range: { start: 1, end: 2 } });

  assert.equal(error.port, 3000);
  assert.deepEqual(error.range, { start: 1, end: 2 });
  assert.equal('value' in error, false);
  assert.equal('cause' in error, false);
});

test('InvalidPortError carries a stable code, the raw value and the message', () => {
  const error = new InvalidPortError(70000);

  assert.ok(error instanceof PortFinderError);
  assert.ok(error instanceof InvalidPortError);
  assert.equal(error.name, 'InvalidPortError');
  assert.equal(error.code, 'ERR_INVALID_PORT');
  assert.equal(error.port, 70000);
  assert.equal(error.value, 70000);
  assert.match(error.message, /Invalid port 70000/);
  assert.match(error.message, /between 1 and 65535/);
});

test('InvalidPortError keeps non-numeric input in "value" but not in "port"', () => {
  const error = new InvalidPortError('3000');

  assert.equal(error.value, '3000');
  assert.equal(error.port, undefined);
  assert.match(error.message, /Invalid port "3000"/);
});

test('InvalidRangeError records both ends of the bad range', () => {
  const error = new InvalidRangeError(3010, 3000);

  assert.ok(error instanceof PortFinderError);
  assert.equal(error.code, 'ERR_INVALID_RANGE');
  assert.deepEqual(error.range, { start: 3010, end: 3000 });
  assert.match(error.message, /Invalid port range 3010-3000/);
});

test('InvalidOptionsError records the offending option and can wrap a cause', () => {
  const cause = new InvalidPortError(0);
  const error = new InvalidOptionsError('Invalid "exclude" entry 0.', {
    option: 'exclude',
    cause,
  });

  assert.equal(error.code, 'ERR_INVALID_OPTIONS');
  assert.equal(error.option, 'exclude');
  assert.equal(error.cause, cause);
  assert.equal('port' in error, false);
});
