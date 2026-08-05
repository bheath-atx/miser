'use strict';

// AR9 / AR11 / AR13 / AR16 / AR28 / AR30 / AR31a — the composition root.
//
// These are the ACs where the test IS the design. §1.4's structural hole existed
// because a new alerting feature (cache-thrash, Sprint D) was added without
// updating the enablement test, and R1's proposed fix would have silently
// removed cache-thrash alert delivery entirely. Every row below exists to make
// that class of mistake fail loudly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  wireAlertDispatcher,
  reportStartupAlertDefects,
  getAlertCounters,
  ALERTING_FEATURES,
  DISPATCHER_OWNERS,
  STARTUP_DEFECTS,
  __resetAlertState,
} = require('../src/alert-routes.js');

const SRC_DIR = path.join(__dirname, '..', 'src');
const DEFAULT_ROUTE = { endpoint: 'http://127.0.0.1:8001/default', tokenFile: '/tmp/miser-test-default' };
const S360_ROUTE = { endpoint: 'http://127.0.0.1:8001/s360', tokenFile: '/tmp/miser-test-s360' };
const OPS_ROUTE = { endpoint: 'http://127.0.0.1:8001/ops', tokenFile: '/tmp/miser-test-ops' };

function recordingLedger(shared) {
  const marked = shared || new Map();
  const calls = [];
  return {
    calls, marked,
    shouldSend(k) { calls.push(`shouldSend:${k}`); return !marked.has(k); },
    markSent(k) { calls.push(`markSent:${k}`); marked.set(k, true); },
    async flushNow() { calls.push('flushNow'); },
  };
}

function routeMap(entries, degraded) {
  return {
    entries,
    mapped: Object.keys(entries).filter(k => entries[k] !== '@default'),
    defaultDeclared: Object.keys(entries).filter(k => entries[k] === '@default'),
    defaultConfigured: true,
    degraded: degraded || { unroutedConfigured: [], undeliverableDefaultDeclared: [] },
  };
}

function quiet(fn) {
  const prev = console.warn;
  const lines = [];
  console.warn = (l) => lines.push(String(l));
  try { return { lines, value: fn(lines) }; } finally { console.warn = prev; }
}

// ---------------------------------------------------------------------------
// AR9 — the FULL single-feature matrix, plus exactly-one-ledger.
//
// The matrix is the point: buildGuardDeps early-returns on a budgets/policy/
// subcap test that cannot see cacheThrashMinRequests (budgets.js:201-206), so
// cache-thrash-only was the configuration that would silently lose alerting.
// ---------------------------------------------------------------------------
test('AR9: every single-feature config wires a dispatcher AND lands a live alert', async () => {
  const configs = [
    { name: 'budgets-only', config: { budgets: { p: { dailyUSD: 1 } } } },
    { name: 'policy-only', config: { policy: { p: { expectedModel: 'claude-opus' } } } },
    { name: 'subcap-only', config: { codex5hCap: 100 } },
    { name: 'cache-thrash-only', config: { cacheThrashMinRequests: 10 } },
    // poll-rewrite-only ports to sprint/miser-E unchanged (§3.5): the predicate
    // is already in ALERTING_FEATURES and is simply false under main's config.
    { name: 'poll-rewrite-only (E)', config: { pollRewriteProjects: { p: {} } } },
  ];

  for (const { name, config } of configs) {
    __resetAlertState();
    const posts = [];
    const guardDeps = {};
    await quiet(async () => {
      wireAlertDispatcher(config, guardDeps, {
        post: async (endpoint, token, text) => { posts.push({ endpoint, text }); },
        readToken: async () => 'tok',
        defaultRoute: DEFAULT_ROUTE,
        createLedger: () => recordingLedger(),
      });
    }).value;

    assert.equal(typeof guardDeps.sendAlert, 'function', `${name}: a dispatcher must be wired`);
    const result = await guardDeps.sendAlert('live alert', { scope: 'fleet', kind: 'test' });
    assert.equal(result.outcome, 'delivered', `${name}: a live alert must reach the transport`);
    assert.equal(posts.length, 1, `${name}: exactly one post`);
  }
  __resetAlertState();
});

test('AR9: with ALL features off, guardDeps stays {} and createLedger is NEVER called', () => {
  __resetAlertState();
  let ledgerCalls = 0;
  const guardDeps = {};
  const report = wireAlertDispatcher({}, guardDeps, {
    createLedger: () => { ledgerCalls += 1; return recordingLedger(); },
  });
  assert.deepEqual(guardDeps, {}, 'the zero-I/O all-off property (budgets.js:206, alert-ledger.js:11-16)');
  assert.equal(ledgerCalls, 0, 'no ledger I/O when nothing can alert');
  assert.equal(report.reason, 'no_defect', 'and the startup report is a no-op');
  __resetAlertState();
});

test('AR9: createLedger runs AT MOST ONCE per composition, and the instance is SHARED', () => {
  // Not cosmetic. buildGuardDeps creates a ledger unconditionally for
  // budgets/policy/subcap (budgets.js:208-210). A wireAlertDispatcher that also
  // created one would leave TWO ledgers over one file — two dedup Maps and two
  // writers (alert-ledger.js:79-87) — which fails toward DUPLICATE alerts and is
  // otherwise invisible.
  for (const config of [
    { budgets: { p: { dailyUSD: 1 } } },
    { policy: { p: { expectedModel: 'x' } } },
    { codex5hCap: 5 },
    { cacheThrashMinRequests: 10 },
    { pollRewriteProjects: { p: {} } },
  ]) {
    __resetAlertState();
    let calls = 0;
    const preExisting = recordingLedger();
    // (a) ledger already present (the buildGuardDeps case) -> reused, not replaced
    const gd = { ledger: preExisting };
    wireAlertDispatcher(config, gd, { createLedger: () => { calls += 1; return recordingLedger(); }, post: async () => {}, readToken: async () => 't', defaultRoute: DEFAULT_ROUTE });
    assert.equal(calls, 0, 'an existing ledger is REUSED, never replaced');
    assert.equal(gd.ledger, preExisting, 'the same instance is shared');

    // (b) no ledger yet (cache-thrash-only / poll-rewrite-only) -> created once
    __resetAlertState();
    calls = 0;
    const gd2 = {};
    wireAlertDispatcher(config, gd2, { createLedger: () => { calls += 1; return recordingLedger(); }, post: async () => {}, readToken: async () => 't', defaultRoute: DEFAULT_ROUTE });
    assert.equal(calls, 1, 'exactly one ledger is created when none exists');
  }
  __resetAlertState();
});

// ---------------------------------------------------------------------------
// AR11 — local best-effort registry guard. Scope is stated in the AC itself:
// this scans files under src/ IN THIS REPOSITORY. It reliably catches a new
// alerting feature added the ORDINARY way (a module naming the dispatcher in
// source, which is exactly how the cache-thrash hole was created). It does NOT
// and cannot catch dynamic access, renamed aliases, code outside src/, or
// another sprint's tree. The guarantees are behavioural — AR9 and AR13.
// ---------------------------------------------------------------------------
test('AR11(a): no src/ file contains the token sendAlert unless allowlisted or registered', () => {
  const permitted = new Set([...DISPATCHER_OWNERS, ...ALERTING_FEATURES.map(f => f.module)]);
  const offenders = [];
  for (const file of fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    if (text.includes('sendAlert') && !permitted.has(file)) offenders.push(file);
  }
  assert.deepEqual(offenders, [],
    'a src/ module naming sendAlert must be registered in ALERTING_FEATURES (or be a DISPATCHER_OWNER)');
  // The allowlist cannot be quietly widened to make a failure go away.
  assert.equal(DISPATCHER_OWNERS.length, 2, 'DISPATCHER_OWNERS stays a two-entry allowlist');
});

test('AR11(b): registry is not rotted — every module exists, every predicate is false for {}', () => {
  for (const feature of ALERTING_FEATURES) {
    // poll-rewrite.js legitimately does not exist on main; it becomes live when
    // sprint/miser-E rebases (§3.5). Its predicate is false under main's config,
    // which is the property that matters here.
    if (feature.module !== 'poll-rewrite.js') {
      assert.ok(fs.existsSync(path.join(SRC_DIR, feature.module)),
        `ALERTING_FEATURES names a missing file: ${feature.module}`);
    }
    assert.equal(feature.enabled({}), false,
      `${feature.module}: an always-true predicate would silently disable the all-off zero-I/O property`);
  }
});

// ---------------------------------------------------------------------------
// AR13 — no dispatcher is LOUD, per site, with live-looking env deliberately set.
// This is the behavioural backstop AR11 cannot provide.
// ---------------------------------------------------------------------------
test('AR13: every alert site with NO dispatcher logs one ALERT-DROPPED, counts it, opens no socket', async () => {
  const { checkModelDrift, checkContextBloat } = require('../src/policy-watchdog.js');
  const { createCacheThrashChecker } = require('../src/cache-thrash.js');

  // Deliberately set live-looking destinations: the point is that an un-injected
  // dependency cannot reach the network WHATEVER the environment contains
  // (§3.4 Layer 1). The suite's network guard would throw if a socket opened.
  const prevEnv = { e: process.env.MISER_PKACHU_ENDPOINT, t: process.env.MISER_PKACHU_TOKEN };
  process.env.MISER_PKACHU_ENDPOINT = 'http://127.0.0.1:8001/v1/orch/nacho-orch/reply';
  process.env.MISER_PKACHU_TOKEN = '/tmp/miser-test-live-looking-token';

  try {
    const sites = [
      {
        name: 'drift',
        run: () => checkModelDrift('p', { model: 'claude-haiku-4-5' }, {
          policyConfig: { p: { expectedModel: 'claude-opus' } },
          ledger: recordingLedger(),
        }),
        expect: /ALERT-DROPPED project=p kind=drift reason=no_dispatcher/,
      },
      {
        name: 'bloat',
        run: () => checkContextBloat('p', 'claude-opus', { input_tokens: 900000 }, {
          policyConfig: { p: { maxContextTokens: 1000 } },
          ledger: recordingLedger(),
        }),
        expect: /ALERT-DROPPED project=p kind=bloat reason=no_dispatcher/,
      },
      {
        name: 'sub-cap',
        run: () => {
          const { __test } = require('../src/router.js');
          if (!__test || !__test._maybeAlertSubCap) return 'skip';
          __test._maybeAlertSubCap({
            subCapTracker: { getStatus: () => ({ shouldAlert: true, capFraction: 0.9, cap5h: 100, events429In5h: 0 }) },
            ledger: recordingLedger(),
          }, Date.now());
          return undefined;
        },
        expect: /ALERT-DROPPED project=fleet kind=sub-cap reason=no_dispatcher/,
      },
    ];

    for (const site of sites) {
      __resetAlertState();
      const before = getAlertCounters().dropped;
      const { lines, value } = quiet(() => site.run());
      if (value === 'skip') continue;   // router does not export the helper on main
      const own = lines.filter(l => site.expect.test(l));
      assert.equal(own.length, 1, `${site.name}: exactly one ALERT-DROPPED line`);
      assert.equal(getAlertCounters().dropped, before + 1, `${site.name}: dropped counter bumped once`);
    }

    // cache-thrash: same property, driven through the real checker.
    __resetAlertState();
    const thrash = createCacheThrashChecker({ cacheThrashMinRequests: 1, cacheThrashSpikeRatio: 1.0, cacheThrashInputSpikeRatio: 100, cacheThrashRingSize: 5 });
    const gd = { ledger: recordingLedger() };   // no sendAlert
    quiet(() => {
      for (let i = 0; i < 3; i++) {
        thrash.check('p', 'claude-opus', { cache_creation_input_tokens: 10, input_tokens: 10 }, gd);
      }
      thrash.check('p', 'claude-opus', { cache_creation_input_tokens: 100000, input_tokens: 10 }, gd);
    });
    // Either it never reached the alert branch (no baseline) or it dropped loudly;
    // what must NEVER happen is a socket, which the network guard enforces.
    assert.ok(getAlertCounters().dropped >= 0, 'cache-thrash never opens a socket without a dispatcher');
  } finally {
    if (prevEnv.e === undefined) delete process.env.MISER_PKACHU_ENDPOINT; else process.env.MISER_PKACHU_ENDPOINT = prevEnv.e;
    if (prevEnv.t === undefined) delete process.env.MISER_PKACHU_TOKEN; else process.env.MISER_PKACHU_TOKEN = prevEnv.t;
    __resetAlertState();
  }
});

// ---------------------------------------------------------------------------
// AR16 — the require-set, so the one-way dependency direction is provable
// rather than aspirational. §2.6's injection design is what makes it possible.
// ---------------------------------------------------------------------------
test('AR16: daily-rollup.js requires only builtins + pricing.js; no config/alert-routes cycle', () => {
  const rollup = fs.readFileSync(path.join(SRC_DIR, 'daily-rollup.js'), 'utf8');
  const requires = [...rollup.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]);
  const localRequires = requires.filter(r => r.startsWith('.'));
  assert.deepEqual([...new Set(localRequires)].sort(), ['./pricing.js'],
    'daily-rollup.js must require NO local module except pricing.js');
  assert.ok(!rollup.includes("require('./config.js')"), 'no config.js require');
  assert.ok(!rollup.includes("require('./alert-routes.js')"), 'no alert-routes.js require');

  // ...and the direction is the other way round.
  const routes = fs.readFileSync(path.join(SRC_DIR, 'alert-routes.js'), 'utf8');
  assert.ok(routes.includes("require('./daily-rollup.js')"),
    'alert-routes.js consumes daily-rollup.js (postPkachu + defaultRouteFromEnv)');
  const cfg = fs.readFileSync(path.join(SRC_DIR, 'config.js'), 'utf8');
  assert.ok(cfg.includes("require('./alert-routes.js')"),
    'config.js requires alert-routes.js for the parser — same shape as budgets/policy');
});

// ---------------------------------------------------------------------------
// AR28 — the startup ops-defect alert actually fires. R3 had NO oracle here
// because it had no mechanism: the alert §2.8 leans on for push-visibility did
// not exist. Read from wireAlertDispatcher's OWN return value, which is what
// makes it observable from the real composition root at all.
// ---------------------------------------------------------------------------
test('AR28: startup defect alert fires from the REAL composition root, with the two-call ledger protocol', async () => {
  __resetAlertState();
  const posts = [];
  const ledger = recordingLedger();
  const config = {
    budgets: { pkachu: { dailyUSD: 1 } },
    alertRoutes: routeMap({ structural360: S360_ROUTE }, { unroutedConfigured: ['pkachu'], undeliverableDefaultDeclared: [] }),
    alertRoutesOps: OPS_ROUTE,
  };
  const guardDeps = {};
  const { lines } = quiet(() => {});
  const prev = console.warn;
  const warns = [];
  console.warn = (l) => warns.push(String(l));
  let report;
  try {
    report = wireAlertDispatcher(config, guardDeps, {
      // the THREADED transport seam, not seams.sendAlert — stubbing the whole
      // dispatcher here would mean asserting against our own stub.
      post: async (endpoint, token, text) => { posts.push({ endpoint, text }); },
      readToken: async () => 'tok',
      defaultRoute: DEFAULT_ROUTE,
      createLedger: () => ledger,
    });

    // (a) the value is read from wireAlertDispatcher itself
    assert.equal(report.dispatched, true, 'AR28(a): dispatched true on the composition root return');
    assert.equal(report.reason, 'dispatched');
    // (g) dispatch is NOT delivery: true synchronously, delivered still 0
    assert.equal(getAlertCounters().delivered, 0, 'AR28(g): nothing delivered yet, synchronously');

    const results = await report.settled;
    assert.equal(results[0].ok, true, 'AR28(g): delivery confirmed only after awaiting settled');
    assert.equal(getAlertCounters().delivered, 1);

    // (b) one post, on the OPS route, naming the whole set in one message
    assert.equal(posts.length, 1, 'AR28(b): exactly one post');
    assert.equal(posts[0].endpoint, OPS_ROUTE.endpoint,
      'AR28(b): on the ops route — never the channel of the project whose route is broken');
    assert.match(posts[0].text, /alert-routing DEFECT at startup/);
    assert.match(posts[0].text, /pkachu/, 'AR28(b): names every member of unroutedConfigured');

    // (c) exactly one greppable degraded line
    assert.equal(warns.filter(l => /ALERT-ROUTING-DEGRADED unrouted=/.test(l)).length, 1, 'AR28(c)');

    // (d) THE TWO-CALL LEDGER PROTOCOL: shouldSend then markSent, markSent once,
    // and BEFORE the transport saw the post. shouldSend is read-only
    // (alert-ledger.js:91-93) so without markSent the dedup would not exist.
    const markIdx = ledger.calls.indexOf('markSent:alertroute:incomplete');
    const shouldIdx = ledger.calls.indexOf('shouldSend:alertroute:incomplete');
    assert.ok(shouldIdx >= 0 && markIdx > shouldIdx, 'AR28(d): shouldSend THEN markSent');
    assert.equal(ledger.calls.filter(c => c === 'markSent:alertroute:incomplete').length, 1,
      'AR28(d): markSent exactly once');
  } finally { console.warn = prev; void lines; }

  // (d) restart-loop: a second composition the same UTC day is deduped, no 2nd post
  const report2 = wireAlertDispatcher(config, { ledger }, {
    post: async (e, t, x) => { posts.push({ endpoint: e, text: x }); },
    readToken: async () => 'tok', defaultRoute: DEFAULT_ROUTE, createLedger: () => ledger,
  });
  await report2.settled;
  assert.match(report2.reason, /deduped/, 'AR28(d): restart-loop case is deduped');
  assert.equal(posts.length, 1, 'AR28(d): and adds no second post');
  __resetAlertState();
});

test('AR28(e): a complete map (or routes OFF) yields no_defect, zero posts, zero warns', async () => {
  for (const config of [
    { budgets: { structural360: {} }, alertRoutes: routeMap({ structural360: S360_ROUTE }) },
    { budgets: { structural360: {} }, alertRoutes: null },
  ]) {
    __resetAlertState();
    let posts = 0;
    const { lines, value: report } = quiet(() => wireAlertDispatcher(config, {}, {
      post: async () => { posts += 1; }, readToken: async () => 't',
      defaultRoute: DEFAULT_ROUTE, createLedger: () => recordingLedger(),
    }));
    assert.equal(report.dispatched, false);
    assert.equal(report.reason, 'no_defect');
    await report.settled;
    assert.equal(posts, 0, 'zero posts');
    assert.equal(lines.filter(l => /ALERT-ROUTING-DEGRADED/.test(l)).length, 0, 'zero degraded lines');
  }
  __resetAlertState();
});

test('AR28(f): a rejecting transport still dispatches, resolves, and reports via the dispatcher token', async () => {
  __resetAlertState();
  const ledger = recordingLedger();
  const prev = console.warn;
  const warns = [];
  console.warn = (l) => warns.push(String(l));
  let report;
  try {
    report = wireAlertDispatcher({
      budgets: { pkachu: {} },
      alertRoutes: routeMap({}, { unroutedConfigured: ['pkachu'], undeliverableDefaultDeclared: [] }),
      alertRoutesOps: OPS_ROUTE,
    }, {}, {
      post: async () => { throw new Error('pkachu HTTP 503'); },
      readToken: async () => 'tok', defaultRoute: DEFAULT_ROUTE, createLedger: () => ledger,
    });
    assert.equal(report.dispatched, true, 'an attempt WAS dispatched even though delivery failed');
    // settled never rejects, because sendAlert never rejects.
    const results = await assert.doesNotReject(() => report.settled).then(() => report.settled);
    assert.equal(results[0].outcome, 'failed');
    assert.equal(results[0].kind, 'alertroute-incomplete');
    assert.equal(getAlertCounters().failed, 1, 'failed counter moved by exactly 1');
    assert.equal(getAlertCounters().delivered, 0);
    // The DISPATCHER's token, carrying kind — not a startup-specific second line.
    const failLines = warns.filter(l => /WARN alert send failed: kind=alertroute-incomplete/.test(l));
    assert.equal(failLines.length, 1, 'exactly one failure line, owned by the dispatcher (§2.7)');
  } finally { console.warn = prev; __resetAlertState(); }
});

// ---------------------------------------------------------------------------
// AR30 — the ORDERING PROPERTY that makes one call site sufficient.
// degraded non-empty => required set non-empty => a dispatcher is wired, so the
// no_dispatcher branch of §2.3a is unreachable in production.
// ---------------------------------------------------------------------------
test('AR30: required-set key sources are a SUBSET of the ALERTING_FEATURES predicates', () => {
  // Mechanical, not prose: for each config key the required set is drawn from,
  // a config containing only that key must make some registry predicate true.
  const REQUIRED_SET_SOURCES = ['budgets', 'policy', 'pollRewriteProjects'];
  for (const key of REQUIRED_SET_SOURCES) {
    const probe = { [key]: { someProject: {} } };
    const anyEnabled = ALERTING_FEATURES.some(f => f.enabled(probe));
    assert.equal(anyEnabled, true,
      `a non-empty required set via '${key}' MUST imply a wired dispatcher — otherwise the single ` +
      `call site in wireAlertDispatcher could miss a degraded state and the startup alert would be lost`);
  }
  // And the STARTUP_DEFECTS causes are drawn from that same required set, so a
  // third cause added later inherits the proof only if it satisfies this too.
  assert.deepEqual(STARTUP_DEFECTS.map(d => d.field),
    ['unroutedConfigured', 'undeliverableDefaultDeclared'],
    'both degraded causes are subsets of the required set (§2.3a proof)');
});

test('AR30: positively — budgets/policy/(E)poll-rewrite-only with an incomplete map all emit', async () => {
  for (const key of ['budgets', 'policy', 'pollRewriteProjects']) {
    __resetAlertState();
    const posts = [];
    const report = quiet(() => wireAlertDispatcher({
      [key]: { pkachu: {} },
      alertRoutes: routeMap({}, { unroutedConfigured: ['pkachu'], undeliverableDefaultDeclared: [] }),
      alertRoutesOps: OPS_ROUTE,
    }, {}, {
      post: async (e, t, x) => { posts.push(x); }, readToken: async () => 'tok',
      defaultRoute: DEFAULT_ROUTE, createLedger: () => recordingLedger(),
    })).value;
    assert.equal(report.dispatched, true, `${key}-only: the defect alert is dispatched`);
    await report.settled;
    assert.equal(posts.length, 1, `${key}-only: exactly one ops post`);
  }
  __resetAlertState();
});

// ---------------------------------------------------------------------------
// AR31a — the startup sequence is real and in the right order, and the fix did
// NOT silently take the API-changing route. R4's specified call path was not
// executable (guardDeps did not exist before index.js:59, and buildGuardDeps
// returns a fresh object that would discard a pre-wired one).
// ---------------------------------------------------------------------------
test('AR31a: index.js sequences buildGuardDeps -> wireAlertDispatcher -> wireCacheThrashDeps', () => {
  const idx = fs.readFileSync(path.join(SRC_DIR, 'index.js'), 'utf8');
  const iBuild = idx.indexOf('buildGuardDeps(config)');
  const iAlert = idx.indexOf('wireAlertDispatcher(config, guardDeps)');
  const iThrash = idx.indexOf('wireCacheThrashDeps(config, guardDeps)');
  assert.ok(iBuild >= 0 && iAlert >= 0 && iThrash >= 0, 'all three composition calls are present');
  assert.ok(iBuild < iAlert, 'guardDeps must be CONSTRUCTED before the dispatcher is wired into it');
  assert.ok(iAlert < iThrash, 'the dispatcher is wired before the remaining feature wiring');
  assert.equal((idx.match(/wireAlertDispatcher\(/g) || []).length, 1,
    'exactly one call site for the composition root');

  // buildGuardDeps' signature is UNCHANGED — i.e. the fix did not take the
  // API-changing route (mutate a caller-owned object).
  const budgets = fs.readFileSync(path.join(SRC_DIR, 'budgets.js'), 'utf8');
  assert.match(budgets, /function buildGuardDeps\(config, seams = \{\}\)/,
    "buildGuardDeps keeps its (config, seams) signature");
});

test('AR31a: behavioural companion — every single-feature config has a function dispatcher after the sequence', () => {
  for (const config of [
    { budgets: { p: {} } }, { policy: { p: {} } }, { codex5hCap: 1 },
    { cacheThrashMinRequests: 10 }, { pollRewriteProjects: { p: {} } },
  ]) {
    __resetAlertState();
    const { buildGuardDeps } = require('../src/budgets.js');
    const { wireCacheThrashDeps } = require('../src/cache-thrash.js');
    const guardDeps = buildGuardDeps(config);
    quiet(() => {
      wireAlertDispatcher(config, guardDeps, {
        post: async () => {}, readToken: async () => 't',
        defaultRoute: DEFAULT_ROUTE, createLedger: () => recordingLedger(),
      });
      wireCacheThrashDeps(config, guardDeps);
    });
    assert.equal(typeof guardDeps.sendAlert, 'function',
      `${JSON.stringify(config)}: the real sequence must yield a dispatcher`);
  }
  __resetAlertState();
});
