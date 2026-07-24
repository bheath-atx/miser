'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBreaker } = require('../src/circuit-breaker.js');

test('starts CLOSED, acquire() returns true', () => {
  const b = createBreaker('test');
  assert.equal(b.acquire(), true);
  assert.equal(b.getState().state, 'CLOSED');
  assert.equal(b.getState().failures, 0);
  assert.equal(b.getState().openedAt, null);
});

test('recordSuccess resets failure counter in CLOSED state', () => {
  const b = createBreaker('test', { threshold: 3 });
  b.recordFailure();
  b.recordFailure();
  b.recordSuccess();
  assert.equal(b.getState().failures, 0);
  assert.equal(b.getState().state, 'CLOSED');
});

test('trips to OPEN at threshold consecutive failures', () => {
  const b = createBreaker('test', { threshold: 3, nowFn: () => 100 });
  b.recordFailure();
  b.recordFailure();
  assert.equal(b.getState().state, 'CLOSED');
  b.recordFailure();
  assert.equal(b.getState().state, 'OPEN');
  assert.equal(b.getState().openedAt, 100);
  assert.equal(b.acquire(), false);
});

test('OPEN acquire() returns false before resetMs elapses', () => {
  let now = 0;
  const b = createBreaker('test', { threshold: 2, resetMs: 1000, nowFn: () => now });
  b.recordFailure(); b.recordFailure(); // OPEN at now=0
  now = 500; // not yet past resetMs
  assert.equal(b.acquire(), false);
  assert.equal(b.getState().state, 'OPEN');
});

test('OPEN → HALF_OPEN → single probe after resetMs (AC7)', () => {
  let now = 0;
  const b = createBreaker('test', { threshold: 3, resetMs: 1000, nowFn: () => now });
  b.recordFailure(); b.recordFailure(); b.recordFailure(); // OPEN at now=0

  now = 1000; // exactly at resetMs
  assert.equal(b.acquire(), true); // transitions to HALF_OPEN, probe slot taken
  // Second acquire() in same tick — probe slot already consumed
  assert.equal(b.acquire(), false);
});

test('HALF_OPEN: recordSuccess → CLOSED, failures reset', () => {
  let now = 0;
  const b = createBreaker('test', { threshold: 3, resetMs: 1000, nowFn: () => now });
  b.recordFailure(); b.recordFailure(); b.recordFailure(); // OPEN
  now = 1000;
  b.acquire(); // HALF_OPEN, probe taken
  b.recordSuccess(); // → CLOSED
  assert.equal(b.getState().state, 'CLOSED');
  assert.equal(b.getState().failures, 0);
  assert.equal(b.getState().openedAt, null);
  assert.equal(b.acquire(), true); // CLOSED, acquires cleanly
});

test('HALF_OPEN: recordFailure → re-OPEN with new openedAt', () => {
  let now = 0;
  const b = createBreaker('test', { threshold: 3, resetMs: 1000, nowFn: () => now });
  b.recordFailure(); b.recordFailure(); b.recordFailure(); // OPEN at now=0
  now = 1000;
  b.acquire(); // HALF_OPEN, probe taken
  now = 2000;
  b.recordFailure(); // → re-OPEN
  assert.equal(b.getState().state, 'OPEN');
  assert.equal(b.getState().openedAt, 2000);
  assert.equal(b.acquire(), false); // OPEN, no elapsed time → false
});

test('getState returns state, failures, openedAt accurately', () => {
  let now = 42;
  const b = createBreaker('test', { threshold: 2, nowFn: () => now });
  assert.deepEqual(b.getState(), { state: 'CLOSED', failures: 0, openedAt: null });
  b.recordFailure();
  assert.deepEqual(b.getState(), { state: 'CLOSED', failures: 1, openedAt: null });
  b.recordFailure(); // trips OPEN
  assert.deepEqual(b.getState(), { state: 'OPEN', failures: 2, openedAt: 42 });
});

test('success in CLOSED does not change state or openedAt', () => {
  const b = createBreaker('test');
  b.recordSuccess();
  assert.equal(b.getState().state, 'CLOSED');
  assert.equal(b.getState().openedAt, null);
});

test('injectable nowFn drives time without mocking Date.now', () => {
  let now = 0;
  const b = createBreaker('test', { threshold: 1, resetMs: 500, nowFn: () => now });
  b.recordFailure(); // OPEN at now=0
  now = 499;
  assert.equal(b.acquire(), false); // still OPEN
  now = 500;
  assert.equal(b.acquire(), true); // HALF_OPEN, probe
  b.recordSuccess(); // CLOSED
  assert.equal(b.getState().state, 'CLOSED');
});
