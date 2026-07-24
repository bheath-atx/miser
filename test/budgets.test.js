'use strict';

// Sprint B G3 — per-project daily USD budget caps.
// AC1 (config grammar), AC3 (state machine), AC4 (accounting), AC8 (alert
// isolation), plus the exact §1.4 block-response builder. Fully offline.

// stats.js reads MISER_STATS_FILE at require time — pin it to a tmp path
// BEFORE any src require so no test can ever touch the live ~/.miser-stats.json.
const os = require('node:os');
const path = require('node:path');
process.env.MISER_STATS_FILE = path.join(os.tmpdir(), `miser-budgets-test-stats-${process.pid}-${Date.now()}.json`);

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const statsPath = require.resolve('../src/stats.js');
const budgetsPath = require.resolve('../src/budgets.js');
const { createLedger } = require('../src/alert-ledger.js');

// $1 per input token for 'testmodel' — makes spend arithmetic exact.
const PRICING = JSON.stringify({ testmodel: { inputPerMTok: 1_000_000 } });

function tmpFile(name) {
  return path.join(os.tmpdir(), `miser-budgets-${process.pid}-${name}-${Date.now()}-${Math.random()}.json`);
}

// budgets.js binds the stats module at require time, so both must be
// re-required together for a fresh in-memory stats tree per test.
function freshModules(statsFile) {
  delete require.cache[statsPath];
  delete require.cache[budgetsPath];
  process.env.MISER_STATS_FILE = statsFile;
  process.env.MISER_PRICING_JSON = PRICING;
  const stats = require('../src/stats.js');
  const budgets = require('../src/budgets.js');
  return { stats, budgets };
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

function cleanup(statsFile) {
  try { fs.unlinkSync(statsFile); } catch (_) {}
}

// ---------------------------------------------------------------------------
// AC1 — parseBudgets grammar table (null is the exclusive OFF signal)
// ---------------------------------------------------------------------------

test('AC1: parseBudgets unset/empty → null (OFF), no warning', () => {
  const { budgets } = freshModules(tmpFile('g1'));
  const { result, warns } = captureWarns(() => [budgets.parseBudgets(''), budgets.parseBudgets('   ')]);
  assert.equal(result[0], null);
  assert.equal(result[1], null);
  assert.equal(warns.length, 0);
});

test('AC1: parseBudgets malformed JSON / array / non-object → null + warn', () => {
  const { budgets } = freshModules(tmpFile('g2'));
  for (const bad of ['not json', '[{"a":1}]', '"str"', '42', 'null']) {
    const { result, warns } = captureWarns(() => budgets.parseBudgets(bad));
    assert.equal(result, null, `expected null for ${bad}`);
    assert.ok(warns.length >= 1, `expected warn for ${bad}`);
  }
});

test('AC1: invalid projects are ignored+warned; all-invalid → null; empty object never returned', () => {
  const { budgets } = freshModules(tmpFile('g3'));
  const cases = [
    ['{"a":{"dailyUSD":5,"extra":1}}', null],            // unknown key
    ['{"a":{"dailyUSD":"5"}}', null],                    // wrong type
    ['{"a":{"dailyUSD":0.001}}', null],                  // below min
    ['{"a":{"dailyUSD":20000}}', null],                  // above max
    ['{"a":{"dailyUSD":null}}', null],
    ['{"a":5}', null],                                   // non-object value
    ['{"a":[5]}', null],                                 // array value
    ['{"bad name!":{"dailyUSD":5}}', null],              // bad project grammar
    ['{}', null],                                        // no projects at all
  ];
  for (const [input, expected] of cases) {
    const { result, warns } = captureWarns(() => budgets.parseBudgets(input));
    assert.equal(result, expected, `input ${input}`);
    assert.ok(warns.length >= 1, `expected warn for ${input}`);
  }
});

test('AC1: valid budgets survive alongside ignored invalid ones', () => {
  const { budgets } = freshModules(tmpFile('g4'));
  const { result, warns } = captureWarns(() => budgets.parseBudgets(JSON.stringify({
    good: { dailyUSD: 5 },
    edge_min: { dailyUSD: 0.01 },
    edge_max: { dailyUSD: 10000 },
    'bad name!': { dailyUSD: 5 },
    badval: { dailyUSD: -1 },
  })));
  assert.deepEqual(result, {
    good: { dailyUSD: 5 },
    edge_min: { dailyUSD: 0.01 },
    edge_max: { dailyUSD: 10000 },
  });
  assert.equal(warns.length, 2);
});

test('AC1: parseBudgetGrace always returns an array ([]-as-empty, never null)', () => {
  const { budgets } = freshModules(tmpFile('g5'));
  assert.deepEqual(budgets.parseBudgetGrace(''), []);
  const malformed = captureWarns(() => budgets.parseBudgetGrace('not json'));
  assert.deepEqual(malformed.result, []);
  assert.ok(malformed.warns.length >= 1);
  const nonArray = captureWarns(() => budgets.parseBudgetGrace('{"a":1}'));
  assert.deepEqual(nonArray.result, []);
  assert.ok(nonArray.warns.length >= 1);
  const mixed = captureWarns(() => budgets.parseBudgetGrace('["ok",42,"bad name!","also-ok"]'));
  assert.deepEqual(mixed.result, ['ok', 'also-ok']);
  assert.equal(mixed.warns.length, 2);
});

// ---------------------------------------------------------------------------
// AC1(a,b,c) — buildGuardDeps wiring (the index.js production assembly)
// ---------------------------------------------------------------------------

test('AC1a: both features OFF → empty guardDeps and NO createLedger() call', () => {
  const { budgets } = freshModules(tmpFile('w1'));
  let ledgerCalls = 0;
  const deps = budgets.buildGuardDeps(
    { budgets: null, policy: null, budgetGrace: [] },
    { createLedger: () => { ledgerCalls += 1; return {}; } },
  );
  assert.deepEqual(deps, {});
  assert.equal(ledgerCalls, 0);
});

test('AC1b: G3-on/B6-off → ledger created, checkContextBloat key ABSENT', () => {
  const { budgets } = freshModules(tmpFile('w2'));
  let ledgerCalls = 0;
  const deps = budgets.buildGuardDeps(
    { budgets: { alpha: { dailyUSD: 5 } }, policy: null, budgetGrace: ['alpha'] },
    { createLedger: () => { ledgerCalls += 1; return { fake: true }; } },
  );
  assert.equal(ledgerCalls, 1);
  assert.deepEqual(deps.ledger, { fake: true });
  assert.equal(typeof deps.nowFn, 'function');
  assert.deepEqual(deps.budgetsConfig, { alpha: { dailyUSD: 5 } });
  assert.deepEqual(deps.budgetGraceConfig, ['alpha']);
  assert.equal('checkContextBloat' in deps, false); // property absent — zero bloat code can run
  assert.equal('policyConfig' in deps, false);
});

test('AC1c: both active → ledger created once, both hooks present', () => {
  const { budgets } = freshModules(tmpFile('w3'));
  let ledgerCalls = 0;
  const deps = budgets.buildGuardDeps(
    {
      budgets: { alpha: { dailyUSD: 5 } },
      policy: { alpha: { expectedModel: 'claude-sonnet' } },
      budgetGrace: [],
    },
    { createLedger: () => { ledgerCalls += 1; return { fake: true }; } },
  );
  assert.equal(ledgerCalls, 1);
  assert.ok(deps.ledger);
  assert.equal(typeof deps.checkContextBloat, 'function');
  assert.deepEqual(deps.policyConfig, { alpha: { expectedModel: 'claude-sonnet' } });
  assert.deepEqual(deps.budgetsConfig, { alpha: { dailyUSD: 5 } });
});

test('B6-only → ledger + checkContextBloat, no budgets keys', () => {
  const { budgets } = freshModules(tmpFile('w4'));
  const deps = budgets.buildGuardDeps(
    { budgets: null, policy: { alpha: { maxContextTokens: 100000 } }, budgetGrace: [] },
    { createLedger: () => ({ fake: true }) },
  );
  assert.equal(typeof deps.checkContextBloat, 'function');
  assert.equal('budgetsConfig' in deps, false);
  assert.equal('budgetGraceConfig' in deps, false);
});

// ---------------------------------------------------------------------------
// AC11 — B3 cap-only buildGuardDeps wiring
// ---------------------------------------------------------------------------

test('AC11: cap-only (budgets=null, policy=null, codex5hCap=40) → ledger + subCapTracker wired', () => {
  const { budgets } = freshModules(tmpFile('ac11a'));
  let ledgerCalls = 0;
  let trackerCalls = 0;
  const seams = {
    createLedger: () => { ledgerCalls += 1; return { fake: 'ledger' }; },
    createSubCapTracker: (opts) => { trackerCalls += 1; return { fake: 'tracker', opts }; },
  };
  const deps = budgets.buildGuardDeps(
    { budgets: null, policy: null, codex5hCap: 40, codexWeeklyCap: 280, budgetGrace: [] },
    seams,
  );
  assert.equal(ledgerCalls, 1);
  assert.equal(trackerCalls, 1);
  assert.ok(deps.ledger);
  assert.ok(deps.subCapTracker);
  assert.equal(deps.subCapTracker.opts.cap5h, 40);
  assert.equal(deps.subCapTracker.opts.weeklyCap, 280);
  assert.equal('budgetsConfig' in deps, false);
  assert.equal('policyConfig' in deps, false);
});

test('AC11: all three features OFF (codex5hCap=0) → empty deps, no spies called', () => {
  const { budgets } = freshModules(tmpFile('ac11b'));
  let ledgerCalls = 0;
  let trackerCalls = 0;
  const seams = {
    createLedger: () => { ledgerCalls += 1; return {}; },
    createSubCapTracker: () => { trackerCalls += 1; return {}; },
  };
  const deps = budgets.buildGuardDeps(
    { budgets: null, policy: null, codex5hCap: 0, budgetGrace: [] },
    seams,
  );
  assert.deepEqual(deps, {});
  assert.equal(ledgerCalls, 0);
  assert.equal(trackerCalls, 0);
});

test('AC11: cap + budgets both active → both wired alongside each other', () => {
  const { budgets } = freshModules(tmpFile('ac11c'));
  let ledgerCalls = 0;
  let trackerCalls = 0;
  const seams = {
    createLedger: () => { ledgerCalls += 1; return { fake: 'ledger' }; },
    createSubCapTracker: () => { trackerCalls += 1; return { fake: 'tracker' }; },
  };
  const deps = budgets.buildGuardDeps(
    { budgets: { proj: { dailyUSD: 5 } }, policy: null, codex5hCap: 40, budgetGrace: [] },
    seams,
  );
  assert.equal(ledgerCalls, 1); // ledger created once only
  assert.equal(trackerCalls, 1);
  assert.ok(deps.budgetsConfig);
  assert.ok(deps.subCapTracker);
});

// ---------------------------------------------------------------------------
// AC3 — state machine: UNDER → WARNED → CAPPED, one alert each, day re-arm
// ---------------------------------------------------------------------------

test('AC3: warn once at 80%, cap once at 100%, block repeats without re-alerting, next day re-arms', async () => {
  const statsFile = tmpFile('sm');
  const ledgerFile = tmpFile('sm-ledger');
  const { stats, budgets } = freshModules(statsFile);
  try {
    const alerts = [];
    const sendAlert = async (text) => { alerts.push(text); };
    let clock = new Date(); // real today — stats todayKey() uses the real clock
    const nowFn = () => clock;
    const ledger = createLedger(ledgerFile, nowFn);
    const guardDeps = {
      budgetsConfig: { alpha: { dailyUSD: 5 } },
      budgetGraceConfig: [],
      ledger,
      sendAlert,
      nowFn,
    };

    // UNDER: $3.00 < 80% of $5 → pass, no alert.
    stats.recordAnthropicUsage('alpha', 'anthropic', 'testmodel', { input_tokens: 3 });
    assert.equal(budgets.checkBudget('alpha', guardDeps), null);
    await tick();
    assert.deepEqual(alerts, []);

    // WARNED: $4.00 ≥ 80% → pass + exactly one warn alert (ledger-deduped).
    stats.recordAnthropicUsage('alpha', 'anthropic', 'testmodel', { input_tokens: 1 });
    assert.equal(budgets.checkBudget('alpha', guardDeps), null);
    assert.equal(budgets.checkBudget('alpha', guardDeps), null);
    await tick();
    assert.deepEqual(alerts, ['⚠️ miser budget: alpha at $4.00/$5.00 (80%) — 2 requests today']);

    // CAPPED: $5.00 ≥ cap → block + exactly one cap alert.
    stats.recordAnthropicUsage('alpha', 'anthropic', 'testmodel', { input_tokens: 1 });
    const block1 = budgets.checkBudget('alpha', guardDeps);
    assert.equal(block1.status, 429);
    assert.equal(block1.headers['x-miser-budget'], 'exhausted');
    assert.equal(block1.body.type, 'error');
    assert.equal(block1.body.error.type, 'rate_limit_error');
    assert.equal(
      block1.body.error.message,
      "miser: project 'alpha' daily budget of $5.00 exhausted (spent $5.00); resets at next UTC midnight",
    );
    const block2 = budgets.checkBudget('alpha', guardDeps);
    assert.equal(block2.status, 429);
    await tick();
    assert.equal(alerts.length, 2);
    assert.equal(alerts[1], '⛔ miser budget: alpha EXHAUSTED $5.00/$5.00 — blocking until UTC midnight');

    // Blocked requests accrue $0: spend is still exactly $5.00.
    assert.equal(budgets.__test.computeTodaySpendUSD('alpha', clock).spend, 5);
    // blockedCount incremented per block, firstBlockedAt set once.
    const result = stats.getStats('1');
    assert.equal(result.perProject.alpha.budget.blockedCount, 2);
    assert.equal(typeof result.perProject.alpha.budget.firstBlockedAt, 'string');

    // Day rollover: spend keys on the new UTC day → state recomputes to UNDER.
    clock = new Date(clock.getTime() + 24 * 3600 * 1000 + 1000);
    assert.equal(budgets.checkBudget('alpha', guardDeps), null);
    await tick();
    assert.equal(alerts.length, 2); // no new alerts — UNDER again
  } finally {
    cleanup(statsFile);
    cleanup(ledgerFile);
  }
});

test('grace project at cap: cap alert fires with GRACE text, request passes, no block counter', async () => {
  const statsFile = tmpFile('grace');
  const ledgerFile = tmpFile('grace-ledger');
  const { stats, budgets } = freshModules(statsFile);
  try {
    const alerts = [];
    const nowFn = () => new Date();
    const guardDeps = {
      budgetsConfig: { alpha: { dailyUSD: 2 } },
      budgetGraceConfig: ['alpha'],
      ledger: createLedger(ledgerFile, nowFn),
      sendAlert: async (t) => { alerts.push(t); },
      nowFn,
    };
    stats.recordAnthropicUsage('alpha', 'anthropic', 'testmodel', { input_tokens: 3 }); // $3 ≥ $2 cap
    assert.equal(budgets.checkBudget('alpha', guardDeps), null); // passes
    assert.equal(budgets.checkBudget('alpha', guardDeps), null); // still passes, no re-alert
    await tick();
    assert.deepEqual(alerts, ['⛔ miser budget: alpha EXHAUSTED $3.00/$2.00 — GRACE: alerting only, not blocking']);
    assert.equal(stats.getStats('1').perProject.alpha.budget, undefined); // never blocked
  } finally {
    cleanup(statsFile);
    cleanup(ledgerFile);
  }
});

test('unbudgeted project and budgets-OFF are state OFF: no check, no alert', async () => {
  const statsFile = tmpFile('off');
  const ledgerFile = tmpFile('off-ledger');
  const { stats, budgets } = freshModules(statsFile);
  try {
    const alerts = [];
    const nowFn = () => new Date();
    stats.recordAnthropicUsage('other', 'anthropic', 'testmodel', { input_tokens: 100 });
    const guardDeps = {
      budgetsConfig: { alpha: { dailyUSD: 1 } },
      budgetGraceConfig: [],
      ledger: createLedger(ledgerFile, nowFn),
      sendAlert: async (t) => { alerts.push(t); },
      nowFn,
    };
    // 'other' has spend but no budget → OFF, passes.
    assert.equal(budgets.checkBudget('other', guardDeps), null);
    // budgetsConfig absent entirely → OFF.
    assert.equal(budgets.checkBudget('alpha', { ledger: guardDeps.ledger, nowFn }), null);
    await tick();
    assert.deepEqual(alerts, []);
  } finally {
    cleanup(statsFile);
    cleanup(ledgerFile);
  }
});

test('missing ledger → skip entirely: no alert, no block, no counter (normative §2.5)', async () => {
  const statsFile = tmpFile('noledger');
  const { stats, budgets } = freshModules(statsFile);
  try {
    const alerts = [];
    stats.recordAnthropicUsage('alpha', 'anthropic', 'testmodel', { input_tokens: 10 }); // way over $1 cap
    const block = budgets.checkBudget('alpha', {
      budgetsConfig: { alpha: { dailyUSD: 1 } },
      budgetGraceConfig: [],
      sendAlert: async (t) => { alerts.push(t); },
      nowFn: () => new Date(),
      // ledger deliberately absent
    });
    assert.equal(block, null);
    await tick();
    assert.deepEqual(alerts, []);
    assert.equal(stats.getStats('1').perProject.alpha.budget, undefined);
  } finally {
    cleanup(statsFile);
  }
});

// ---------------------------------------------------------------------------
// AC4 — accounting: in-memory (un-flushed) spend is authoritative
// ---------------------------------------------------------------------------

test('AC4: budget check sees un-flushed usage (no flushNow anywhere)', () => {
  const statsFile = tmpFile('unflushed');
  const ledgerFile = tmpFile('unflushed-ledger');
  const { stats, budgets } = freshModules(statsFile);
  try {
    const nowFn = () => new Date();
    stats.recordAnthropicUsage('alpha', 'anthropic', 'testmodel', { input_tokens: 5 });
    // Never flushed — the file does not even exist yet.
    assert.equal(fs.existsSync(statsFile), false);
    const block = budgets.checkBudget('alpha', {
      budgetsConfig: { alpha: { dailyUSD: 5 } },
      budgetGraceConfig: [],
      ledger: createLedger(ledgerFile, nowFn),
      sendAlert: async () => {},
      nowFn,
    });
    assert.equal(block.status, 429);
  } finally {
    cleanup(statsFile);
    cleanup(ledgerFile);
  }
});

test('AC4: non-Anthropic measured legs accrue $0 toward the budget', () => {
  const statsFile = tmpFile('legs');
  const { stats, budgets } = freshModules(statsFile);
  try {
    // Hypothetical non-anthropic provider bucket — computeCost ignores it.
    stats.recordAnthropicUsage('alpha', 'codex', 'gpt-5.5', { input_tokens: 1000 });
    const { spend } = budgets.__test.computeTodaySpendUSD('alpha', new Date());
    assert.equal(spend, 0);
  } finally {
    cleanup(statsFile);
  }
});

// ---------------------------------------------------------------------------
// §1.4 block response — retry-after at mocked clock boundaries, toFixed(2)
// ---------------------------------------------------------------------------

test('block response: retry-after is ceil(seconds to next UTC midnight), min 1', () => {
  const { budgets } = freshModules(tmpFile('retry'));
  const r30 = budgets.buildBlockResponse('p', 5, 5, new Date('2026-07-23T23:59:30Z'));
  assert.equal(r30.headers['retry-after'], '30');
  const r1 = budgets.buildBlockResponse('p', 5, 5, new Date('2026-07-23T23:59:59.999Z'));
  assert.equal(r1.headers['retry-after'], '1'); // never 0 before rollover
  const rFull = budgets.buildBlockResponse('p', 5, 5, new Date('2026-07-23T00:00:00.000Z'));
  assert.equal(rFull.headers['retry-after'], '86400');
  const rCeil = budgets.buildBlockResponse('p', 5, 5, new Date('2026-07-23T23:59:58.500Z'));
  assert.equal(rCeil.headers['retry-after'], '2'); // ceiling, not rounding
});

test('block response: exact Anthropic error wire shape with toFixed(2) dollars', () => {
  const { budgets } = freshModules(tmpFile('shape'));
  const r = budgets.buildBlockResponse('pkachu', 5.5, 5, new Date('2026-07-23T12:00:00Z'));
  assert.equal(r.status, 429);
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.headers['x-miser-budget'], 'exhausted');
  assert.deepEqual(r.body, {
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: "miser: project 'pkachu' daily budget of $5.00 exhausted (spent $5.50); resets at next UTC midnight",
    },
  });
});

// ---------------------------------------------------------------------------
// AC8 — alert isolation: fire-and-forget, ledger dedup, pending promise
// ---------------------------------------------------------------------------

test('AC8: checkBudget returns before a pending sendAlert resolves; second event does not re-call', async () => {
  const statsFile = tmpFile('ac8');
  const ledgerFile = tmpFile('ac8-ledger');
  const { stats, budgets } = freshModules(statsFile);
  try {
    let callCount = 0;
    let resolveAlert;
    let settled = false;
    const pending = new Promise((r) => { resolveAlert = r; });
    pending.then(() => { settled = true; });
    const nowFn = () => new Date();
    const guardDeps = {
      budgetsConfig: { alpha: { dailyUSD: 1 } },
      budgetGraceConfig: [],
      ledger: createLedger(ledgerFile, nowFn),
      sendAlert: () => { callCount += 1; return pending; },
      nowFn,
    };
    stats.recordAnthropicUsage('alpha', 'anthropic', 'testmodel', { input_tokens: 2 }); // capped
    const block = budgets.checkBudget('alpha', guardDeps);
    // (a) the check completed while the alert promise is still pending.
    assert.equal(block.status, 429);
    assert.equal(settled, false);
    await tick();
    // (b) called exactly once on the first qualifying event.
    assert.equal(callCount, 1);
    // (c) second event same day does NOT call the mock (ledger dedup).
    budgets.checkBudget('alpha', guardDeps);
    await tick();
    assert.equal(callCount, 1);
    resolveAlert();
    await pending;
  } finally {
    cleanup(statsFile);
    cleanup(ledgerFile);
  }
});

test('AC8: a rejecting injected sendAlert is swallowed by the dispatch wrapper', async () => {
  const statsFile = tmpFile('reject');
  const ledgerFile = tmpFile('reject-ledger');
  const { stats, budgets } = freshModules(statsFile);
  try {
    const nowFn = () => new Date();
    stats.recordAnthropicUsage('alpha', 'anthropic', 'testmodel', { input_tokens: 2 });
    const block = budgets.checkBudget('alpha', {
      budgetsConfig: { alpha: { dailyUSD: 1 } },
      budgetGraceConfig: [],
      ledger: createLedger(ledgerFile, nowFn),
      sendAlert: () => Promise.reject(new Error('pkachu down')),
      nowFn,
    });
    assert.equal(block.status, 429);
    await tick();
    await tick(); // no unhandled rejection — swallowed by .catch(() => {})
  } finally {
    cleanup(statsFile);
    cleanup(ledgerFile);
  }
});
