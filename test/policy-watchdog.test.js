'use strict';

// Sprint B B6 — policy watchdog: parsePolicy grammar (§2.1), AC5 model drift,
// AC6 context bloat. Alert-only, never blocks, never mutates. Fully offline.

const os = require('node:os');
const path = require('node:path');
process.env.MISER_STATS_FILE = path.join(os.tmpdir(), `miser-policy-test-stats-${process.pid}-${Date.now()}.json`);

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const statsPath = require.resolve('../src/stats.js');
const watchdogPath = require.resolve('../src/policy-watchdog.js');
const { createLedger } = require('../src/alert-ledger.js');

function tmpFile(name) {
  return path.join(os.tmpdir(), `miser-policy-${process.pid}-${name}-${Date.now()}-${Math.random()}.json`);
}

function freshModules(statsFile) {
  delete require.cache[statsPath];
  delete require.cache[watchdogPath];
  process.env.MISER_STATS_FILE = statsFile;
  const stats = require('../src/stats.js');
  const watchdog = require('../src/policy-watchdog.js');
  return { stats, watchdog };
}

function captureWarns(fn) {
  const prev = console.warn;
  const warns = [];
  console.warn = (line) => warns.push(String(line));
  try {
    return { result: fn(), warns };
  } finally {
    console.warn = prev;
  }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function cleanup(file) {
  try { fs.unlinkSync(file); } catch (_) {}
}

// ---------------------------------------------------------------------------
// §2.1 — parsePolicy grammar (same null-as-OFF table as parseBudgets)
// ---------------------------------------------------------------------------

test('parsePolicy unset/empty → null (OFF), no warning', () => {
  const { watchdog } = freshModules(tmpFile('p1'));
  const { result, warns } = captureWarns(() => [watchdog.parsePolicy(''), watchdog.parsePolicy('  ')]);
  assert.equal(result[0], null);
  assert.equal(result[1], null);
  assert.equal(warns.length, 0);
});

test('parsePolicy malformed / array / non-object / all-invalid → null + warn', () => {
  const { watchdog } = freshModules(tmpFile('p2'));
  const bad = [
    'not json',
    '[]',
    '"str"',
    '{}',
    '{"a":{}}',                                    // no allowed keys at all
    '{"a":{"expectedModel":""}}',                  // empty string
    `{"a":{"expectedModel":"${'x'.repeat(65)}"}}`, // >64 chars
    '{"a":{"expectedModel":["claude"]}}',          // array, not string
    '{"a":{"maxContextTokens":9999}}',             // below min
    '{"a":{"maxContextTokens":2000001}}',          // above max
    '{"a":{"maxContextTokens":100000.5}}',         // non-integer
    '{"a":{"expectedModel":"claude","unknown":1}}',// unknown key
    '{"bad name!":{"expectedModel":"claude"}}',    // bad project grammar
  ];
  for (const input of bad) {
    const { result, warns } = captureWarns(() => watchdog.parsePolicy(input));
    assert.equal(result, null, `input ${input}`);
    assert.ok(warns.length >= 1, `expected warn for ${input}`);
  }
});

test('parsePolicy accepts drift-only, bloat-only, and combined project policies', () => {
  const { watchdog } = freshModules(tmpFile('p3'));
  const { result, warns } = captureWarns(() => watchdog.parsePolicy(JSON.stringify({
    driftonly: { expectedModel: 'claude-sonnet' },
    bloatonly: { maxContextTokens: 400000 },
    both: { expectedModel: 'claude-haiku', maxContextTokens: 10000 },
    'bad key': { expectedModel: 'x' },
  })));
  assert.deepEqual(result, {
    driftonly: { expectedModel: 'claude-sonnet' },
    bloatonly: { maxContextTokens: 400000 },
    both: { expectedModel: 'claude-haiku', maxContextTokens: 10000 },
  });
  assert.equal(warns.length, 1);
});

test('parsePolicy: one invalid field invalidates the whole project entry', () => {
  const { watchdog } = freshModules(tmpFile('p4'));
  const { result } = captureWarns(() => watchdog.parsePolicy(JSON.stringify({
    a: { expectedModel: 'claude', maxContextTokens: 5 }, // maxContextTokens out of bounds
  })));
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// AC5 — model drift (pre-compress, read-only, prefix match)
// ---------------------------------------------------------------------------

test('AC5a/b: mismatched model alerts once, counter keeps incrementing; matching prefix is silent', async () => {
  const statsFile = tmpFile('drift');
  const ledgerFile = tmpFile('drift-ledger');
  const { stats, watchdog } = freshModules(statsFile);
  try {
    const alerts = [];
    const nowFn = () => new Date();
    const guardDeps = {
      policyConfig: { orch: { expectedModel: 'claude-sonnet' } },
      ledger: createLedger(ledgerFile, nowFn),
      sendAlert: async (t) => { alerts.push(t); },
      nowFn,
    };

    // (b) matching prefix → nothing.
    watchdog.checkModelDrift('orch', { model: 'claude-sonnet-4-6' }, guardDeps);
    await tick();
    assert.deepEqual(alerts, []);
    assert.equal(stats.getStats('1').perProject.orch, undefined);

    // (a) drifted model → one alert, counter 1.
    watchdog.checkModelDrift('orch', { model: 'claude-opus-4-8' }, guardDeps);
    await tick();
    assert.deepEqual(alerts, [
      '👁 miser policy: orch model drift — got claude-opus-4-8, expected claude-sonnet* (1× today)',
    ]);
    // Subsequent drift events: counter increments, NO further alerts.
    watchdog.checkModelDrift('orch', { model: 'claude-opus-4-8' }, guardDeps);
    watchdog.checkModelDrift('orch', { model: 'claude-opus-4-8' }, guardDeps);
    await tick();
    assert.equal(alerts.length, 1);
    assert.deepEqual(stats.getStats('1').perProject.orch.policy, {
      modelDriftCount: 3,
      contextBloatCount: 0,
    });
  } finally {
    cleanup(statsFile);
    cleanup(ledgerFile);
  }
});

test('AC5c: absent / non-string body.model → skip, no alert, no throw', async () => {
  const statsFile = tmpFile('nomodel');
  const ledgerFile = tmpFile('nomodel-ledger');
  const { stats, watchdog } = freshModules(statsFile);
  try {
    const alerts = [];
    const nowFn = () => new Date();
    const guardDeps = {
      policyConfig: { orch: { expectedModel: 'claude-sonnet' } },
      ledger: createLedger(ledgerFile, nowFn),
      sendAlert: async (t) => { alerts.push(t); },
      nowFn,
    };
    assert.doesNotThrow(() => watchdog.checkModelDrift('orch', {}, guardDeps));
    assert.doesNotThrow(() => watchdog.checkModelDrift('orch', { model: 42 }, guardDeps));
    assert.doesNotThrow(() => watchdog.checkModelDrift('orch', { model: '' }, guardDeps));
    assert.doesNotThrow(() => watchdog.checkModelDrift('orch', null, guardDeps));
    await tick();
    assert.deepEqual(alerts, []);
    assert.equal(stats.getStats('1').perProject.orch, undefined);
  } finally {
    cleanup(statsFile);
    cleanup(ledgerFile);
  }
});

test('AC5d: bloat-only policy project → drift skips silently on ANY model', async () => {
  const statsFile = tmpFile('bloatonly');
  const ledgerFile = tmpFile('bloatonly-ledger');
  const { stats, watchdog } = freshModules(statsFile);
  try {
    const alerts = [];
    const nowFn = () => new Date();
    const guardDeps = {
      policyConfig: { orch: { maxContextTokens: 100000 } }, // no expectedModel
      ledger: createLedger(ledgerFile, nowFn),
      sendAlert: async (t) => { alerts.push(t); },
      nowFn,
    };
    watchdog.checkModelDrift('orch', { model: 'anything-at-all' }, guardDeps);
    await tick();
    assert.deepEqual(alerts, []);
    assert.equal(stats.getStats('1').perProject.orch, undefined);
  } finally {
    cleanup(statsFile);
    cleanup(ledgerFile);
  }
});

test('drift with missing ledger → skip: no alert, no counter (§2.5)', async () => {
  const statsFile = tmpFile('drift-noledger');
  const { stats, watchdog } = freshModules(statsFile);
  try {
    const alerts = [];
    watchdog.checkModelDrift('orch', { model: 'claude-opus' }, {
      policyConfig: { orch: { expectedModel: 'claude-sonnet' } },
      sendAlert: async (t) => { alerts.push(t); },
      nowFn: () => new Date(),
    });
    await tick();
    assert.deepEqual(alerts, []);
    assert.equal(stats.getStats('1').perProject.orch, undefined);
  } finally {
    cleanup(statsFile);
  }
});

// ---------------------------------------------------------------------------
// AC6 — context bloat (measured usage only, no estimate fallback)
// ---------------------------------------------------------------------------

test('AC6a: measured usage over threshold → one alert + counter increments per event', async () => {
  const statsFile = tmpFile('bloat');
  const ledgerFile = tmpFile('bloat-ledger');
  const { stats, watchdog } = freshModules(statsFile);
  try {
    const alerts = [];
    const nowFn = () => new Date();
    const guardDeps = {
      policyConfig: { orch: { maxContextTokens: 100000 } },
      ledger: createLedger(ledgerFile, nowFn),
      sendAlert: async (t) => { alerts.push(t); },
      nowFn,
    };
    const usage = {
      input_tokens: 50000,
      cache_read_input_tokens: 60000,
      output_tokens: 999999, // output does NOT count toward context
    };
    watchdog.checkContextBloat('orch', 'claude-sonnet-4-6', usage, guardDeps);
    await tick();
    assert.deepEqual(alerts, ['👁 miser policy: orch context 110000 > 100000 cap (1× today)']);
    watchdog.checkContextBloat('orch', 'claude-sonnet-4-6', usage, guardDeps);
    await tick();
    assert.equal(alerts.length, 1); // ledger-deduped
    assert.deepEqual(stats.getStats('1').perProject.orch.policy, {
      modelDriftCount: 0,
      contextBloatCount: 2,
    });
  } finally {
    cleanup(statsFile);
    cleanup(ledgerFile);
  }
});

test('AC6: cache_creation nested and legacy total fields count toward context tokens', () => {
  const { watchdog } = freshModules(tmpFile('norm'));
  const { measuredContextTokens } = watchdog.__test;
  assert.equal(measuredContextTokens({
    input_tokens: 100,
    cache_read_input_tokens: 200,
    cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 40 },
  }), 370);
  assert.equal(measuredContextTokens({
    input_tokens: 100,
    cache_creation_input_tokens: 50, // legacy total form
  }), 150);
  assert.equal(measuredContextTokens({ output_tokens: 5000 }), 0);
});

test('AC6b: null / missing usage → returns immediately, no event, no fabricated signal', async () => {
  const statsFile = tmpFile('nousage');
  const ledgerFile = tmpFile('nousage-ledger');
  const { stats, watchdog } = freshModules(statsFile);
  try {
    const alerts = [];
    const nowFn = () => new Date();
    const guardDeps = {
      policyConfig: { orch: { maxContextTokens: 10000 } },
      ledger: createLedger(ledgerFile, nowFn),
      sendAlert: async (t) => { alerts.push(t); },
      nowFn,
    };
    assert.doesNotThrow(() => watchdog.checkContextBloat('orch', 'claude', null, guardDeps));
    assert.doesNotThrow(() => watchdog.checkContextBloat('orch', 'claude', undefined, guardDeps));
    assert.doesNotThrow(() => watchdog.checkContextBloat('orch', 'claude', 'bogus', guardDeps));
    await tick();
    assert.deepEqual(alerts, []);
    assert.equal(stats.getStats('1').perProject.orch, undefined);
  } finally {
    cleanup(statsFile);
    cleanup(ledgerFile);
  }
});

test('AC6: at-threshold is NOT bloat (strictly greater-than), drift-only policy skips bloat', async () => {
  const statsFile = tmpFile('edge');
  const ledgerFile = tmpFile('edge-ledger');
  const { stats, watchdog } = freshModules(statsFile);
  try {
    const alerts = [];
    const nowFn = () => new Date();
    const guardDeps = {
      policyConfig: {
        orch: { maxContextTokens: 100000 },
        driftproj: { expectedModel: 'claude-sonnet' },
      },
      ledger: createLedger(ledgerFile, nowFn),
      sendAlert: async (t) => { alerts.push(t); },
      nowFn,
    };
    watchdog.checkContextBloat('orch', 'claude', { input_tokens: 100000 }, guardDeps); // == cap
    watchdog.checkContextBloat('driftproj', 'claude', { input_tokens: 999999 }, guardDeps); // no max
    watchdog.checkContextBloat('unlisted', 'claude', { input_tokens: 999999 }, guardDeps); // no policy
    await tick();
    assert.deepEqual(alerts, []);
    assert.equal(stats.getStats('1').perProject.orch, undefined);
  } finally {
    cleanup(statsFile);
    cleanup(ledgerFile);
  }
});

test('bloat with missing ledger → immediate return (B6-OFF for the invocation)', async () => {
  const statsFile = tmpFile('bloat-noledger');
  const { stats, watchdog } = freshModules(statsFile);
  try {
    const alerts = [];
    watchdog.checkContextBloat('orch', 'claude', { input_tokens: 999999 }, {
      policyConfig: { orch: { maxContextTokens: 10000 } },
      sendAlert: async (t) => { alerts.push(t); },
      nowFn: () => new Date(),
    });
    await tick();
    assert.deepEqual(alerts, []);
    assert.equal(stats.getStats('1').perProject.orch, undefined);
  } finally {
    cleanup(statsFile);
  }
});

test('drift + bloat counters share one sparse policy node per project per day', async () => {
  const statsFile = tmpFile('shared');
  const ledgerFile = tmpFile('shared-ledger');
  const { stats, watchdog } = freshModules(statsFile);
  try {
    const nowFn = () => new Date();
    const guardDeps = {
      policyConfig: { orch: { expectedModel: 'claude-sonnet', maxContextTokens: 10000 } },
      ledger: createLedger(ledgerFile, nowFn),
      sendAlert: async () => {},
      nowFn,
    };
    watchdog.checkModelDrift('orch', { model: 'claude-opus' }, guardDeps);
    watchdog.checkContextBloat('orch', 'claude-opus', { input_tokens: 20000 }, guardDeps);
    await tick();
    assert.deepEqual(stats.getStats('1').perProject.orch.policy, {
      modelDriftCount: 1,
      contextBloatCount: 1,
    });
  } finally {
    cleanup(statsFile);
    cleanup(ledgerFile);
  }
});
