'use strict';

// AR29 — destination-class contract. `kind` is intentionally varied in every
// row and asserted not to affect the resolved route.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAlertRoutes,
  createAlertDispatcher,
  getAlertCounters,
  __resetAlertState,
} = require('../src/alert-routes.js');

const DEFAULT_ROUTE = { endpoint: 'http://127.0.0.1:8001/default', tokenFile: '/tmp/miser-test-default' };
const S360_ROUTE = { endpoint: 'http://127.0.0.1:8001/s360', tokenFile: '/tmp/miser-test-s360' };
const OPS_ROUTE = { endpoint: 'http://127.0.0.1:8001/ops', tokenFile: '/tmp/miser-test-ops' };

// Built by the real parser rather than hand-rolled — see the same note in
// test/alert-routing-failclosed.test.js.
function routeMap(entries, extra = {}) {
  const parsed = parseAlertRoutes({
    MISER_ALERT_ROUTES: JSON.stringify(entries),
    MISER_PKACHU_ENDPOINT: DEFAULT_ROUTE.endpoint,
    MISER_PKACHU_TOKEN: DEFAULT_ROUTE.tokenFile,
  }, {});
  return { ...parsed, ...extra };
}

function recordingLedger() {
  const marked = new Map();
  return {
    shouldSend(key) { return !marked.has(key); },
    markSent(key) { marked.set(key, true); },
  };
}

async function captureWarns(fn) {
  const prev = console.warn;
  const warns = [];
  console.warn = (line) => warns.push(String(line));
  try {
    const value = await fn(warns);
    return { warns, value };
  } finally {
    console.warn = prev;
  }
}

async function drive(config, opts) {
  const posts = [];
  const sendAlert = createAlertDispatcher(config, {
    post: async (endpoint, token, text) => { posts.push({ endpoint, text }); },
    readToken: async () => 'tok',
    defaultRoute: DEFAULT_ROUTE,
    ledger: recordingLedger(),
    nowFn: () => new Date('2026-08-04T12:00:00Z'),
  });
  const { warns, value } = await captureWarns(() => sendAlert('scope contract text', opts));
  await new Promise(resolve => setImmediate(resolve));
  return { result: value, posts, warns };
}

test('AR29(a-b): project scope routes to project; all fleet spellings resolve identically; kind has no effect', async () => {
  const config = { alertRoutes: routeMap({ structural360: S360_ROUTE }), alertRoutesOps: OPS_ROUTE };

  for (const kind of ['budget-cap', 'unpriced-models']) {
    __resetAlertState();
    const project = await drive(config, { project: 'structural360', kind });
    assert.equal(project.result.outcome, 'delivered');
    assert.equal(project.result.endpoint, S360_ROUTE.endpoint, `kind=${kind}: project scope uses project route`);

    const fleetRows = [
      await drive(config, { kind }),
      await drive(config, { project: null, kind }),
      await drive(config, { scope: 'fleet', kind }),
    ];
    assert.deepEqual(
      fleetRows.map(r => r.result.endpoint),
      [DEFAULT_ROUTE.endpoint, DEFAULT_ROUTE.endpoint, DEFAULT_ROUTE.endpoint],
      `kind=${kind}: {}, {project:null}, and {scope:'fleet'} are identical`,
    );
  }
  __resetAlertState();
});

test('AR29(c): ops scope uses ops route when set, default when unset, and is never withheld', async () => {
  for (const [name, config, expected] of [
    ['ops route set', { alertRoutes: routeMap({ structural360: S360_ROUTE }), alertRoutesOps: OPS_ROUTE }, OPS_ROUTE.endpoint],
    ['ops route unset', { alertRoutes: routeMap({ structural360: S360_ROUTE }), alertRoutesOps: null }, DEFAULT_ROUTE.endpoint],
  ]) {
    __resetAlertState();
    const row = await drive(config, { scope: 'ops', kind: `ops-${name}` });
    assert.equal(row.result.outcome, 'delivered', name);
    assert.equal(row.result.endpoint, expected, name);
    assert.equal(getAlertCounters().withheld, 0, `${name}: ops is never withheld`);
  }
  __resetAlertState();
});

test('AR29(d-e): explicit ops/fleet scope wins over project and logs one scope-conflict warn', async () => {
  for (const row of [
    { opts: { scope: 'ops', project: 'pkachu', kind: 'ops-conflict' }, endpoint: OPS_ROUTE.endpoint, conflict: /scope=ops project=pkachu/ },
    { opts: { scope: 'fleet', project: 'pkachu', kind: 'fleet-conflict' }, endpoint: DEFAULT_ROUTE.endpoint, conflict: /scope=fleet project=pkachu/ },
  ]) {
    __resetAlertState();
    const out = await drive(
      { alertRoutes: routeMap({ structural360: S360_ROUTE, pkachu: S360_ROUTE }), alertRoutesOps: OPS_ROUTE },
      row.opts,
    );
    assert.equal(out.result.outcome, 'delivered');
    assert.equal(out.result.endpoint, row.endpoint, `${row.opts.kind}: explicit scope wins`);
    assert.equal(out.warns.filter(l => /ALERT-SCOPE-CONFLICT/.test(l) && row.conflict.test(l)).length, 1);
  }
  __resetAlertState();
});

test('AR29(f): route-shaped string in project slot collapses to @invalid and is withheld', async () => {
  __resetAlertState();
  const posts = [];
  const sendAlert = createAlertDispatcher(
    { alertRoutes: routeMap({ structural360: S360_ROUTE }), alertRoutesOps: OPS_ROUTE },
    {
      post: async (endpoint, token, text) => { posts.push({ endpoint, text }); },
      readToken: async () => 'tok',
      defaultRoute: DEFAULT_ROUTE,
      ledger: recordingLedger(),
      nowFn: () => new Date('2026-08-04T12:00:00Z'),
    },
  );

  const { warns, value } = await captureWarns(() => sendAlert('cohesion prior spelling text', {
    project: 'fleet ops route',
    kind: 'unpriced-models',
  }));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(value.outcome, 'withheld');
  assert.equal(value.project, '@invalid');
  assert.equal(getAlertCounters().withheld, 1);
  assert.equal(posts.filter(p => p.text === 'cohesion prior spelling text').length, 0,
    'the original alert text is withheld, not delivered by accident');
  assert.equal(posts.length, 1, 'only the distinct ops defect post is emitted');
  assert.equal(posts[0].endpoint, OPS_ROUTE.endpoint);
  assert.match(posts[0].text, /INVALID project names/);
  assert.equal(warns.filter(l => /ALERT-WITHHELD project=@invalid kind=unpriced-models/.test(l)).length, 1);
  __resetAlertState();
});
