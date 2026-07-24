'use strict';

// Tests for retryWithBackoff (AC1–AC4) and _maybeAlertSubCap (AC8).
// All delays are instant via injected sleepFn. No sockets opened.

const os = require('node:os');
const path = require('node:path');
// Pin stats file before any src require
process.env.MISER_STATS_FILE = path.join(os.tmpdir(), `miser-retry-test-${process.pid}-${Date.now()}.json`);

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../src/router.js');
const { retryWithBackoff, _maybeAlertSubCap } = __test;
const { makeRes } = require('./_harness.js');
const { createSubCapTracker } = require('../src/sub-cap.js');

const noSleep = () => Promise.resolve();
const constJitter = () => 0.5;

function makeOpts(maxAttempts = 3, extra = {}) {
  return { maxAttempts, baseMs: 100, sleepFn: noSleep, jitterFn: constJitter, ...extra };
}

// ---------------------------------------------------------------------------
// AC1: retryable error retried up to maxAttempts, returns success on last attempt
// ---------------------------------------------------------------------------

test('AC1: fn() called exactly 3 times on 2 retryable failures then success', async () => {
  let calls = 0;
  const res = makeRes();
  const fn = () => {
    calls++;
    if (calls < 3) {
      const err = new Error('overloaded'); err.statusCode = 529; err.retryable = true;
      return Promise.reject(err);
    }
    return Promise.resolve('success');
  };
  const result = await retryWithBackoff(fn, res, makeOpts(3));
  assert.equal(calls, 3);
  assert.equal(result, 'success');
});

test('AC1: success on first attempt returns result, fn called once', async () => {
  let calls = 0;
  const res = makeRes();
  const result = await retryWithBackoff(() => { calls++; return Promise.resolve(42); }, res, makeOpts(3));
  assert.equal(calls, 1);
  assert.equal(result, 42);
});

// ---------------------------------------------------------------------------
// AC2: 5xx status codes with retryable flag behave identically to 529
// ---------------------------------------------------------------------------

for (const statusCode of [500, 502, 503, 504]) {
  test(`AC2: ${statusCode} with retryable=true: retried (retryable flag is sole predicate)`, async () => {
    let calls = 0;
    const res = makeRes();
    const fn = () => {
      calls++;
      if (calls < 2) {
        const err = new Error(`err ${statusCode}`); err.statusCode = statusCode; err.retryable = true;
        return Promise.reject(err);
      }
      return Promise.resolve('ok');
    };
    const result = await retryWithBackoff(fn, res, makeOpts(3));
    assert.equal(calls, 2);
    assert.equal(result, 'ok');
  });
}

// ---------------------------------------------------------------------------
// AC3: 429 NOT retried; connect-error IS retried; non-retryable propagates immediately
// ---------------------------------------------------------------------------

test('AC3: 429 (retryable not set) propagates immediately, fn called once', async () => {
  let calls = 0;
  const res = makeRes();
  const fn = () => {
    calls++;
    const err = new Error('quota'); err.statusCode = 429;
    return Promise.reject(err);
  };
  await assert.rejects(() => retryWithBackoff(fn, res, makeOpts(3)), /quota/);
  assert.equal(calls, 1);
});

test('AC3: connect-error (retryable=true, no statusCode) retried up to maxAttempts', async () => {
  let calls = 0;
  const res = makeRes();
  const fn = () => {
    calls++;
    const err = new Error('ECONNREFUSED'); err.retryable = true;
    return Promise.reject(err);
  };
  await assert.rejects(() => retryWithBackoff(fn, res, makeOpts(3)), /ECONNREFUSED/);
  assert.equal(calls, 3);
});

test('AC3: 400 non-retryable propagates immediately, fn called once', async () => {
  let calls = 0;
  const res = makeRes();
  const fn = () => {
    calls++;
    const err = new Error('bad request'); err.statusCode = 400;
    return Promise.reject(err);
  };
  await assert.rejects(() => retryWithBackoff(fn, res, makeOpts(3)), /bad request/);
  assert.equal(calls, 1);
});

test('AC3: all maxAttempts exhausted throws last error', async () => {
  let calls = 0;
  const res = makeRes();
  const fn = () => {
    calls++;
    const err = new Error(`attempt ${calls}`); err.retryable = true;
    return Promise.reject(err);
  };
  await assert.rejects(() => retryWithBackoff(fn, res, makeOpts(2)), /attempt 2/);
  assert.equal(calls, 2);
});

// ---------------------------------------------------------------------------
// AC4: two-point res.headersSent guard
// ---------------------------------------------------------------------------

// Case A: headersSent set synchronously by fn() → no second attempt (top-of-loop guard)
test('AC4-A: headersSent set during fn() prevents retry (top-of-loop guard)', async () => {
  let calls = 0;
  const res = makeRes();
  const fn = () => {
    calls++;
    res.headersSent = true; // simulate writeHead() called during fn
    const err = new Error('streamed'); err.retryable = true;
    return Promise.reject(err);
  };
  await assert.rejects(() => retryWithBackoff(fn, res, makeOpts(3)));
  assert.equal(calls, 1); // fn called exactly once; top-of-loop guard fires on attempt=1
});

// Case B: headersSent set during sleep → post-sleep guard fires before next fn() call
test('AC4-B: headersSent set during sleep prevents second fn() invocation (post-sleep guard)', async () => {
  let calls = 0;
  let sleepCount = 0;
  const res = makeRes();
  const sleepFn = async () => {
    sleepCount++;
    res.headersSent = true; // set during sleep
  };
  const fn = () => {
    calls++;
    const err = new Error('retryable'); err.retryable = true;
    return Promise.reject(err);
  };
  await assert.rejects(
    () => retryWithBackoff(fn, res, { maxAttempts: 3, baseMs: 100, sleepFn, jitterFn: constJitter }),
  );
  assert.equal(calls, 1);    // fn only called on attempt=0
  assert.equal(sleepCount, 1); // sleep ran once (attempt=1), then post-sleep guard fired
});

// ---------------------------------------------------------------------------
// AC8: _maybeAlertSubCap — shouldAlert at 80% burn rate and on any 429
// ---------------------------------------------------------------------------

function fakeLedger() {
  const sent = new Set();
  return {
    shouldSend(key) { return !sent.has(key); },
    markSent(key) { sent.add(key); },
  };
}

// Sub-case A: 80% burn rate (no 429s)
test('AC8-A: shouldAlert=true at 80% capFraction, alert sent once with correct text', async () => {
  const tracker = createSubCapTracker({ cap5h: 40 });
  const now = 1_000_000;
  for (let i = 0; i < 32; i++) tracker.recordSuccess(now); // 32/40 = 80%

  const status = tracker.getStatus(now);
  assert.equal(status.capFraction, 0.80);
  assert.equal(status.shouldAlert, true);
  assert.equal(status.events429In5h, 0);

  const alerts = [];
  const ledger = fakeLedger();
  const guardDeps = { subCapTracker: tracker, ledger, sendAlert: (msg) => { alerts.push(msg); } };

  _maybeAlertSubCap(guardDeps, now);
  await Promise.resolve(); // let fire-and-forget settle

  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].includes('80% of 40-req 5h cap'), `expected '80% of 40-req 5h cap' in: ${alerts[0]}`);
  assert.ok(!alerts[0].includes('429s observed'), `unexpected '429s observed' in: ${alerts[0]}`);

  // Second call — ledger already has key marked → no second alert
  _maybeAlertSubCap(guardDeps, now);
  await Promise.resolve();
  assert.equal(alerts.length, 1);
});

// Sub-case B: first 429 (no prior successes, capFraction=0)
test('AC8-B: shouldAlert=true on first 429, alert text contains 429 count (C1)', async () => {
  const tracker = createSubCapTracker({ cap5h: 40 });
  const now = 1_000_000;
  tracker.record429(now);

  const status = tracker.getStatus(now);
  assert.equal(status.events429In5h, 1);
  assert.equal(status.capFraction, 0);
  assert.equal(status.shouldAlert, true);

  const alerts = [];
  const ledger = fakeLedger();
  const guardDeps = { subCapTracker: tracker, ledger, sendAlert: (msg) => { alerts.push(msg); } };

  _maybeAlertSubCap(guardDeps, now);
  await Promise.resolve();

  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].includes('1 429s observed'), `expected '1 429s observed' in: ${alerts[0]}`);
});

// Fail-safe: tracker.getStatus throws → logs warning, no exception propagates
test('AC8: _maybeAlertSubCap is fail-safe: throwing tracker does not propagate', () => {
  const guardDeps = {
    subCapTracker: { getStatus() { throw new Error('tracker broken'); } },
    ledger: fakeLedger(),
    sendAlert: () => { throw new Error('should not reach here'); },
  };
  const warns = [];
  const prev = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  try {
    assert.doesNotThrow(() => _maybeAlertSubCap(guardDeps, 1_000_000));
    assert.ok(warns.some(w => w.includes('_maybeAlertSubCap sync error')));
  } finally {
    console.warn = prev;
  }
});

// No-op when no subCapTracker
test('AC8: _maybeAlertSubCap no-ops when guardDeps has no subCapTracker', () => {
  assert.doesNotThrow(() => _maybeAlertSubCap({}, 1_000_000));
  assert.doesNotThrow(() => _maybeAlertSubCap(null, 1_000_000));
});
