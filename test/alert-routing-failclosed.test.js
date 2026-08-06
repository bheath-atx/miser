'use strict';

// AR5 / AR7(d) / AR23 / AR31(c) runtime fail-closed tests.
// These drive the real dispatcher/proxy with injected transports only; no
// pkachu socket is opened under the preload network guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const os = require('node:os');
const path = require('node:path');

const {
  parseAlertRoutes,
  createAlertDispatcher,
  reportStartupAlertDefects,
  getAlertCounters,
  __resetAlertState,
} = require('../src/alert-routes.js');

const DEFAULT_ROUTE = { endpoint: 'http://127.0.0.1:8001/default', tokenFile: '/tmp/miser-test-default' };
const S360_ROUTE = { endpoint: 'http://127.0.0.1:8001/s360', tokenFile: '/tmp/miser-test-s360' };
const OPS_ROUTE = { endpoint: 'http://127.0.0.1:8001/ops', tokenFile: '/tmp/miser-test-ops' };

// Fixtures are built by the REAL parser, never hand-rolled. A literal of the
// parsed shape passes for exactly as long as parseAlertRoutes agrees with it,
// and these tests drive the real dispatcher off this object — a drifted fixture
// would quietly turn them into stub-testing-stub, which is the failure mode
// AR33(d) exists to prevent.
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
  const calls = [];
  return {
    calls,
    marked,
    shouldSend(key) { calls.push(`shouldSend:${key}`); return !marked.has(key); },
    markSent(key) { calls.push(`markSent:${key}`); marked.set(key, true); },
    async flushNow() { calls.push('flushNow'); },
  };
}

async function captureWarnsAsync(fn) {
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

test('AR5: case E never misroutes, dedupes by bucket, and controls withheld text exposure', async () => {
  const runtimeCases = [
    { name: 'mapped control', project: 'structural360', expectDelivered: true },
    { name: 'unmapped valid', project: 'pkachu', expectBucket: 'pkachu' },
    { name: 'invalid spaces', project: 'a b', expectBucket: '@invalid' },
    { name: 'invalid slash', project: 'x/y', expectBucket: '@invalid' },
    { name: 'invalid too long', project: 'x'.repeat(81), expectBucket: '@invalid' },
    { name: 'second unmapped valid', project: 'aetheria', expectBucket: 'aetheria' },
  ];

  for (const mode of ['withhold', 'escalate']) {
    for (const c of runtimeCases) {
      __resetAlertState();
      const posts = [];
      const ledger = recordingLedger();
      const sendAlert = createAlertDispatcher(
        {
          alertRoutes: routeMap({ structural360: S360_ROUTE }),
          alertRoutesOps: OPS_ROUTE,
          alertRoutesUnrouted: mode,
        },
        {
          post: async (endpoint, token, text) => { posts.push({ endpoint, text }); },
          readToken: async () => 'tok',
          defaultRoute: DEFAULT_ROUTE,
          ledger,
          nowFn: () => new Date('2026-08-04T12:00:00Z'),
        },
      );

      const withheldText = `PROJECT ALERT TEXT ${mode} ${c.name}`;
      const first = await captureWarnsAsync(() => sendAlert(withheldText, { project: c.project, kind: 'drift' }));
      await new Promise(resolve => setImmediate(resolve));
      const second = await captureWarnsAsync(() => sendAlert(withheldText, { project: c.project, kind: 'drift' }));
      await new Promise(resolve => setImmediate(resolve));

      if (c.expectDelivered) {
        assert.equal(first.value.outcome, 'delivered', `${mode}/${c.name}: mapped control delivered`);
        assert.equal(posts.length, 2, `${mode}/${c.name}: both project alerts reached its own route`);
        assert.deepEqual(posts.map(p => p.endpoint), [S360_ROUTE.endpoint, S360_ROUTE.endpoint]);
        continue;
      }

      assert.equal(first.value.outcome, 'withheld', `${mode}/${c.name}: first project alert withheld`);
      assert.equal(second.value.outcome, 'withheld', `${mode}/${c.name}: repeat project alert withheld`);
      assert.equal(posts.filter(p => p.text === withheldText).length, 0, `${mode}/${c.name}: project alert text never goes to a project route`);
      assert.equal(posts.length, 1, `${mode}/${c.name}: exactly one ops defect post for the UTC-day bucket`);
      assert.equal(posts[0].endpoint, OPS_ROUTE.endpoint, `${mode}/${c.name}: defect goes to ops route`);
      assert.match(posts[0].text, /alert-routing DEFECT/i);
      assert.match(posts[0].text, c.expectBucket === '@invalid' ? /INVALID project names/ : new RegExp(`project=${c.expectBucket}`));
      if (mode === 'withhold') assert.ok(!posts[0].text.includes(withheldText), 'withhold mode omits the original alert text');
      if (mode === 'escalate' && c.expectBucket !== '@invalid') assert.ok(posts[0].text.includes(withheldText), 'escalate mode includes the original alert text for valid unmapped projects');
      assert.equal(first.warns.filter(l => /ALERT-WITHHELD/.test(l)).length, 1);
    }
  }
  __resetAlertState();
});

test('AR23: 600 unroutable project names mint at most cap+2 ops posts and ledger keys', async () => {
  __resetAlertState();
  const ledger = recordingLedger();
  const posts = [];
  const sendAlert = createAlertDispatcher(
    {
      alertRoutes: routeMap({ structural360: S360_ROUTE }),
      alertRoutesOps: OPS_ROUTE,
      alertRoutesUnroutedMax: 8,
    },
    {
      post: async (endpoint, token, text) => { posts.push({ endpoint, text }); },
      readToken: async () => 'tok',
      defaultRoute: DEFAULT_ROUTE,
      ledger,
      nowFn: () => new Date('2026-08-04T12:00:00Z'),
    },
  );

  const prev = console.warn;
  console.warn = () => {};
  try {
    for (let i = 0; i < 500; i++) {
      await sendAlert(`valid ${i}`, { project: `proj${i}`, kind: 'cache-thrash' });
    }
    for (let i = 0; i < 100; i++) {
      await sendAlert(`invalid ${i}`, { project: `bad project ${i}`, kind: 'cache-thrash' });
    }
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    console.warn = prev;
  }

  // The AC states bounds (<= 10), but the designed value is exact: 8 per-project
  // + @invalid + @overflow. Asserting only the bound would pass on a build that
  // emitted nothing at all, so assert the composition and pin the bound below it.
  const keys = [...ledger.marked.keys()].filter(k => k.startsWith('alertroute:unmapped:'));
  assert.equal(posts.length, 10, `expected exactly 10 ops posts (<= 10 per AR23), got ${posts.length}`);
  assert.equal(keys.length, 10, `expected exactly 10 ledger keys (<= 10 per AR23), got ${keys.length}`);
  assert.deepEqual(
    keys.filter(k => !k.endsWith('@invalid') && !k.endsWith('@overflow')).sort(),
    Array.from({ length: 8 }, (_, i) => `alertroute:unmapped:proj${i}`).sort(),
    'the 8 per-project keys are the FIRST 8 seen, i.e. the cap is a cap and not a sample',
  );
  assert.equal(getAlertCounters().withheld, 600, 'every unroutable project alert is withheld');
  assert.equal(getAlertCounters().withheldOverflow, 492, 'all 500 valid projects beyond the cap of 8 collapse to @overflow');
  assert.ok(keys.includes('alertroute:unmapped:@invalid'), 'invalid names collapse to one ledger key');
  assert.ok(keys.includes('alertroute:unmapped:@overflow'), 'overflow collapses to one ledger key');
  assert.ok(!keys.includes('alertroute:unmapped:proj499'), 'cap gate fires before per-project ledger key creation');
  __resetAlertState();
});

test('AR7(d): an incomplete route map leaves POST forwarding and health HTTP availability intact', async () => {
  const prevEnv = { ...process.env };
  const statsFile = path.join(os.tmpdir(), `miser-ar7d-stats-${process.pid}-${Date.now()}.json`);
  for (const key of Object.keys(require.cache)) {
    if (/\/src\/(proxy|router|config|stats|budgets|policy-watchdog|pricing|alert-routes|daily-rollup|routing|metrics|quota|panel-stats)\.js$/.test(key.replace(/\\/g, '/'))) {
      delete require.cache[key];
    }
  }
  try {
    process.env.MISER_STATS_FILE = statsFile;
    process.env.MISER_ALERT_ROUTES = JSON.stringify({ structural360: S360_ROUTE });
    process.env.MISER_BUDGETS = JSON.stringify({ structural360: { dailyUSD: 1 }, pkachu: { dailyUSD: 1 } });
    delete process.env.MISER_ALERT_ROUTES_STRICT;
    delete process.env.MISER_PKACHU_ENDPOINT;
    delete process.env.MISER_PKACHU_TOKEN;

    const { createProxy } = require('../src/proxy.js');
    const handler = createProxy({
      transports: {
        anthropic: async (messages, body, headers, res) => {
          res.writeHead(207, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, echoed: body.model }));
        },
      },
      guardDeps: {},
    });

    const postRes = new FakeRes();
    await drive(handler, fakeReq('POST', '/v1/messages', { model: 'claude-opus', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': 'test' }), postRes);
    assert.equal(postRes.statusCode, 207, 'POST /v1/messages still forwards and returns upstream status');

    const healthRes = new FakeRes();
    await drive(handler, fakeReq('GET', '/api/miser/health', null), healthRes);
    assert.equal(healthRes.statusCode, 200, 'GET /api/miser/health remains HTTP 200');
    const health = JSON.parse(healthRes.body());
    assert.equal(health.ok, false, 'health body reports degraded routing without stopping service');
    assert.deepEqual(health.alertRouting.unroutedConfigured, ['pkachu']);
  } finally {
    process.env = prevEnv;
    try { require('node:fs').unlinkSync(statsFile); } catch (_) {}
    for (const key of Object.keys(require.cache)) {
      if (/\/src\/(proxy|router|config|stats|budgets|policy-watchdog|pricing|alert-routes|daily-rollup|routing|metrics|quota|panel-stats)\.js$/.test(key.replace(/\\/g, '/'))) {
        delete require.cache[key];
      }
    }
  }
});

test('AR31(c): both startup degraded causes produce exactly two ops posts and two keys in one UTC day', async () => {
  __resetAlertState();
  const ledger = recordingLedger();
  const posts = [];
  const config = {
    budgets: { structural360: {}, pkachu: {} },
    alertRoutes: parseAlertRoutes(
      { MISER_ALERT_ROUTES: JSON.stringify({ structural360: '@default' }) },
      { budgets: { structural360: {}, pkachu: {} } },
    ),
    alertRoutesOps: OPS_ROUTE,
  };
  const report = captureWarnsAsync(() => reportStartupAlertDefects(config, {
    ledger,
    sendAlert: async (text, opts) => {
      posts.push({ text, opts });
      return { ok: true, outcome: 'delivered', kind: opts.kind };
    },
  }));
  await (await report).value.settled;

  assert.equal(posts.length, 2);
  assert.deepEqual(posts.map(p => p.opts.kind).sort(), ['alertroute-default-missing', 'alertroute-incomplete']);
  assert.deepEqual([...ledger.marked.keys()].sort(), ['alertroute:default-missing', 'alertroute:incomplete']);
  __resetAlertState();
});

function fakeReq(method, url, bodyObj, headers = {}) {
  const raw = bodyObj == null ? '' : JSON.stringify(bodyObj);
  const listeners = {};
  const req = {
    method,
    url,
    headers,
    on(evt, cb) { listeners[evt] = cb; return req; },
  };
  process.nextTick(() => {
    if (listeners.data && raw) listeners.data(Buffer.from(raw));
    if (listeners.end) listeners.end();
  });
  return req;
}

class FakeRes extends Writable {
  constructor() {
    super();
    this.headersSent = false;
    this.statusCode = null;
    this.headers = {};
    this.chunks = [];
    this.done = new Promise(resolve => this.on('finish', resolve));
  }
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }
  removeHeader(k) { delete this.headers[k.toLowerCase()]; }
  writeHead(code, headers) {
    if (this.headersSent) throw new Error('writeHead twice');
    this.headersSent = true;
    this.statusCode = code;
    this.headers = { ...this.headers, ...(headers || {}) };
    return this;
  }
  _write(chunk, enc, cb) { this.chunks.push(chunk.toString()); cb(); }
  body() { return this.chunks.join(''); }
}

async function drive(handler, req, res) {
  handler(req, res);
  await res.done;
}
