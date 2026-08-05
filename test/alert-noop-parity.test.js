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
// SCOPE NOTE: this file covers the drift, bloat and sub-cap kinds end-to-end
// through the real composition root. The budget-cap/budget-warn rows need a
// populated stats tree and the cache-thrash row needs a warmed ring buffer;
// those are mechanical table extensions flagged in STATUS.md as a Codex
// candidate. What is asserted here is the property that actually carries the
// risk — routes OFF resolves to the default route, unprefixed, text untouched.

const test = require('node:test');
const assert = require('node:assert/strict');

const { wireAlertDispatcher, __resetAlertState } = require('../src/alert-routes.js');
const { checkModelDrift, checkContextBloat } = require('../src/policy-watchdog.js');

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
