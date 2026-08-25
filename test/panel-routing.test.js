'use strict';

// B4 routing + panel-stats + endpoint + startup-validation + B2 wiring tests.
// AC10–AC20, AC31. All offline — no live sockets, no index.js import.

const os   = require('node:os');
const path = require('node:path');
process.env.MISER_STATS_FILE = path.join(os.tmpdir(), `miser-panel-test-${process.pid}-${Date.now()}.json`);
process.env.MISER_PANEL_STATS_FILE = path.join(os.tmpdir(), `miser-panel-stats-test-${process.pid}-${Date.now()}.json`);

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyRoute } = require('../src/routing.js');
const { recordPanelUsage, getPanelStats, __resetForTest } = require('../src/panel-stats.js');
const { validateStartupConfig } = require('../src/config.js');
const { wireCacheThrashDeps, createCacheThrashChecker } = require('../src/cache-thrash.js');
const { createProxy } = require('../src/proxy.js');
const { makeRes } = require('./_harness.js');

// ---- Helpers ----------------------------------------------------------------

function fakeGetReq(url) {
  const listeners = {};
  const req = {
    method: 'GET', url, headers: {},
    on(evt, cb) { listeners[evt] = cb; return req; },
  };
  process.nextTick(() => { if (listeners.end) listeners.end(); });
  return req;
}

function runGetHandler(handler, url) {
  return new Promise((resolve) => {
    const res = makeRes();
    const origEnd = res.end.bind(res);
    res.end = (chunk) => { origEnd(chunk); resolve(res); return res; };
    handler(fakeGetReq(url), res);
  });
}

function clearPanelEndpointModules() {
  for (const key of Object.keys(require.cache)) {
    if (/\/src\/(proxy|panel-stats|routing|stats|pricing|config|metrics|budgets|policy-watchdog|context-management)\.js$/.test(key.replace(/\\/g, '/'))) {
      delete require.cache[key];
    }
  }
}

// ---- AC10–AC14, AC19: classifyRoute panel routing ---------------------------

test('AC10: project--panel route parsed correctly', () => {
  assert.deepEqual(
    classifyRoute('POST', '/p/pkachu--orch/v1/messages'),
    { kind: 'messages', format: 'anthropic', project: 'pkachu', panel: 'orch' },
  );
});

test('AC11: project-only route has no panel field (backward-compatible)', () => {
  const result = classifyRoute('POST', '/p/pkachu/v1/messages');
  assert.deepEqual(result, { kind: 'messages', format: 'anthropic', project: 'pkachu' });
  assert.ok(!('panel' in result), 'panel key must not appear for non-panel route');
});

test('AC12: invalid panel charset → not_found', () => {
  assert.deepEqual(classifyRoute('POST', '/p/proj--bad!/v1/messages'), { kind: 'not_found' });
});

test('AC13: invalid project with valid panel → not_found', () => {
  assert.deepEqual(classifyRoute('POST', '/p/bad!proj--panel/v1/messages'), { kind: 'not_found' });
});

test('AC14: empty project (--panel) → not_found', () => {
  assert.deepEqual(classifyRoute('POST', '/p/--panel/v1/messages'), { kind: 'not_found' });
});

test('AC14: empty panel (proj--) → not_found', () => {
  assert.deepEqual(classifyRoute('POST', '/p/proj--/v1/messages'), { kind: 'not_found' });
});

test('AC19: a--b always parsed as project=a, panel=b', () => {
  assert.deepEqual(
    classifyRoute('POST', '/p/a--b/v1/messages'),
    { kind: 'messages', format: 'anthropic', project: 'a', panel: 'b' },
  );
});

// ---- AC15–AC16, AC18: panel-stats module ------------------------------------

test('AC15: recordPanelUsage creates a panel entry with correct fields', () => {
  __resetForTest();
  recordPanelUsage('myprojA', 'mypanel', {
    input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 30,
  });
  const stats = getPanelStats();
  const entry = stats['myprojA--mypanel'];
  assert.ok(entry, 'panel entry should exist');
  assert.equal(entry.input, 100);
  assert.equal(entry.output, 50);
  assert.equal(entry.cacheRead, 30);
  assert.equal(entry.requests, 1);
  assert.ok(typeof entry.lastSeenAt === 'string', 'lastSeenAt should be an ISO string');
});

test('AC16: two panel-routed requests accumulate', () => {
  __resetForTest();
  recordPanelUsage('proj', 'panel', { input_tokens: 100, output_tokens: 50 });
  recordPanelUsage('proj', 'panel', { input_tokens: 200, output_tokens: 80 });
  const entry = getPanelStats()['proj--panel'];
  assert.equal(entry.requests, 2);
  assert.equal(entry.input, 300);
  assert.equal(entry.output, 130);
});

test('AC18: non-panel calls do not create entries', () => {
  __resetForTest();
  recordPanelUsage('proj', '', { input_tokens: 100 });  // empty panel
  recordPanelUsage('', 'panel', { input_tokens: 100 }); // empty project
  assert.deepEqual(getPanelStats(), {});
});

// ---- AC17: GET /api/miser/stats/panels endpoint -----------------------------

test('AC17: GET /api/miser/stats/panels returns correct structure', async () => {
  __resetForTest();
  recordPanelUsage('testproj', 'testpanel', { input_tokens: 42 });
  const handler = createProxy({
    transports: {
      anthropic: (msgs, body, hdrs, res) => {
        res.writeHead(200, {}); res.end(); return Promise.resolve();
      },
    },
  });
  const res = await runGetHandler(handler, '/api/miser/stats/panels');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body());
  assert.equal(body.ok, false);
  assert.equal(body.note, 'persistence pending; panel stats may not survive restart yet');
  assert.equal(body.durable, false);
  assert.equal(body.degraded, false);
  assert.equal(body.persistence.healthy, true);
  assert.equal(body.persistence.pending, true);
  assert.equal(body.persistence.dirty, true);
  assert.ok(typeof body.panels === 'object');
  assert.ok('testproj--testpanel' in body.panels);
  assert.equal(body.panels['testproj--testpanel'].input, 42);
});

test('GET /api/miser/stats/panels reflects degraded persistence', async () => {
  const prevEnv = process.env.MISER_PANEL_STATS_FILE;
  const dir = require('node:fs').mkdtempSync(path.join(os.tmpdir(), `miser-panel-endpoint-dir-${process.pid}-`));
  try {
    process.env.MISER_PANEL_STATS_FILE = dir;
    clearPanelEndpointModules();
    const { createProxy: createReloadedProxy } = require('../src/proxy.js');
    await require('../src/panel-stats.js').__test.waitForLoad();
    const handler = createReloadedProxy();
    const res = await runGetHandler(handler, '/api/miser/stats/panels');
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body());
    assert.equal(body.ok, false);
    assert.equal(body.durable, false);
    assert.equal(body.degraded, true);
    assert.equal(body.persistence.healthy, false);
    assert.notEqual(body.note, 'persisted; survives restart');
    assert.match(body.note, /degraded/);
  } finally {
    if (prevEnv === undefined) delete process.env.MISER_PANEL_STATS_FILE;
    else process.env.MISER_PANEL_STATS_FILE = prevEnv;
    clearPanelEndpointModules();
    try { require('node:fs').rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('routing: classifyRoute GET /api/miser/stats/panels → stats_panels kind', () => {
  const result = classifyRoute('GET', '/api/miser/stats/panels');
  assert.deepEqual(result, { kind: 'stats_panels' });
});

// ---- AC20: validateStartupConfig -------------------------------------------

test('AC20: budgets with double-dash project name throws', () => {
  assert.throws(
    () => validateStartupConfig({ budgets: { 'a--b': { dailyUSD: 5 } } }),
    (err) => err.message.includes('--') && err.message.includes('panel routing'),
  );
});

test('AC20: policy with double-dash project name throws', () => {
  assert.throws(
    () => validateStartupConfig({ policy: { 'a--b': { expectedModel: 'claude' } } }),
    (err) => err.message.includes('--') && err.message.includes('panel routing'),
  );
});

test('AC20: contextEditProjects with double-dash project name throws', () => {
  assert.throws(
    () => validateStartupConfig({ contextEditProjects: { 'a--b': true } }),
    (err) => err.message.includes('--') && err.message.includes('panel routing'),
  );
});

test('AC20: toolAllowlists with double-dash project name throws', () => {
  assert.throws(
    () => validateStartupConfig({ toolAllowlists: { 'a--b': ['read'] } }),
    (err) => err.message.includes('--') && err.message.includes('panel routing'),
  );
});

test('AC20: budgetGrace list with double-dash name throws', () => {
  assert.throws(
    () => validateStartupConfig({ budgetGrace: ['a--b'] }),
    (err) => err.message.includes('--') && err.message.includes('panel routing'),
  );
});

test('AC20: enforcement wildcard is allowed but double-dash project override throws', () => {
  assert.doesNotThrow(() =>
    validateStartupConfig({ enforcement: { '*': { mode: 'observe' }, pkachu: { mode: 'alert' } } }),
  );
  assert.throws(
    () => validateStartupConfig({ enforcement: { 'a--b': { mode: 'block' } } }),
    (err) => err.message.includes('--') && err.message.includes('panel routing'),
  );
});

test('AC20: valid project names in budgets do not throw', () => {
  assert.doesNotThrow(() =>
    validateStartupConfig({ budgets: { pkachu: { dailyUSD: 5 } } }),
  );
});

test('AC20: valid project name in budgetGrace does not throw', () => {
  assert.doesNotThrow(() =>
    validateStartupConfig({ budgetGrace: ['pkachu'] }),
  );
});

test('AC20: null/undefined maps are skipped without error', () => {
  assert.doesNotThrow(() =>
    validateStartupConfig({ budgets: null, policy: undefined, budgetGrace: [] }),
  );
});

// ---- AC31: wireCacheThrashDeps offline wiring test --------------------------

test('AC31: wireCacheThrashDeps wires all required keys without importing index.js', () => {
  const config = {
    budgets: null, policy: null, codex5hCap: 0,
    cacheThrashMinRequests: 10, cacheThrashSpikeRatio: 3.0,
    cacheThrashInputSpikeRatio: 2.0, cacheThrashRingSize: 50,
  };
  const guardDeps = {};
  const seams = {
    createLedger: () => ({ shouldSend: () => true, markSent: () => {} }),
    sendAlert: () => {},
    createCacheThrashChecker,
  };
  wireCacheThrashDeps(config, guardDeps, seams);

  assert.ok(guardDeps.ledger !== undefined, 'ledger must be set');
  assert.ok(guardDeps.sendAlert !== undefined, 'sendAlert must be set');
  assert.ok(typeof guardDeps.checkCacheThrash === 'function', 'checkCacheThrash must be a function');
  assert.ok(typeof guardDeps.getCacheThrashStatus === 'function', 'getCacheThrashStatus must be a function');
});

test('AC31: wireCacheThrashDeps is a no-op when minRequests=0', () => {
  const config = {
    cacheThrashMinRequests: 0, cacheThrashSpikeRatio: 3.0,
    cacheThrashInputSpikeRatio: 2.0, cacheThrashRingSize: 50,
  };
  const guardDeps = {};
  wireCacheThrashDeps(config, guardDeps, {});
  assert.ok(!('checkCacheThrash' in guardDeps), 'checkCacheThrash must NOT be set when disabled');
  assert.ok(!('getCacheThrashStatus' in guardDeps), 'getCacheThrashStatus must NOT be set when disabled');
});

test('AC31: index.js is never imported by this test suite', () => {
  const loaded = Object.keys(require.cache).map(p => p.replace(/\\/g, '/'));
  assert.ok(
    !loaded.some(p => p.endsWith('/src/index.js')),
    'src/index.js must not be loaded during panel-routing tests',
  );
});
