'use strict';

// B2 cache-thrash detector tests — AC21–AC30.
// All offline: checker is driven directly with stub ledger + stub sendAlert.
// No live sockets, no index.js import.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createCacheThrashChecker } = require('../src/cache-thrash.js');

// ---- Stub helpers -----------------------------------------------------------

function makeGuardDeps(overrides = {}) {
  const alertCalls = [];
  return {
    ledger: {
      shouldSend: () => true,
      markSent:   () => {},
    },
    sendAlert: (...args) => { alertCalls.push(args); },
    _alertCalls: alertCalls,
    ...overrides,
  };
}

function baseConfig(overrides = {}) {
  return {
    cacheThrashMinRequests:     5,
    cacheThrashSpikeRatio:      3.0,
    cacheThrashInputSpikeRatio: 2.0,
    cacheThrashRingSize:        50,
    ...overrides,
  };
}

function rawUsage(inputTokens, cacheWrite1h) {
  return { input_tokens: inputTokens, cache_creation_input_tokens: cacheWrite1h };
}

async function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

// ---- AC21: first 4 calls return warm:false ----------------------------------

test('AC21: first 4 calls return warm:false regardless of usage values', () => {
  const checker = createCacheThrashChecker(baseConfig());
  const guardDeps = makeGuardDeps();
  for (let i = 0; i < 4; i++) {
    const result = checker.check('proj', 'model', rawUsage(1000, 500), guardDeps);
    assert.equal(result.warm, false, `call ${i + 1} should be warm:false`);
  }
  assert.equal(guardDeps._alertCalls.length, 0, 'no alert should fire before warm');
});

// ---- AC22: 5th call with spike triggers alert ------------------------------

test('AC22: 5th call with 10× spike + normal input triggers alert', async () => {
  const checker = createCacheThrashChecker(baseConfig());
  const guardDeps = makeGuardDeps();
  // Establish baseline: 4 requests with cacheWrite1h=100, inputTokens=1000
  for (let i = 0; i < 4; i++) {
    checker.check('proj', 'model', rawUsage(1000, 100), guardDeps);
  }
  // 5th: spike cacheWrite1h to 1000 (10× prior avg of 100), input stays normal
  const result = checker.check('proj', 'model', rawUsage(1000, 1000), guardDeps);
  assert.equal(result.warm, true);
  assert.equal(result.shouldAlert, true);
  await tick();
  assert.equal(guardDeps._alertCalls.length, 1, 'alert should fire exactly once');
});

// ---- AC23: input also spikes → no alert (new-large-turn guard) -------------

test('AC23: input spike alongside cacheWrite spike → no alert', async () => {
  const checker = createCacheThrashChecker(baseConfig());
  const guardDeps = makeGuardDeps();
  for (let i = 0; i < 4; i++) {
    checker.check('proj', 'model', rawUsage(1000, 100), guardDeps);
  }
  // cacheWrite1h spikes, but input ALSO spikes beyond inputSpikeRatio (2×)
  const result = checker.check('proj', 'model', rawUsage(3000, 1000), guardDeps);
  assert.equal(result.shouldAlert, false, 'inputNormal is false when input also spikes');
  await tick();
  assert.equal(guardDeps._alertCalls.length, 0);
});

// ---- AC24: ledger dedup prevents second alert -----------------------------

test('AC24: ledger shouldSend=false prevents duplicate alert', async () => {
  const checker = createCacheThrashChecker(baseConfig());
  let sendCount = 0;
  const guardDeps = makeGuardDeps({
    ledger: {
      shouldSend: () => false, // already sent today
      markSent: () => {},
    },
    sendAlert: () => { sendCount++; },
  });
  for (let i = 0; i < 4; i++) {
    checker.check('proj', 'model', rawUsage(1000, 100), guardDeps);
  }
  checker.check('proj', 'model', rawUsage(1000, 1000), guardDeps);
  await tick();
  assert.equal(sendCount, 0, 'no alert when ledger says already sent');
});

// ---- AC25: null/empty rawUsage safe ----------------------------------------

test('AC25: rawUsage=null returns warm:false without calling sendAlert', async () => {
  const checker = createCacheThrashChecker(baseConfig());
  const guardDeps = makeGuardDeps();
  const result = checker.check('proj', 'model', null, guardDeps);
  assert.deepEqual(result, { warm: false, insufficientBaseline: true, shouldAlert: false });
  await tick();
  assert.equal(guardDeps._alertCalls.length, 0);
});

test('AC25: rawUsage={} (no keys) returns without error and without alert', async () => {
  const checker = createCacheThrashChecker(baseConfig());
  const guardDeps = makeGuardDeps();
  assert.doesNotThrow(() => checker.check('proj', 'model', {}, guardDeps));
  await tick();
  assert.equal(guardDeps._alertCalls.length, 0);
});

// ---- AC26: cacheThrashMinRequests=0 → no-op --------------------------------

test('AC26: createCacheThrashChecker with minRequests=0 returns no-op', () => {
  const checker = createCacheThrashChecker(baseConfig({ cacheThrashMinRequests: 0 }));
  // check returns undefined (no-op)
  const result = checker.check('proj', 'model', rawUsage(1000, 500), {});
  assert.equal(result, undefined, 'check() should be a no-op returning undefined');
  assert.deepEqual(checker.getStatus('proj'), { warm: false, insufficientBaseline: true });
});

// ---- AC27: throwing sendAlert is isolated, console.warn fires --------------

test('AC27: throwing sendAlert is isolated — console.warn fires, no crash', async () => {
  const checker = createCacheThrashChecker(baseConfig());
  const warns = [];
  const prevWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    const guardDeps = makeGuardDeps({
      sendAlert: () => { throw new Error('alert fail'); },
    });
    for (let i = 0; i < 4; i++) {
      checker.check('proj', 'model', rawUsage(1000, 100), guardDeps);
    }
    const result = checker.check('proj', 'model', rawUsage(1000, 1000), guardDeps);
    assert.equal(result.shouldAlert, true);
    await tick();
    await tick();
    assert.ok(warns.some(w => /alert/.test(w) || /thrash/.test(w)),
      'console.warn should be called on sendAlert throw');
  } finally {
    console.warn = prevWarn;
  }
});

// ---- AC28: cold-start blind (all-mutated state learned as baseline) ---------

test('AC28: all-mutated cold-start — no alert fires for 6 identical high requests', async () => {
  const checker = createCacheThrashChecker(baseConfig());
  const guardDeps = makeGuardDeps();
  for (let i = 0; i < 6; i++) {
    const result = checker.check('proj', 'model', rawUsage(1000, 1000), guardDeps);
    if (result.warm) {
      assert.equal(result.shouldAlert, false,
        `call ${i + 1}: no alert expected when ratio = 1.0 < spikeRatio 3.0`);
    }
  }
  await tick();
  assert.equal(guardDeps._alertCalls.length, 0);
});

// ---- AC29: zero prior baseline → no false positive -------------------------

test('AC29: zero prior baseline guard prevents false positive', async () => {
  // minRequests=3 so ring warms on 3rd push
  const checker = createCacheThrashChecker(baseConfig({ cacheThrashMinRequests: 3 }));
  const guardDeps = makeGuardDeps();
  // 3 requests with cacheWrite1h=0 to establish zero baseline
  for (let i = 0; i < 3; i++) {
    checker.check('proj', 'model', rawUsage(1000, 0), guardDeps);
  }
  // 4th request with cacheWrite1h=100 — prior avg is 0, zero-baseline guard fires
  const result = checker.check('proj', 'model', rawUsage(1000, 100), guardDeps);
  assert.equal(result.warm, true);
  assert.equal(result.insufficientBaseline, true);
  assert.equal(result.shouldAlert, false);
  await tick();
  assert.equal(guardDeps._alertCalls.length, 0);
});

// ---- AC30: spike after established baseline → alert fires ------------------

test('AC30: spike after established nonzero baseline triggers alert', async () => {
  const checker = createCacheThrashChecker(baseConfig({ cacheThrashMinRequests: 3 }));
  const guardDeps = makeGuardDeps();
  // 4 requests with cacheWrite1h=100 to establish prior avg ≈ 100
  for (let i = 0; i < 4; i++) {
    checker.check('proj', 'model', rawUsage(1000, 100), guardDeps);
  }
  // 5th with cacheWrite1h=500 (5× > spikeRatio 3.0), inputTokens unchanged (< 2×)
  const result = checker.check('proj', 'model', rawUsage(1000, 500), guardDeps);
  assert.equal(result.warm, true);
  assert.equal(result.insufficientBaseline, false);
  assert.equal(result.shouldAlert, true);
  await tick();
  assert.equal(guardDeps._alertCalls.length, 1, 'alert must fire on verified spike');
});
