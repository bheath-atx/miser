'use strict';

// AR1 / AR2 / AR4 / AR6 / AR7(a-c) / AR22 / AR26 / AR27 / AR31 parser and
// resolver oracles. These stay below the public alert-routes/config seams:
// passed env objects, parsed route maps, resolver outputs, and health shape.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAlertRoutes,
  parseOpsRoute,
  buildFailurePolicy,
  validateRouteValue,
  resolveRoute,
  createAlertDispatcher,
  alertRoutingHealth,
  reportStartupAlertDefects,
  STARTUP_DEFECTS,
  __resetAlertState,
} = require('../src/alert-routes.js');
const { isValidProjectName } = require('../src/routing.js');
const { validateStartupConfig } = require('../src/config.js');

const DEFAULT_ROUTE = { endpoint: 'http://127.0.0.1:8001/default', tokenFile: '/tmp/miser-test-default' };
const S360_ROUTE = { endpoint: 'http://127.0.0.1:8001/s360', tokenFile: '/tmp/miser-test-s360' };
const OPS_ROUTE = { endpoint: 'http://127.0.0.1:8001/ops', tokenFile: '/tmp/miser-test-ops' };

function rawMap(obj) {
  return JSON.stringify(obj);
}

function routesEnv(map, extra = {}) {
  return { MISER_ALERT_ROUTES: rawMap(map), ...extra };
}

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

// Not an AC — a regression guard for a defect found while reviewing this lane.
// src/alert-routes.js shipped a raw NUL and a raw 0x1f inside the /[\x00-\x1f\x7f]/
// character class (written as bytes rather than escapes). It ran correctly, but
// grep classifies such a file as binary and skips it silently, so `grep -rn
// createAlertDispatcher src/` returned nothing from the 662-line module that
// defines it. Auditors and every grep-based sweep read that as "not there".
test('src/ is greppable: no source file carries raw control bytes', () => {
  const fs = require('node:fs');
  const dir = require('node:path').join(__dirname, '..', 'src');
  const offenders = [];
  for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const buf = fs.readFileSync(require('node:path').join(dir, name));
    // Everything below 0x20 except \t \n \r, plus DEL.
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f) {
        offenders.push(`${name}@${i}:0x${b.toString(16).padStart(2, '0')}`);
        break;
      }
    }
  }
  assert.deepEqual(offenders, [], 'write control characters as escapes (\\x00), not raw bytes');
});

test('AR1: parseAlertRoutes returns null for unset, empty, and empty-object route config', () => {
  assert.equal(parseAlertRoutes({}, {}), null, 'unset is the exclusive routes-OFF signal');
  assert.equal(parseAlertRoutes({ MISER_ALERT_ROUTES: '' }, {}), null, 'empty string is OFF');
  assert.equal(parseAlertRoutes({ MISER_ALERT_ROUTES: '   ' }, {}), null, 'blank string is OFF');
  assert.equal(parseAlertRoutes({ MISER_ALERT_ROUTES: '{}' }, {}), null, 'empty map is OFF, never {}');
});

test('AR2/AR22: malformed and unsafe route values are fatal for main map and ops map', () => {
  const cases = [
    ['bad key', routesEnv({ 'a b': S360_ROUTE }), /a b.*valid project name/i],
    ['reserved key', { MISER_ALERT_ROUTES: '{"__proto__":{"endpoint":"http://127.0.0.1:8001/x","tokenFile":"/tmp/t"}}' }, /__proto__.*reserved/i],
    ['missing sub-key', routesEnv({ structural360: { endpoint: S360_ROUTE.endpoint } }), /structural360.*exactly the keys/i],
    ['unknown sub-key', routesEnv({ structural360: { endpoint: S360_ROUTE.endpoint, tokenFile: S360_ROUTE.tokenFile, extra: true } }), /structural360.*exactly the keys/i],
    ['non-http endpoint', routesEnv({ structural360: { endpoint: 'file:///tmp/x', tokenFile: S360_ROUTE.tokenFile } }), /structural360.*protocol/i],
    ['unparseable endpoint', routesEnv({ structural360: { endpoint: 'http://[', tokenFile: S360_ROUTE.tokenFile } }), /structural360.*parseable URL/i],
    ['relative tokenFile', routesEnv({ structural360: { endpoint: S360_ROUTE.endpoint, tokenFile: 'relative-token' } }), /structural360.*absolute path/i],
    ['remote endpoint', routesEnv({ structural360: { endpoint: 'https://example.com/hook', tokenFile: S360_ROUTE.tokenFile } }), /structural360.*not loopback/i],
  ];

  for (const [name, env, match] of cases) {
    assert.throws(() => parseAlertRoutes(env, {}), match, `${name}: main route map throws`);
  }

  assert.doesNotThrow(
    () => parseAlertRoutes(routesEnv({ structural360: { endpoint: 'https://example.com/hook', tokenFile: S360_ROUTE.tokenFile } }, { MISER_ALERT_ROUTES_ALLOW_REMOTE: '1' }), {}),
    'ALLOW_REMOTE=1 permits the remote endpoint case',
  );
  assert.doesNotThrow(
    () => parseAlertRoutes(routesEnv({ structural360: S360_ROUTE }), { budgets: { pkachu: {} } }),
    'a missing required entry is degraded, not in the AR2 fatal class',
  );

  for (const [name, env] of cases.slice(2)) {
    const parsedValue = JSON.parse(env.MISER_ALERT_ROUTES).structural360;
    assert.throws(
      () => parseOpsRoute({ MISER_ALERT_ROUTES_OPS: JSON.stringify(parsedValue) }),
      /MISER_ALERT_ROUTES_OPS.*(exactly the keys|protocol|parseable URL|absolute path|not loopback)/i,
      `${name}: ops route uses the same route-value validator`,
    );
  }
  assert.throws(
    () => parseOpsRoute({ MISER_ALERT_ROUTES_OPS: JSON.stringify({ endpoint: 'https://example.com/hook', tokenFile: OPS_ROUTE.tokenFile }) }),
    /MISER_ALERT_ROUTES_OPS.*not loopback/i,
    'ops route is validated even when MISER_ALERT_ROUTES is unset',
  );
});

test('AR2/AR27: double-dash and @ namespace keys are rejected at startup', () => {
  const parsed = parseAlertRoutes(routesEnv({ 'a--b': S360_ROUTE }), {});
  assert.throws(
    () => validateStartupConfig({ alertRoutes: parsed }),
    /a--b.*panel routing/,
    'the shared startup validator owns the -- panel-routing collision for MISER_ALERT_ROUTES',
  );

  for (const name of ['@default', '@invalid', '@overflow', '@ops']) {
    assert.equal(isValidProjectName(name), false, `${name} cannot be a user project`);
    assert.throws(
      () => parseAlertRoutes(routesEnv({ [name]: S360_ROUTE }), {}),
      new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*valid project name`),
      'route-map keys beginning @ are rejected by the same key validation',
    );
  }
});

test('AR4/AR6/AR7(a-b): route resolution uses mapped routes, fleet defaults, and routes-OFF is inert', () => {
  const routes = parseAlertRoutes(routesEnv(
    { structural360: S360_ROUTE, pkachu: '@default' },
    { MISER_PKACHU_ENDPOINT: DEFAULT_ROUTE.endpoint, MISER_PKACHU_TOKEN: DEFAULT_ROUTE.tokenFile },
  ), {});
  const decoyDefault = { endpoint: 'http://127.0.0.1:8001/decoy-default', tokenFile: '/tmp/miser-decoy-default' };

  assert.deepEqual(
    resolveRoute('structural360', { alertRoutes: routes, defaultRoute: decoyDefault }).route,
    S360_ROUTE,
    'AR4: a mapped project beats MISER_PKACHU_* even when both are configured',
  );
  assert.deepEqual(resolveRoute(null, { alertRoutes: routes, defaultRoute: DEFAULT_ROUTE }).route, DEFAULT_ROUTE);
  assert.deepEqual(resolveRoute(undefined, { alertRoutes: routes, defaultRoute: DEFAULT_ROUTE }).route, DEFAULT_ROUTE);
  assert.deepEqual(
    resolveRoute('pkachu', { alertRoutes: routes, defaultRoute: DEFAULT_ROUTE }).route,
    DEFAULT_ROUTE,
    'AR6: a project declared as "@default" resolves to the unprefixed default route',
  );

  for (const project of ['structural360', 'pkachu', 'aetheria', 'fleet ops route']) {
    const off = resolveRoute(project, { alertRoutes: null, defaultRoute: DEFAULT_ROUTE });
    assert.equal(off.kind, 'route', `${project}: routes OFF never withholds`);
    assert.deepEqual(off.route, DEFAULT_ROUTE, `${project}: routes OFF resolves to default`);
  }
  assert.equal(alertRoutingHealth({ alertRoutes: null }).status, 'ok', 'AR7(b): routes OFF is not degraded');
});

test('AR7(c): startup validation accepts the live seven-project budgets/policy set with routes OFF', () => {
  // Transcribed verbatim from the running host on 2026-08-06 via
  // `systemctl --user show miser -p Environment` — NOT a plausible-looking
  // stand-in. AR7(c) is a regression test for the deployed configuration, so
  // invented values would assert nothing about the machine this ships to.
  // Note budgets has 7 projects and policy has 6: `default` carries a budget
  // and no policy, and that asymmetry is part of what is being validated.
  const LIVE_BUDGETS = {
    structural360: { dailyUSD: 900 },
    'nacho-orch': { dailyUSD: 500 },
    pkachu: { dailyUSD: 150 },
    default: { dailyUSD: 120 },
    'termdeck-updates': { dailyUSD: 75 },
    aetheria: { dailyUSD: 60 },
    provenspec: { dailyUSD: 25 },
  };
  const LIVE_POLICY = {
    structural360: { maxContextTokens: 400000 },
    'nacho-orch': { maxContextTokens: 400000 },
    pkachu: { maxContextTokens: 400000 },
    'termdeck-updates': { maxContextTokens: 400000 },
    aetheria: { maxContextTokens: 400000 },
    provenspec: { maxContextTokens: 400000 },
  };
  assert.equal(Object.keys(LIVE_BUDGETS).length, 7, 'the "seven-project" in this AC name is load-bearing');

  assert.doesNotThrow(() => validateStartupConfig({
    budgets: LIVE_BUDGETS,
    policy: LIVE_POLICY,
    alertRoutes: null,
  }));

  // AR7(a) restated against the live project set: routes OFF, every live
  // project resolves to the default route, unprefixed.
  for (const project of Object.keys(LIVE_BUDGETS)) {
    const off = resolveRoute(project, { alertRoutes: null, defaultRoute: DEFAULT_ROUTE });
    assert.equal(off.kind, 'route', `${project}: live project is never withheld with routes OFF`);
    assert.deepEqual(off.route, DEFAULT_ROUTE, `${project}: live project resolves to the unprefixed default`);
  }
});

test('AR22: ops route fallback rows resolve to default, and unset-with-no-default drops loudly', async () => {
  assert.equal(parseOpsRoute({}), null, 'unset ops route falls back to default');
  assert.equal(parseOpsRoute({ MISER_ALERT_ROUTES_OPS: '@default' }), '@default');
  assert.equal(parseOpsRoute({ MISER_ALERT_ROUTES_OPS: '"@default"' }), '@default');

  assert.deepEqual(
    resolveRoute(undefined, { scope: 'ops', alertRoutes: null, opsRoute: '@default', defaultRoute: DEFAULT_ROUTE }).route,
    DEFAULT_ROUTE,
    '"@default" ops route resolves to default',
  );
  assert.deepEqual(
    resolveRoute(undefined, { scope: 'ops', alertRoutes: null, opsRoute: null, defaultRoute: DEFAULT_ROUTE }).route,
    DEFAULT_ROUTE,
    'unset ops route resolves to default',
  );

  __resetAlertState();
  const prev = console.warn;
  const warns = [];
  console.warn = (line) => warns.push(String(line));
  try {
    const sendAlert = createAlertDispatcher(
      { alertRoutes: null, alertRoutesOps: null },
      { post: async () => {}, readToken: async () => 'tok', defaultRoute: null },
    );
    const result = await sendAlert('ops defect', { scope: 'ops', kind: 'alertroute-unmapped' });
    assert.equal(result.outcome, 'dropped');
    assert.match(warns.join('\n'), /ALERT-DROPPED project=@ops kind=alertroute-unmapped reason=no_destination/);
  } finally {
    console.warn = prev;
    __resetAlertState();
  }
});

test('AR26: strictness policy defaults degraded, flips fatal, and malformed entries ignore the switch', () => {
  assert.equal(buildFailurePolicy({}).incomplete_map, 'degraded');
  assert.equal(buildFailurePolicy({ alertRoutesStrict: false }).incomplete_map, 'degraded');
  assert.equal(buildFailurePolicy({ alertRoutesStrict: true }).incomplete_map, 'fatal');

  // The table's return value is NOT the AC. AR26 says an incomplete map throws
  // under MISER_ALERT_ROUTES_STRICT=1, so assert the behaviour: asserting only
  // the three rows above passed for a build in which buildFailurePolicy had no
  // caller at all and the flag changed nothing.
  const incomplete = routesEnv({ structural360: S360_ROUTE });
  assert.doesNotThrow(
    () => parseAlertRoutes(incomplete, { budgets: { structural360: {}, pkachu: {} } }),
    'strict unset: an incomplete map is degraded, not fatal (= AR3)',
  );
  assert.throws(
    () => parseAlertRoutes(incomplete, { budgets: { structural360: {}, pkachu: {} }, alertRoutesStrict: true }),
    /MISER_ALERT_ROUTES is incomplete and MISER_ALERT_ROUTES_STRICT is on.*unrouted=pkachu/s,
    'strict on: the SAME input throws',
  );
  assert.throws(
    () => parseAlertRoutes(routesEnv({ structural360: '@default' }), { budgets: { structural360: {} }, alertRoutesStrict: true }),
    /default-declared-but-unconfigured=structural360/,
    'strict on: degraded cause 2 is fatal too — both causes ask the same table row',
  );
  assert.doesNotThrow(
    () => parseAlertRoutes(incomplete, { budgets: { structural360: {} }, alertRoutesStrict: true }),
    'strict on: a COMPLETE map is unaffected — strictness narrows nothing else',
  );

  assert.doesNotThrow(
    () => parseAlertRoutes(routesEnv({ structural360: S360_ROUTE }), { budgets: { pkachu: {} } }),
    'strict unset: incomplete map remains non-fatal at parser level',
  );
  assert.throws(
    () => parseAlertRoutes(routesEnv({ structural360: { endpoint: 'file:///tmp/x', tokenFile: S360_ROUTE.tokenFile } }), { alertRoutesStrict: false }),
    /protocol/,
    'malformed input throws with strict unset',
  );
  assert.throws(
    () => parseAlertRoutes(routesEnv({ structural360: { endpoint: 'file:///tmp/x', tokenFile: S360_ROUTE.tokenFile } }), { alertRoutesStrict: true }),
    /protocol/,
    'malformed input throws with strict enabled',
  );
});

test('AR31(a-b,d-e): @default only degrades when declared by a required project with no default destination', () => {
  const degraded = parseAlertRoutes(
    routesEnv({ structural360: '@default' }),
    { budgets: { structural360: {} } },
  );
  assert.deepEqual(degraded.degraded.undeliverableDefaultDeclared, ['structural360']);
  assert.equal(alertRoutingHealth({ alertRoutes: degraded }).status, 'degraded');
  assert.equal(alertRoutingHealth({ alertRoutes: degraded }).defaultConfigured, false);

  const healthy = parseAlertRoutes(
    routesEnv(
      { structural360: '@default' },
      { MISER_PKACHU_ENDPOINT: DEFAULT_ROUTE.endpoint, MISER_PKACHU_TOKEN: DEFAULT_ROUTE.tokenFile },
    ),
    { budgets: { structural360: {} } },
  );
  assert.deepEqual(healthy.degraded.undeliverableDefaultDeclared, []);
  assert.equal(alertRoutingHealth({ alertRoutes: healthy }).status, 'ok');
  assert.equal(alertRoutingHealth({ alertRoutes: null }).status, 'ok', 'AR31(d): routes OFF with no default is not degraded');

  const required = new Set(['structural360']);
  for (const name of degraded.degraded.undeliverableDefaultDeclared) {
    assert.equal(required.has(name), true, 'AR31(e): cause 2 is a subset of the required set');
  }
});

test('AR31(a,c): default-missing startup defect has its own unconditional line and ledger key', async () => {
  __resetAlertState();
  const ledger = recordingLedger();
  const posts = [];
  const config = {
    budgets: { structural360: {}, pkachu: {} },
    alertRoutes: parseAlertRoutes(
      routesEnv({ structural360: '@default' }),
      { budgets: { structural360: {}, pkachu: {} } },
    ),
    alertRoutesOps: OPS_ROUTE,
  };

  const prev = console.warn;
  const warns = [];
  console.warn = (line) => warns.push(String(line));
  try {
    const report = reportStartupAlertDefects(config, {
      ledger,
      sendAlert: async (text, opts) => {
        posts.push({ text, opts });
        return { ok: true, outcome: 'delivered', kind: opts.kind };
      },
    });
    await report.settled;

    assert.equal(warns.filter(l => /ALERT-ROUTING-DEGRADED unrouted=pkachu/.test(l)).length, 1);
    assert.equal(warns.filter(l => /ALERT-ROUTING-DEGRADED default-declared-but-unconfigured=structural360/.test(l)).length, 1);
    assert.deepEqual(posts.map(p => p.opts.kind).sort(), ['alertroute-default-missing', 'alertroute-incomplete']);
    assert.deepEqual(
      ledger.calls.filter(c => c.startsWith('markSent:')).sort(),
      ['markSent:alertroute:default-missing', 'markSent:alertroute:incomplete'],
      'AR31(c): two causes produce exactly two distinct ledger keys',
    );
    assert.deepEqual(STARTUP_DEFECTS.map(d => d.key).sort(), ['alertroute:default-missing', 'alertroute:incomplete']);
  } finally {
    console.warn = prev;
    __resetAlertState();
  }
});

// AR10 — the orphaned fallback dispatchers are GONE from src/, asserted as a
// source shape. Added at BUILDER-AUDIT R1: §4 named this file as the oracle and
// no assertion existed. Modelled on test/alert-ledger.test.js:165-169.
//
// This is what stops the old dual-path behaviour creeping back: if either
// fallback token reappears, alerts can be dispatched by something other than
// the single composition root, which is precisely the shape that produced the
// 2026-07-29 misrouting.
test('AR10: no fallback sendAlert token survives anywhere in src/', () => {
  const fs = require('node:fs');
  const p = require('node:path');
  const dir = p.join(__dirname, '..', 'src');
  const offenders = [];
  for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const text = fs.readFileSync(p.join(dir, name), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (line.includes("require('./daily-rollup.js').sendAlert")) offenders.push(`${name}:${i + 1} rollup fallback`);
      if (line.includes('sendAlert: defaultSendAlert')) offenders.push(`${name}:${i + 1} defaultSendAlert`);
    });
  }
  assert.deepEqual(offenders, [], 'the single outbound path is createAlertDispatcher — no fallbacks');
});

// AR26 companion — every axis-C site resolves a REAL policy row.
//
// This exists because of a bug in the axis-C wiring itself: the axis name was
// passed as the literal string 'axis' instead of the variable, so every lookup
// resolved to undefined and every fatal fell through to enforceAxisC's
// "no implemented code path" branch. The full suite stayed green, because that
// branch embeds the original message and the existing regexes still matched.
// Asserting the *absence* of the fallback is what distinguishes "the table said
// fatal" from "the table said nothing and we threw anyway".
test('AR26: each axis-C condition resolves a real table row, not the unimplemented fallback', () => {
  const cases = [
    ['malformed entry', () => parseAlertRoutes(routesEnv({ structural360: { endpoint: 'file:///x', tokenFile: '/tmp/t' } }), {})],
    ['unsafe endpoint', () => parseAlertRoutes(routesEnv({ structural360: { endpoint: 'https://evil.example.com/x', tokenFile: '/tmp/t' } }), {})],
    ['unparseable map', () => parseAlertRoutes({ MISER_ALERT_ROUTES: '{' }, {})],
    ['reserved key', () => parseAlertRoutes({ MISER_ALERT_ROUTES: '{"__proto__":{"endpoint":"http://127.0.0.1:8001/x","tokenFile":"/tmp/t"}}' }, {})],
    ['bad project key', () => parseAlertRoutes(routesEnv({ 'a b': S360_ROUTE }), {})],
    ['malformed ops', () => parseOpsRoute({ MISER_ALERT_ROUTES_OPS: '{' }, {})],
    ['unsafe ops', () => parseOpsRoute({ MISER_ALERT_ROUTES_OPS: JSON.stringify({ endpoint: 'https://evil.example.com/x', tokenFile: '/tmp/t' }) }, {})],
  ];
  for (const [name, fn] of cases) {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    assert.ok(err, `${name}: must be fatal`);
    assert.ok(!/no implemented code path/.test(err.message),
      `${name}: fell through to the unimplemented-policy branch — the axis name did not resolve to a table row`);
  }
});

// AR26 companion #2 — WHICH row fired, per condition.
//
// CODEX-BA-R2 blocker A: the companion above asserts only that no condition
// falls through to the unimplemented branch, which is a per-OUTCOME oracle. It
// stayed green while `unsafe_endpoint` and `malformed_entry` were wired to each
// other's conditions — the non-loopback exfiltration case, the one the row is
// named for, was resolving through malformed_entry, and the tokenFile
// absolute-path case through unsafe_endpoint. Both still threw, so absence-of-
// fallback could not see it.
//
// The oracle here is row IDENTITY: inject a policy whose target row holds a
// sentinel, and the unimplemented-branch message names the row that was
// actually consulted. validateRouteValue takes `policy` as a parameter, so this
// needs no seam that production does not already have.
test('AR26: each condition resolves the SPECIFIC policy row it is documented to use', () => {
  const FATAL = { malformed_entry: 'fatal', unsafe_endpoint: 'fatal', malformed_ops: 'fatal', incomplete_map: 'degraded' };
  const REMOTE = { endpoint: 'https://evil.example.com/x', tokenFile: '/tmp/t' };
  const BAD_TOKEN = { endpoint: 'http://127.0.0.1:8001/x', tokenFile: 'relative' };
  const BAD_PROTO = { endpoint: 'file:///x', tokenFile: '/tmp/t' };
  const BAD_KEYS = { endpoint: 'http://127.0.0.1:8001/x' };

  // Which row does this condition consult? Sentinel the candidate row; if that
  // is the row consulted, enforceAxisC names it in the fallback message.
  function rowFor(value, expected, axis = 'malformed_entry') {
    const policy = { ...FATAL, [expected]: 'SENTINEL' };
    try {
      validateRouteValue('lbl', value, false, policy, axis);
      return 'NO THROW';
    } catch (e) {
      const m = e.message.match(/policy (\w+)=/);
      return m ? m[1] : 'a-different-row';
    }
  }

  // Map entries: the exfiltration case is unsafe_endpoint's whole reason to
  // exist; everything else about a malformed statement is malformed_entry.
  assert.equal(rowFor(REMOTE, 'unsafe_endpoint'), 'unsafe_endpoint',
    'the non-loopback case must consult unsafe_endpoint, not malformed_entry');
  assert.equal(rowFor(BAD_TOKEN, 'malformed_entry'), 'malformed_entry',
    'a non-absolute tokenFile is a malformed entry, not an unsafe endpoint');
  assert.equal(rowFor(BAD_PROTO, 'malformed_entry'), 'malformed_entry');
  assert.equal(rowFor(BAD_KEYS, 'malformed_entry'), 'malformed_entry');

  // ...and the two rows are not interchangeable: sentinel the OTHER row and the
  // condition must NOT fall through, i.e. it genuinely reads only its own row.
  assert.equal(rowFor(REMOTE, 'malformed_entry'), 'a-different-row',
    'non-loopback must be unaffected by the malformed_entry row');
  assert.equal(rowFor(BAD_TOKEN, 'unsafe_endpoint'), 'a-different-row',
    'tokenFile must be unaffected by the unsafe_endpoint row');

  // The ops route is governed by its own single row for every condition,
  // including the exfiltration one (§2.5).
  for (const value of [REMOTE, BAD_TOKEN, BAD_PROTO, BAD_KEYS]) {
    assert.equal(rowFor(value, 'malformed_ops', 'malformed_ops'), 'malformed_ops',
      'every ops-route condition consults malformed_ops');
  }
});
