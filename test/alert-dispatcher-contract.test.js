'use strict';

// AR32 + AR33 — the dispatcher's promise contract and the transport seam.
//
// These two ACs exist because of specific audit findings, and each row here is
// the thing that finding asked for:
//   * AR32 (CODEX-IQA-R6.md:11, R7.md:15): the promise contract was ambiguous.
//     Existing sendAlert documented itself as "NEVER throws", so a .catch on it
//     was dead code and any failure oracle built on that catch could not fire.
//     The contract is now RESOLVE-ALWAYS with an AlertResult, and delivered
//     logs NOTHING while every non-delivered outcome logs exactly one line.
//   * AR33 (CODEX-IQA-R8.md:11): the {post} transport seam was declared in §3.4
//     but never threaded through the composition root, so "drive the REAL
//     wireAlertDispatcher with an injected transport" was unsatisfiable.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAlertDispatcher,
  wireAlertDispatcher,
  getAlertCounters,
  __resetAlertState,
} = require('../src/alert-routes.js');

const DEFAULT_ROUTE = { endpoint: 'http://127.0.0.1:8001/default', tokenFile: '/tmp/miser-test-default' };
const S360_ROUTE = { endpoint: 'http://127.0.0.1:8001/v1/orch/structural360/reply', tokenFile: '/tmp/miser-test-s360' };

function routeMap(entries, extra = {}) {
  return {
    entries,
    mapped: Object.keys(entries).filter(k => entries[k] !== '@default'),
    defaultDeclared: Object.keys(entries).filter(k => entries[k] === '@default'),
    defaultConfigured: true,
    degraded: { unroutedConfigured: [], undeliverableDefaultDeclared: [] },
    ...extra,
  };
}

// Recording ledger stub: records the ORDER of calls, which is what lets AR28(d)
// assert mark-before-send rather than merely "markSent happened".
function recordingLedger() {
  const marked = new Map();
  const calls = [];
  return {
    calls,
    marked,
    shouldSend(key) { calls.push(`shouldSend:${key}`); return !marked.has(key); },
    markSent(key) { calls.push(`markSent:${key}`); marked.set(key, true); },
    async flushNow() { calls.push('flushNow'); },
  };
}

function captureWarns(fn) {
  const prev = console.warn;
  const warns = [];
  console.warn = (line) => warns.push(String(line));
  try { return { warns, value: fn(warns) }; } finally { console.warn = prev; }
}

// ---------------------------------------------------------------------------
// AR32(a) — never rejects, resolves to a matching AlertResult, for EVERY
// failure mode. assert.doesNotReject is the load-bearing assertion: it is what
// makes `settled` in §2.3a safe to void in production and safe to await in a
// test without a try/catch.
// ---------------------------------------------------------------------------
test('AR32(a): sendAlert NEVER rejects and resolves to a matching AlertResult (all failure modes)', async () => {
  const cases = [
    {
      name: 'delivered',
      config: { alertRoutes: routeMap({ structural360: S360_ROUTE }) },
      seams: { post: async () => {}, readToken: async () => 'tok', defaultRoute: DEFAULT_ROUTE },
      opts: { project: 'structural360', kind: 'budget-cap' },
      expect: { ok: true, outcome: 'delivered' },
    },
    {
      name: 'failed (transport rejects)',
      config: { alertRoutes: routeMap({ structural360: S360_ROUTE }) },
      seams: { post: async () => { throw new Error('pkachu HTTP 500'); }, readToken: async () => 'tok', defaultRoute: DEFAULT_ROUTE },
      opts: { project: 'structural360', kind: 'drift' },
      expect: { ok: false, outcome: 'failed' },
    },
    {
      name: 'failed (unreadable tokenFile)',
      config: { alertRoutes: routeMap({ structural360: S360_ROUTE }) },
      seams: { post: async () => {}, readToken: async () => { throw new Error('ENOENT'); }, defaultRoute: DEFAULT_ROUTE },
      opts: { project: 'structural360', kind: 'bloat' },
      expect: { ok: false, outcome: 'failed' },
    },
    {
      name: 'withheld (unmapped project, case E)',
      config: { alertRoutes: routeMap({ structural360: S360_ROUTE }) },
      seams: { post: async () => {}, readToken: async () => 'tok', defaultRoute: DEFAULT_ROUTE, ledger: recordingLedger() },
      opts: { project: 'pkachu', kind: 'cache-thrash' },
      expect: { ok: false, outcome: 'withheld' },
    },
    {
      name: 'dropped (no destination at all)',
      config: { alertRoutes: null, alertRoutesOps: null },
      seams: { post: async () => {}, readToken: async () => 'tok', defaultRoute: null },
      opts: { kind: 'sub-cap' },
      expect: { ok: false, outcome: 'dropped' },
    },
  ];

  for (const c of cases) {
    __resetAlertState();
    const prevWarn = console.warn;
    console.warn = () => {};
    try {
      const sendAlert = createAlertDispatcher(c.config, c.seams);
      let result;
      await assert.doesNotReject(
        async () => { result = await sendAlert('text', c.opts); },
        `${c.name}: the production dispatcher must never reject`,
      );
      assert.equal(result.ok, c.expect.ok, `${c.name}: ok`);
      assert.equal(result.outcome, c.expect.outcome, `${c.name}: outcome`);
      assert.equal(result.kind, c.opts.kind, `${c.name}: kind is echoed back for attribution`);
    } finally {
      console.warn = prevWarn;
    }
  }
  __resetAlertState();
});

// ---------------------------------------------------------------------------
// AR32(b) — the log/count rule, asserted in BOTH directions. The positive
// zero-warns-on-success clause is the one CODEX-IQA-R7.md:15 asked for: §2.7
// defined tokens for three non-delivery outcomes while §2.9a said "every
// outcome", so a builder could not tell whether success should log.
// ---------------------------------------------------------------------------
test('AR32(b): every outcome bumps one counter; only NON-delivered outcomes log; delivered logs NOTHING', async () => {
  // delivered -> counter only, zero lines
  __resetAlertState();
  {
    const { warns } = captureWarns(() => {});
    const prev = console.warn;
    const lines = [];
    console.warn = (l) => lines.push(String(l));
    try {
      const sendAlert = createAlertDispatcher(
        { alertRoutes: routeMap({ structural360: S360_ROUTE }) },
        { post: async () => {}, readToken: async () => 'tok', defaultRoute: DEFAULT_ROUTE },
      );
      const r = await sendAlert('x', { project: 'structural360', kind: 'budget-cap' });
      assert.equal(r.outcome, 'delivered');
      assert.equal(getAlertCounters().delivered, 1, 'delivered counter bumped exactly once');
      assert.deepEqual(lines, [], 'a successful send emits ZERO log lines (success is silent)');
    } finally { console.warn = prev; void warns; }
  }

  // each non-delivered outcome -> exactly one line carrying its §2.7 token
  const nonDelivered = [
    {
      name: 'failed', token: /\[miser\/alert\] WARN alert send failed: kind=drift/,
      config: { alertRoutes: routeMap({ structural360: S360_ROUTE }) },
      seams: { post: async () => { throw new Error('boom'); }, readToken: async () => 'tok', defaultRoute: DEFAULT_ROUTE },
      opts: { project: 'structural360', kind: 'drift' }, counter: 'failed',
    },
    {
      name: 'withheld', token: /\[miser\/alert\] ALERT-WITHHELD project=pkachu kind=cache-thrash/,
      config: { alertRoutes: routeMap({ structural360: S360_ROUTE }) },
      seams: { post: async () => {}, readToken: async () => 'tok', defaultRoute: DEFAULT_ROUTE, ledger: recordingLedger() },
      opts: { project: 'pkachu', kind: 'cache-thrash' }, counter: 'withheld',
    },
    {
      name: 'dropped', token: /\[miser\/alert\] ALERT-DROPPED .*reason=no_destination/,
      config: { alertRoutes: null, alertRoutesOps: null },
      seams: { post: async () => {}, readToken: async () => 'tok', defaultRoute: null },
      opts: { kind: 'sub-cap' }, counter: 'dropped',
    },
  ];

  for (const c of nonDelivered) {
    __resetAlertState();
    const prev = console.warn;
    const lines = [];
    console.warn = (l) => lines.push(String(l));
    try {
      const sendAlert = createAlertDispatcher(c.config, c.seams);
      await sendAlert('x', c.opts);
      const own = lines.filter(l => c.token.test(l));
      assert.equal(own.length, 1, `${c.name}: exactly one log line carrying its own token`);
      assert.equal(getAlertCounters()[c.counter], 1, `${c.name}: counter bumped exactly once`);
    } finally { console.warn = prev; }
  }
  __resetAlertState();
});

// ---------------------------------------------------------------------------
// AR32(b2) — the OWNERSHIP SPLIT (CODEX-IQA-R8.md:13). R8 claimed the dispatcher
// owned every row while also listing dispatcher-absent as a DROPPED cause. That
// is impossible: a dispatcher that does not exist cannot log its own absence.
// Ownership therefore splits on whether a dispatcher was reachable, and EXACTLY
// ONE emitter acts per event.
// ---------------------------------------------------------------------------
test('AR32(b2): pre-dispatcher guard owns no_dispatcher; dispatcher owns the rest; never both; same counter', async () => {
  // (i) NO dispatcher -> the pre-dispatcher guard in the FEATURE module emits.
  __resetAlertState();
  {
    const prev = console.warn;
    const lines = [];
    console.warn = (l) => lines.push(String(l));
    try {
      // Driven through checkModelDrift rather than checkBudget: the budget CAPPED
      // branch needs real spend in the stats tree, whereas drift needs only a
      // policy entry + a mismatching model, so this exercises the guard without
      // depending on stats state at all.
      const { checkModelDrift } = require('../src/policy-watchdog.js');
      checkModelDrift('structural360', { model: 'claude-haiku-4-5' }, {
        policyConfig: { structural360: { expectedModel: 'claude-opus' } },
        ledger: recordingLedger(),
        nowFn: () => new Date('2026-08-04T12:00:00Z'),
        // sendAlert deliberately absent — this is the no_dispatcher path
      });
      const dropLines = lines.filter(l => /ALERT-DROPPED .*reason=no_dispatcher/.test(l));
      assert.equal(dropLines.length, 1, 'the pre-dispatcher guard emits exactly one no_dispatcher line');
      assert.equal(getAlertCounters().dropped, 1, 'and bumps the SAME dropped counter');
    } finally { console.warn = prev; }
  }

  // (ii) dispatcher PRESENT but no destination -> the DISPATCHER emits, and the
  // reason differs, so the two paths are distinguishable in the log.
  __resetAlertState();
  {
    const prev = console.warn;
    const lines = [];
    console.warn = (l) => lines.push(String(l));
    try {
      const sendAlert = createAlertDispatcher(
        { alertRoutes: null, alertRoutesOps: null },
        { post: async () => {}, readToken: async () => 'tok', defaultRoute: null },
      );
      await sendAlert('x', { kind: 'budget-cap' });
      assert.equal(lines.filter(l => /reason=no_destination/.test(l)).length, 1,
        'the dispatcher owns the DROPPED row when it exists but cannot resolve a destination');
      assert.equal(lines.filter(l => /reason=no_dispatcher/.test(l)).length, 0,
        'and the pre-dispatcher reason must NOT also appear — exactly one emitter acts per event');
      assert.equal(getAlertCounters().dropped, 1, 'same dropped counter, so health totals hold either way');
    } finally { console.warn = prev; }
  }
  __resetAlertState();
});

// ---------------------------------------------------------------------------
// AR33 — the transport seam is THREADED to the real composition root, and the
// two seams are not confused. seams.sendAlert replaces the whole dispatcher;
// seams.post replaces only the socket. A test that stubs the former to assert
// dispatcher behaviour is testing its own stub.
// ---------------------------------------------------------------------------
test('AR33(a): wireAlertDispatcher({post}) yields the REAL dispatcher and opens zero sockets', async () => {
  __resetAlertState();
  const posts = [];
  const guardDeps = {};
  const prev = console.warn;
  console.warn = () => {};
  try {
    wireAlertDispatcher(
      { budgets: { structural360: {} }, alertRoutes: routeMap({ structural360: S360_ROUTE }) },
      guardDeps,
      {
        post: async (endpoint, token, text) => { posts.push({ endpoint, text }); },
        readToken: async () => 'tok',
        defaultRoute: DEFAULT_ROUTE,
        createLedger: recordingLedger,
      },
    );
    assert.equal(typeof guardDeps.sendAlert, 'function', 'a dispatcher is wired');

    const result = await guardDeps.sendAlert('real routing please', { project: 'structural360', kind: 'budget-cap' });

    // Real resolution, real counters, real AlertResult — only the socket replaced.
    assert.equal(result.outcome, 'delivered');
    assert.equal(result.endpoint, S360_ROUTE.endpoint, 'routed by the REAL resolver, not a stub');
    assert.equal(getAlertCounters().delivered, 1, 'the REAL counters moved');
    assert.equal(posts.length, 1, 'delivery went to the injected transport');
    // The §3.4 Layer-2 network guard is armed for the whole suite; if postPkachu
    // had been reached it would have thrown MISER_TEST_NETWORK_GUARD, so a clean
    // pass here IS the zero-sockets assertion.
  } finally { console.warn = prev; __resetAlertState(); }
});

test('AR33(b): with NEITHER seam, createAlertDispatcher defaults to postPkachu (production unchanged)', () => {
  // Source shape: the default is postPkachu, so an absent seam cannot silently
  // change production's transport.
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../src/alert-routes.js'), 'utf8');
  assert.match(src, /const post = seams\.post \|\| postPkachu;/,
    'the transport defaults to postPkachu when no seam is injected');
});

test('AR33(c): seams.sendAlert still wins outright (Layer-1 hermeticity, AR13 mechanism)', () => {
  __resetAlertState();
  const guardDeps = {};
  const stub = async () => ({ ok: true, outcome: 'delivered', kind: 'stub' });
  wireAlertDispatcher({ budgets: { p: {} } }, guardDeps, { sendAlert: stub, createLedger: recordingLedger });
  assert.equal(guardDeps.sendAlert, stub, 'a whole-dispatcher seam replaces the dispatcher entirely');
  __resetAlertState();
});

test('AR33(d): source shape — wireAlertDispatcher PASSES a post seam into createAlertDispatcher', () => {
  // This is the row that keeps AR28/AR29/AR32 honest. If a future edit drops the
  // argument, those oracles would silently degrade into stub-testing-stub while
  // still passing, so the threading is pinned here rather than assumed.
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('../src/alert-routes.js'), 'utf8');
  assert.match(
    src,
    /createAlertDispatcher\(config,\s*\{[\s\S]{0,200}?post:\s*seams\.post/,
    'wireAlertDispatcher must thread seams.post into createAlertDispatcher',
  );
});
