'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSubCapTracker } = require('../src/sub-cap.js');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS  = 24 * HOUR_MS;

test('zero-state when no events recorded', () => {
  const t = createSubCapTracker({ cap5h: 40, weeklyCap: 280 });
  const s = t.getStatus(1_000_000);
  assert.equal(s.requestsIn5h, 0);
  assert.equal(s.events429In5h, 0);
  assert.equal(s.cap5h, 40);
  assert.equal(s.capFraction, 0);
  assert.equal(s.deferBackground, false);
  assert.equal(s.shouldAlert, false);
  assert.equal(s.weeklyRequests, 0);
  assert.equal(s.weeklyCap, 280);
  assert.equal(s.burnRatePerHour, 0);
  assert.equal(s.timeToLimitEstMs, null);
});

test('capFraction and deferBackground at 80% (AC8-A core)', () => {
  const t = createSubCapTracker({ cap5h: 40 });
  const now = 1_000_000;
  for (let i = 0; i < 32; i++) t.recordSuccess(now);
  const s = t.getStatus(now);
  assert.equal(s.requestsIn5h, 32);
  assert.equal(s.capFraction, 0.80);
  assert.equal(s.deferBackground, true);
  assert.equal(s.shouldAlert, true);
});

test('below 80% → deferBackground=false, shouldAlert=false', () => {
  const t = createSubCapTracker({ cap5h: 40 });
  const now = 1_000_000;
  for (let i = 0; i < 31; i++) t.recordSuccess(now);
  const s = t.getStatus(now);
  assert.ok(s.capFraction < 0.80);
  assert.equal(s.deferBackground, false);
  assert.equal(s.shouldAlert, false);
});

test('single 429 triggers deferBackground/shouldAlert regardless of capFraction (AC8-B core)', () => {
  const t = createSubCapTracker({ cap5h: 40 });
  const now = 1_000_000;
  t.record429(now);
  const s = t.getStatus(now);
  assert.equal(s.events429In5h, 1);
  assert.equal(s.capFraction, 0); // no successes
  assert.equal(s.deferBackground, true);
  assert.equal(s.shouldAlert, true);
});

test('5h window pruning: successes older than 5h fall out of requestsIn5h', () => {
  const t = createSubCapTracker({ cap5h: 40 });
  const base = 1_000_000;
  t.recordSuccess(base);
  const now = base + 5 * HOUR_MS + 1;
  const s = t.getStatus(now);
  assert.equal(s.requestsIn5h, 0); // pruned from 5h window
});

test('5h window: events within window are counted', () => {
  const t = createSubCapTracker({ cap5h: 40 });
  const base = 1_000_000;
  t.recordSuccess(base);
  const now = base + 5 * HOUR_MS - 1; // just inside window
  const s = t.getStatus(now);
  assert.equal(s.requestsIn5h, 1);
});

test('7-day retention: events older than 7 days pruned from weeklyRequests', () => {
  const t = createSubCapTracker({ cap5h: 40, weeklyCap: 280 });
  const base = 1_000_000;
  t.recordSuccess(base);
  const now = base + 7 * DAY_MS + 1;
  const s = t.getStatus(now);
  assert.equal(s.weeklyRequests, 0);
});

test('timeToLimitEstMs is null when cap5h is 0 (feature off)', () => {
  const t = createSubCapTracker({ cap5h: 0 });
  t.recordSuccess(1_000_000);
  const s = t.getStatus(1_000_000);
  assert.equal(s.timeToLimitEstMs, null);
});

test('timeToLimitEstMs is null when no successes (burn rate zero)', () => {
  const t = createSubCapTracker({ cap5h: 40 });
  const s = t.getStatus(1_000_000);
  assert.equal(s.timeToLimitEstMs, null);
});

test('timeToLimitEstMs computed from formula: (cap5h - req5h) * WINDOW_5H / req5h', () => {
  const t = createSubCapTracker({ cap5h: 40 });
  const now = 1_000_000;
  for (let i = 0; i < 10; i++) t.recordSuccess(now);
  const s = t.getStatus(now);
  const expected = (40 - 10) * 5 * 60 * 60 * 1000 / 10;
  assert.equal(s.timeToLimitEstMs, expected);
});

test('burnRatePerHour = requestsIn5h / 5', () => {
  const t = createSubCapTracker({ cap5h: 40 });
  const now = 1_000_000;
  for (let i = 0; i < 20; i++) t.recordSuccess(now);
  const s = t.getStatus(now);
  assert.equal(s.burnRatePerHour, 4); // 20 / 5
});

test('feature off (cap5h=0): capFraction=0, deferBackground=false even with successes', () => {
  const t = createSubCapTracker({ cap5h: 0 });
  const now = 1_000_000;
  t.recordSuccess(now);
  const s = t.getStatus(now);
  assert.equal(s.capFraction, 0);
  assert.equal(s.deferBackground, false);
  assert.equal(s.shouldAlert, false);
});

test('weeklyCapFraction computed when weeklyCap > 0', () => {
  const t = createSubCapTracker({ cap5h: 40, weeklyCap: 200 });
  const now = 1_000_000;
  for (let i = 0; i < 50; i++) t.recordSuccess(now);
  const s = t.getStatus(now);
  assert.equal(s.weeklyRequests, 50);
  assert.equal(s.weeklyCapFraction, 0.25);
});

test('getStatus can be called multiple times without double-counting', () => {
  const t = createSubCapTracker({ cap5h: 40 });
  const now = 1_000_000;
  for (let i = 0; i < 10; i++) t.recordSuccess(now);
  t.getStatus(now); // first call
  const s = t.getStatus(now); // second call
  assert.equal(s.requestsIn5h, 10);
});
