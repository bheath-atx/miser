'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');

class FakeRes extends Writable {
  constructor() {
    super();
    this.headersSent = false;
    this.statusCode = null;
    this.headers = {};
    this.chunks = [];
    this._done = new Promise(resolve => { this._resolveDone = resolve; });
    this.on('finish', () => this._resolveDone());
  }
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }
  removeHeader(k) { delete this.headers[k.toLowerCase()]; }
  writeHead(code, headers) {
    this.headersSent = true;
    this.statusCode = code;
    this.headers = { ...this.headers, ...(headers || {}) };
    return this;
  }
  _write(chunk, enc, cb) { this.chunks.push(chunk.toString()); cb(); }
  body() { return this.chunks.join(''); }
  whenDone() { return this._done; }
}

function fakeReq(method, url, bodyObj = null, headers = {}) {
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

function freshModules() {
  for (const key of Object.keys(require.cache)) {
    if (/\/src\/(proxy|router|routing|stats|pricing|config|compress|toolprune|context-management|usage|quota|circuit-breaker|sub-cap)\.js$/.test(key.replace(/\\/g, '/'))) {
      delete require.cache[key];
    }
  }
  const statsFile = path.join(os.tmpdir(), `miser-health-${process.pid}-${Date.now()}-${Math.random()}.json`);
  const prevStatsFile = process.env.MISER_STATS_FILE;
  process.env.MISER_STATS_FILE = statsFile;
  const proxy = require('../src/proxy.js');
  const stats = require('../src/stats.js');
  const router = require('../src/router.js');
  return {
    proxy,
    stats,
    router,
    cleanup() {
      stats.__resetForTest();
      if (prevStatsFile === undefined) delete process.env.MISER_STATS_FILE;
      else process.env.MISER_STATS_FILE = prevStatsFile;
      try { fs.unlinkSync(statsFile); } catch (_) {}
    },
  };
}

async function drive(handler, req) {
  const res = new FakeRes();
  handler(req, res);
  await res.whenDone();
  return { res, payload: JSON.parse(res.body()) };
}

test('/api/miser/health returns all vitals fields', async () => {
  const { proxy, cleanup } = freshModules();
  try {
    const handler = proxy.createProxy();
    const { payload } = await drive(handler, fakeReq('GET', '/api/miser/health'));
    for (const key of ['ok', 'uptimeSecs', 'reqPerMin', 'perLegErrors', 'c1DisabledProjects', 'statsFlushLagMs', 'pendingWrites']) {
      assert.ok(key in payload);
    }
    assert.equal(payload.ok, true);
    assert.ok(Array.isArray(payload.c1DisabledProjects));
    assert.deepEqual(payload.perLegErrors, { anthropic: 0, codex: 0, ollama: 0 });
  } finally {
    cleanup();
  }
});

test('health reqPerMin prunes old requests and counts current window', async () => {
  const { proxy, cleanup } = freshModules();
  const realNow = Date.now;
  try {
    const handler = proxy.createProxy();
    Date.now = () => 1_000_000;
    proxy.__test._reqTimestamps.push(1_000_000 - 61_000, 1_000_000 - 1000, 1_000_000);
    const { payload } = await drive(handler, fakeReq('GET', '/api/miser/health'));
    assert.equal(payload.reqPerMin, 3);
  } finally {
    Date.now = realNow;
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC6-A: circuitBreakers present in health payload with injected state
// ---------------------------------------------------------------------------

test('AC6-A: circuitBreakers in health payload matches injected getBreakersState', async () => {
  const { proxy, cleanup } = freshModules();
  try {
    const breakerState = {
      anthropic: { state: 'OPEN', failures: 5, openedAt: 123456 },
      codex:     { state: 'CLOSED', failures: 0, openedAt: null },
      ollama:    { state: 'HALF_OPEN', failures: 3, openedAt: 99999 },
    };
    const handler = proxy.createProxy({ getBreakersState: () => breakerState });
    const { payload } = await drive(handler, fakeReq('GET', '/api/miser/health'));
    assert.deepEqual(payload.circuitBreakers, breakerState);
  } finally {
    cleanup();
  }
});

// AC6-B: safeAcquire fail-open: a throwing breaker returns true and logs warning
test('AC6-B: safeAcquire fail-open — throwing breaker returns true, logs warning', () => {
  const { router, cleanup } = freshModules();
  try {
    const { safeAcquire } = router.__test;
    const throwingBreaker = { acquire() { throw new Error('breaker exploded'); } };
    const warns = [];
    const prev = console.warn;
    console.warn = (msg) => warns.push(String(msg));
    let result;
    try {
      result = safeAcquire(throwingBreaker);
    } finally {
      console.warn = prev;
    }
    assert.equal(result, true);
    assert.ok(warns.some(w => w.includes('breaker.acquire error')));
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC9: subscriptionCap in health payload
// ---------------------------------------------------------------------------

test('AC9-a: subscriptionCap is null when no subCapTracker in guardDeps', async () => {
  const { proxy, cleanup } = freshModules();
  try {
    const handler = proxy.createProxy();
    const { payload } = await drive(handler, fakeReq('GET', '/api/miser/health'));
    assert.equal(payload.subscriptionCap, null);
  } finally {
    cleanup();
  }
});

test('AC9-b: subscriptionCap matches getStatus() output when subCapTracker present', async () => {
  const { proxy, cleanup } = freshModules();
  try {
    const fakeStatus = {
      requestsIn5h: 10, events429In5h: 0, cap5h: 40,
      capFraction: 0.25, deferBackground: false,
      weeklyRequests: 50, weeklyCap: 280, weeklyCapFraction: 0.178,
      burnRatePerHour: 2, timeToLimitEstMs: 54_000_000, shouldAlert: false,
    };
    const fakeTracker = { getStatus: () => fakeStatus };
    const handler = proxy.createProxy({ guardDeps: { subCapTracker: fakeTracker } });
    const { payload } = await drive(handler, fakeReq('GET', '/api/miser/health'));
    assert.ok(payload.subscriptionCap !== null);
    assert.equal(payload.subscriptionCap.requestsIn5h, 10);
    assert.equal(payload.subscriptionCap.deferBackground, false);
    assert.equal(payload.subscriptionCap.cap5h, 40);
  } finally {
    cleanup();
  }
});

test('health exposes leg errors, c1 disabled projects, and pending writes', async () => {
  const { proxy, stats, cleanup } = freshModules();
  try {
    const handler = proxy.createProxy({
      transports: {
        anthropic: () => {
          const err = new Error('anthropic down');
          err.statusCode = 500;
          return Promise.reject(err);
        },
      },
    });
    const reqBody = { model: 'claude-sonnet-4-6', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };
    await drive(handler, fakeReq('POST', '/v1/messages', reqBody));

    stats.__resetForTest();
    proxy.__test.contextDisabled.add('alpha');
    stats.recordStats('alpha', { inputTokensRemoved: 1, techniques: { dedup: true } });

    const { payload } = await drive(handler, fakeReq('GET', '/api/miser/health'));
    assert.equal(payload.perLegErrors.anthropic, 1);
    assert.deepEqual(payload.c1DisabledProjects, ['alpha']);
    assert.equal(payload.pendingWrites, 1);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// AR19 / AR20 / AR25 — alert-routing health block, startup inventory line, and
// the degraded-is-inert contract. Added at BUILDER-AUDIT R1: the
// implementations existed (src/proxy.js alertRoutingHealth, src/index.js
// inventory log) but nothing asserted them, so §4's oracle column named this
// file for three ACs it did not actually cover.
// ---------------------------------------------------------------------------

const { alertRoutingHealth, parseAlertRoutes, __resetAlertState } = require('../src/alert-routes.js');

test('AR19: health exposes the full §2.8 alertRouting block, every field', async () => {
  const { proxy, cleanup } = freshModules();
  try {
    const handler = proxy.createProxy();
    const { payload } = await drive(handler, fakeReq('GET', '/api/miser/health'));
    assert.ok('alertRouting' in payload, 'health carries an alertRouting block');
    // The AC enumerates twelve fields; assert the exact key set so a field
    // silently dropped (or added without updating §2.8) fails here.
    assert.deepEqual(
      Object.keys(payload.alertRouting).sort(),
      [
        'counters', 'defaultConfigured', 'defaultDeclared', 'invalidProjectAlerts',
        'mapped', 'opsConfigured', 'status', 'strict', 'undeliverableDefaultDeclared',
        'unroutedConfigured', 'unroutedRuntime', 'unroutedRuntimeOverflow',
      ],
      'the §2.8 block is exactly these twelve fields',
    );
    assert.deepEqual(
      Object.keys(payload.alertRouting.counters).sort(),
      ['delivered', 'dropped', 'failed', 'withheld', 'withheldOverflow'],
      'counters carries the five §2.7 counters',
    );
    assert.equal(payload.alertRouting.status, 'ok', 'routes OFF is not degraded');
  } finally {
    cleanup();
  }
});

test('AR25: degraded is visible in health and inert on the request path', async () => {
  // Routes ON with a required project missing -> degraded. health must be
  // HTTP 200 with ok:false, and the request path must be untouched.
  const routes = parseAlertRoutes(
    { MISER_ALERT_ROUTES: JSON.stringify({ alpha: { endpoint: 'http://127.0.0.1:8001/a', tokenFile: '/tmp/a' } }) },
    { budgets: { alpha: {}, beta: {} } },
  );
  const health = alertRoutingHealth({ alertRoutes: routes });
  assert.equal(health.status, 'degraded');
  assert.deepEqual(health.unroutedConfigured, ['beta'], 'the unrouted project is named, not just counted');

  // ...and the complete/OFF cases stay ok:true, which is what keeps
  // '/api/miser/health returns all vitals fields' above (payload.ok === true)
  // and test/proxy.test.js passing UNMODIFIED. That is the load-bearing half:
  // the obvious over-broad fix would have flipped ok:false on every process.
  const complete = parseAlertRoutes(
    { MISER_ALERT_ROUTES: JSON.stringify({ alpha: { endpoint: 'http://127.0.0.1:8001/a', tokenFile: '/tmp/a' } }) },
    { budgets: { alpha: {} } },
  );
  assert.equal(alertRoutingHealth({ alertRoutes: complete }).status, 'ok');
  assert.equal(alertRoutingHealth({ alertRoutes: null }).status, 'ok', 'routes OFF is never degraded');
  __resetAlertState();
});

test('AR20: startup emits the alert-routes INVENTORY line, distinct from the degraded line', () => {
  // Source-shape rather than a spawned process: the line is emitted inside
  // index.js's listen callback, which cannot be driven without binding a port.
  // What AR20 protects is that the inventory line exists, is separate from
  // AR28(c)'s ALERT-ROUTING-DEGRADED line, and reports the four things §2.8
  // says it reports — all checkable in the source.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  const line = src.split('\n').find(l => l.includes('[miser] alert routes:'));
  assert.ok(line, 'the inventory line exists');

  const block = src.slice(src.indexOf('[miser] alert routes:'));
  const stanza = block.slice(0, block.indexOf('[miser] health:'));
  assert.match(stanza, /mapped/, 'enumerates mapped projects');
  assert.match(stanza, /defaultDeclared/, 'enumerates @default declarations');
  assert.match(stanza, /defaultConfigured/, 'reports whether the default route is configured');
  assert.match(stanza, /MISER_ALERT_ROUTES unset/, 'says so plainly when routing is OFF');

  // Two lines, two owners (§2.8 / AR28(c)): the inventory line must NOT be the
  // degraded line, or one could be silently dropped in favour of the other.
  assert.ok(!stanza.includes('ALERT-ROUTING-DEGRADED'),
    'the inventory line is not the degraded line');
  assert.ok(!src.includes("console.log(`[miser/alert] ALERT-ROUTING-DEGRADED"),
    'the degraded line is owned by reportStartupAlertDefects, not by index.js');
});
