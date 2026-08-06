'use strict';

// AR8 — NO-OP MERGE, end to end.
//
// The single most important non-regression property in this sprint: with
// MISER_ALERT_ROUTES unset, every alert must go to the default route UNPREFIXED
// with byte-identical text to origin/main's output for the same inputs. §8
// forbids changing any alert's text or unit of measure, so any diff here is a
// bug, not a feature.
//
// Expected strings below are transcribed from the source of truth on
// origin/main (src/budgets.js:174/:187, src/policy-watchdog.js:108/:151,
// src/cache-thrash.js:75, src/router.js:111) — the same strings the existing
// budgets/policy/cache-thrash/retry suites pin.
//
// SCOPE: all six kinds AR8 names — budget-cap, budget-warn, drift, bloat,
// thrash and sub-cap — are now driven end-to-end through the real composition
// root. The budget rows need a populated stats tree and the thrash row needs a
// warmed ring buffer; both are set up below from the same primitives the
// existing budgets/cache-thrash suites use, so the expected strings stay pinned
// to one source of truth rather than being re-typed here.

// stats.js reads MISER_STATS_FILE at require time and budgets.js binds stats at
// require time, so the path is pinned BEFORE any src require — same convention
// as test/budgets.test.js:7-11. The §3.4 preload already redirects this key away
// from HOME; this narrows it further to a per-file path so the tree starts empty.
const os = require('node:os');
const path = require('node:path');
process.env.MISER_STATS_FILE = path.join(os.tmpdir(), `miser-parity-stats-${process.pid}-${Date.now()}.json`);
// $1 per input token makes the spend arithmetic in the expected strings exact
// (test/budgets.test.js:22-23 uses the same fixture for the same reason).
process.env.MISER_PRICING_JSON = JSON.stringify({ testmodel: { inputPerMTok: 1_000_000 } });

const test = require('node:test');
const assert = require('node:assert/strict');

const { wireAlertDispatcher, __resetAlertState } = require('../src/alert-routes.js');
const { checkModelDrift, checkContextBloat } = require('../src/policy-watchdog.js');
const { createCacheThrashChecker } = require('../src/cache-thrash.js');

// budgets.js binds the stats module at require time, so both are re-required
// together for a fresh in-memory stats tree per test (test/budgets.test.js:33-42).
function freshBudgets() {
  delete require.cache[require.resolve('../src/stats.js')];
  delete require.cache[require.resolve('../src/budgets.js')];
  return { stats: require('../src/stats.js'), budgets: require('../src/budgets.js') };
}

const DEFAULT_ROUTE = { endpoint: 'http://127.0.0.1:8001/v1/orch/nacho-orch/reply', tokenFile: '/tmp/miser-parity-token' };

function ledger() {
  const m = new Map();
  return { shouldSend: k => !m.has(k), markSent: k => m.set(k, true) };
}

// Drive a site through the REAL composition root with routes OFF and a stub
// transport, and return what the transport received.
async function drive(config, run) {
  __resetAlertState();
  const posts = [];
  const guardDeps = {};
  const prevWarn = console.warn;
  console.warn = () => {};
  try {
    wireAlertDispatcher(
      { ...config, alertRoutes: null },      // ROUTES OFF — the merge-day state
      guardDeps,
      {
        post: async (endpoint, token, text) => { posts.push({ endpoint, token, text }); },
        readToken: async () => 'tok',
        defaultRoute: DEFAULT_ROUTE,
        createLedger: ledger,
      },
    );
    run(guardDeps);
    // alert dispatch is fire-and-forget at every site; let the microtask chain drain
    await new Promise(r => setTimeout(r, 20));
  } finally { console.warn = prevWarn; }
  return posts;
}

test('AR8: routes OFF — drift alert text is byte-identical and goes to the DEFAULT route unprefixed', async () => {
  const posts = await drive({ policy: { alpha: { expectedModel: 'claude-opus' } } }, (guardDeps) => {
    checkModelDrift('alpha', { model: 'claude-haiku-4-5' }, {
      policyConfig: { alpha: { expectedModel: 'claude-opus' } },
      ledger: ledger(),
      sendAlert: guardDeps.sendAlert,
    });
  });

  assert.equal(posts.length, 1, 'exactly one post');
  assert.equal(posts[0].endpoint, DEFAULT_ROUTE.endpoint,
    'routes OFF resolves to the default route — today\'s behaviour exactly (case D)');
  assert.equal(
    posts[0].text,
    '👁 miser policy: alpha model drift — got claude-haiku-4-5, expected claude-opus* (1× today)',
    'byte-identical to origin/main: no prefix, no scope marker, no unit change',
  );
  // The absence of a prefix is the assertion §2.4 case D calls "unprefixed".
  assert.ok(!/^\[/.test(posts[0].text), 'no routing prefix is prepended');
  assert.ok(!/fleet|@default|scope=/.test(posts[0].text), 'no scope decoration leaks into the text');
  __resetAlertState();
});

test('AR8: routes OFF — context-bloat alert text is byte-identical', async () => {
  const posts = await drive({ policy: { beta: { maxContextTokens: 1000 } } }, (guardDeps) => {
    checkContextBloat('beta', 'claude-opus-4-8', { input_tokens: 5000 }, {
      policyConfig: { beta: { maxContextTokens: 1000 } },
      ledger: ledger(),
      sendAlert: guardDeps.sendAlert,
    });
  });

  assert.equal(posts.length, 1);
  assert.equal(posts[0].endpoint, DEFAULT_ROUTE.endpoint);
  assert.equal(
    posts[0].text,
    '👁 miser policy: beta context 5000 > 1000 cap (1× today)',
    'byte-identical to origin/main',
  );
  __resetAlertState();
});

test('AR8: routes OFF — the FLEET-scope sub-cap alert keeps its exact text', async () => {
  // The sub-cap alert has no project and must not be given a fabricated one
  // (§2.6). Under routes OFF it still lands on the default route with the same
  // string the existing retry suite pins.
  __resetAlertState();
  const posts = [];
  const guardDeps = {};
  const prevWarn = console.warn;
  console.warn = () => {};
  try {
    wireAlertDispatcher({ codex5hCap: 100, alertRoutes: null }, guardDeps, {
      post: async (endpoint, token, text) => { posts.push({ endpoint, text }); },
      readToken: async () => 'tok',
      defaultRoute: DEFAULT_ROUTE,
      createLedger: ledger,
    });
    const result = await guardDeps.sendAlert(
      '⚠️ miser sub-cap: Codex 80% of 100-req 5h cap — deferBackground=true',
      { scope: 'fleet', kind: 'sub-cap' },
    );
    assert.equal(result.outcome, 'delivered');
  } finally { console.warn = prevWarn; }

  assert.equal(posts.length, 1);
  assert.equal(posts[0].endpoint, DEFAULT_ROUTE.endpoint, 'fleet scope -> default route (case A)');
  assert.equal(posts[0].text, '⚠️ miser sub-cap: Codex 80% of 100-req 5h cap — deferBackground=true');
  __resetAlertState();
});

test('AR8: routes OFF — budget-warn and budget-cap texts are byte-identical off a populated stats tree', async () => {
  // The stats tree is populated the way production populates it —
  // recordAnthropicUsage, not a hand-written spend figure — so the $ figures in
  // the expected strings are produced by the real pricing path. At $1/token:
  // 4 tokens = $4.00 = 80% of the $5.00 cap (warn), the 5th = $5.00 (cap).
  const { stats, budgets } = freshBudgets();
  const posts = await drive({ budgets: { alpha: { dailyUSD: 5 } } }, (guardDeps) => {
    const deps = {
      budgetsConfig: { alpha: { dailyUSD: 5 } },
      budgetGraceConfig: [],
      ledger: ledger(),
      sendAlert: guardDeps.sendAlert,
      nowFn: () => new Date(),
    };
    stats.recordAnthropicUsage('alpha', 'anthropic', 'testmodel', { input_tokens: 4 });
    assert.equal(budgets.checkBudget('alpha', deps), null, 'warn passes the request');
    stats.recordAnthropicUsage('alpha', 'anthropic', 'testmodel', { input_tokens: 1 });
    assert.equal(budgets.checkBudget('alpha', deps).status, 429, 'cap blocks with the 429');
  });

  assert.equal(posts.length, 2, 'exactly one warn and one cap post');
  for (const p of posts) {
    assert.equal(p.endpoint, DEFAULT_ROUTE.endpoint, 'routes OFF resolves to the default route (case D)');
    assert.ok(!/^\[/.test(p.text), 'no routing prefix is prepended');
    assert.ok(!/scope=|@default/.test(p.text), 'no scope decoration leaks into the text');
  }
  assert.equal(
    posts[0].text,
    '⚠️ miser budget: alpha at $4.00/$5.00 (80%) — 1 requests today',
    'byte-identical to origin/main (src/budgets.js:187) — including the "1 requests" grammar, which is NOT this sprint\'s to fix',
  );
  assert.equal(
    posts[1].text,
    '⛔ miser budget: alpha EXHAUSTED $5.00/$5.00 — blocking until UTC midnight',
    'byte-identical to origin/main (src/budgets.js:174)',
  );
  __resetAlertState();
});

test('AR8: routes OFF — cache-thrash text is byte-identical off a warmed ring buffer', async () => {
  // Warm the ring with 5 identical prior samples so the baseline is exact:
  // avg cacheWrite1h = 100, avg inputTokens = 1000. The spike then reads
  // 1000/100 = 10.0× on cacheWrite with input flat at 1.0× — the numbers that
  // appear literally in the expected string, so a change to either the ring's
  // averaging or the format breaks this row.
  const posts = await drive({ cacheThrashMinRequests: 5 }, (guardDeps) => {
    const checker = createCacheThrashChecker({
      cacheThrashMinRequests: 5,
      cacheThrashSpikeRatio: 3.0,
      cacheThrashInputSpikeRatio: 2.0,
      cacheThrashRingSize: 50,
    });
    const deps = { ledger: ledger(), sendAlert: guardDeps.sendAlert };
    for (let i = 0; i < 5; i++) {
      checker.check('alpha', 'claude-opus-4-8', { input_tokens: 1000, cache_creation_input_tokens: 100 }, deps);
    }
    const result = checker.check('alpha', 'claude-opus-4-8', { input_tokens: 1000, cache_creation_input_tokens: 1000 }, deps);
    assert.equal(result.warm, true, 'ring is warm — otherwise this row would pass by never alerting');
    assert.equal(result.shouldAlert, true, 'the spike is detected');
  });

  assert.equal(posts.length, 1);
  assert.equal(posts[0].endpoint, DEFAULT_ROUTE.endpoint, 'routes OFF resolves to the default route (case D)');
  assert.equal(
    posts[0].text,
    '⚠️ miser cache-thrash: project=alpha model=claude-opus-4-8 — cacheWrite1h 1000 vs prior avg 100 (10.0×); '
    + 'inputTokens=1000 normal (1.0× avg) — prefix mutation suspected',
    'byte-identical to origin/main (src/cache-thrash.js:75)',
  );
  assert.ok(!/^\[/.test(posts[0].text), 'no routing prefix is prepended');
  __resetAlertState();
});

test('AR8: no alert text anywhere in src/ gained a routing prefix or a new unit', () => {
  // Static backstop for §8's "not changing any alert's text or unit of measure".
  // The alert-emitting sites' template literals must not have grown a scope or
  // route decoration, and no NEW dollar-denominated metric may appear (per Brad
  // 2026-08-02 the fleet manages on % of weekly subscription cap, not $).
  const fs = require('node:fs');
  const path = require('node:path');
  const SRC = path.join(__dirname, '..', 'src');
  const emitters = ['budgets.js', 'policy-watchdog.js', 'cache-thrash.js', 'router.js'];
  for (const f of emitters) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    // The alert strings themselves must not interpolate scope/route.
    const alertLines = text.split('\n').filter(l => /miser (budget|policy|cache-thrash|sub-cap)/.test(l));
    for (const line of alertLines) {
      assert.ok(!/scope=|route=|endpoint=/.test(line),
        `${f}: an alert string gained routing decoration: ${line.trim()}`);
    }
  }
});
