'use strict';

// Proxy-level tests: AC7 (terminal passthrough / failover), AC8 + AC10
// (reduced body reaches the Anthropic leg — proven via a LOOPBACK ECHO on an
// ephemeral 127.0.0.1 port set through MISER_ANTHROPIC_URL). This is NOT :20128
// and NOT a real provider — it is exactly the loopback interception AC10 calls
// for. The echo server captures the forwarded body so we can assert the hoisted
// system + dedup stub actually reached the wire.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');

// Start an ephemeral loopback echo server. `handler(reqBody)` returns
// { status, body } for miser's Anthropic leg to receive. Captures every body.
function startEcho(handler) {
  const captured = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (_) {}
      captured.push({ url: req.url, headers: req.headers, body: parsed, raw });
      const { status, body } = handler(parsed, req) || { status: 200, body: { ok: true } };
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, captured, url: `http://127.0.0.1:${port}` });
    });
  });
}

// Load a FRESH proxy/router/config with MISER_ANTHROPIC_URL pointed at the echo.
// budgets/policy-watchdog bind the stats module at require time, so they (and
// their pricing dep) must be re-required in the same sweep as stats.
function freshProxy(anthropicUrl, extraEnv = {}) {
  for (const k of Object.keys(require.cache)) {
    if (/\/src\/(proxy|router|config|compress|stats|toolprune|routing|context-management|usage|budgets|policy-watchdog|pricing|daily-rollup|alert-ledger|enforcement|watchd)\.js$/.test(k.replace(/\\/g, '/'))) {
      delete require.cache[k];
    }
  }
  const prev = { ...process.env };
  const statsFile = extraEnv.MISER_STATS_FILE
    || path.join(os.tmpdir(), `miser-proxy-test-stats-${process.pid}-${Date.now()}-${Math.random()}.json`);
  process.env.MISER_ANTHROPIC_URL = anthropicUrl;
  process.env.MISER_STATS_FILE = statsFile;
  for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;
  const { createProxy } = require('../src/proxy.js');
  return {
    createProxy,
    restoreEnv: () => {
      process.env = prev;
      try { fs.unlinkSync(statsFile); } catch (_) {}
    },
  };
}

// Minimal fake req/res to drive the proxy handler in-process.
function fakeReq(method, url, bodyObj, headers = {}) {
  const raw = bodyObj == null ? '' : JSON.stringify(bodyObj);
  const listeners = {};
  const req = {
    method, url, headers,
    on(evt, cb) { listeners[evt] = cb; return req; },
  };
  // Deliver the body on next tick so the handler's on('data')/on('end') attach first.
  process.nextTick(() => {
    if (listeners.data && raw) listeners.data(Buffer.from(raw));
    if (listeners.end) listeners.end();
  });
  return req;
}

// A real Writable so upstream.pipe(res) works, plus writeHead() + headersSent
// (mirrors http.ServerResponse just enough for the proxy/router).
class FakeRes extends Writable {
  constructor() {
    super();
    this.headersSent = false;
    this.statusCode = null;
    this.headers = {};
    this.chunks = [];
    this._doneResolvers = [];
    this.on('finish', () => this._doneResolvers.forEach(r => r()));
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
  whenDone() { return new Promise(res => this._doneResolvers.push(res)); }
}

function fakeRes() { return new FakeRes(); }

function controlMessage(res) {
  const payload = JSON.parse(res.body());
  assert.equal(res.statusCode, 200);
  assert.equal(payload.type, 'message');
  assert.equal(payload.role, 'assistant');
  assert.equal(payload.usage.input_tokens, 0);
  const text = payload.content[0].text;
  assert.match(text, /miser_control_plane_error/);
  assert.match(text, /retryable=false/);
  return { payload, text };
}

function sseText(body) {
  return [...body.matchAll(/^event: content_block_delta\ndata: (.+)$/gm)]
    .map(match => JSON.parse(match[1]).delta.text)
    .join('');
}

function drive(createProxy, req, res) {
  const handler = createProxy();
  const done = res.whenDone();
  handler(req, res);
  return done;
}

// ---------------------------------------------------------------------------
// AC8/AC10 — reduced body (hoisted system + dedup stub) reaches the wire.
// ---------------------------------------------------------------------------
test('AC8: hoisted top-level system reaches the Anthropic leg (loopback echo)', async () => {
  const echo = await startEcho(() => ({ status: 200, body: { role: 'assistant', content: 'ok' } }));
  const { createProxy, restoreEnv } = freshProxy(echo.url);
  try {
    const body = {
      model: 'claude',
      max_tokens: 100,
      messages: [
        { role: 'system', content: 'You are Claude Code.' },
        { role: 'user', content: 'hi' },
      ],
    };
    const res = fakeRes();
    await drive(createProxy, fakeReq('POST', '/v1/messages', body, {}), res);
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['x-miser-compact-hint']);
    assert.equal(echo.captured.length, 1);
    // The forwarded body carries the hoisted top-level system (not a messages turn).
    assert.equal(echo.captured[0].body.system, 'You are Claude Code.');
    assert.ok(!echo.captured[0].body.messages.some(m => m.role === 'system'));
  } finally {
    echo.server.close(); restoreEnv();
  }
});

test('AC10: middle duplicate tool_result forwards as a STUB (loopback echo canary)', async () => {
  const echo = await startEcho(() => ({ status: 200, body: { role: 'assistant', content: 'ok' } }));
  const { createProxy, restoreEnv } = freshProxy(echo.url);
  try {
    const dup = 'CANARY-DUP-' + 'q'.repeat(500);
    const mk = (id, content) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] });
    const messages = [
      { role: 'user', content: 'FIRST TASK' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'Read', input: { file_path: '/c' } }] },
      mk('a1', dup),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a2', name: 'fn', input: { n: 2 } }] },
      mk('a2', 'u2'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a3', name: 'fn', input: { n: 3 } }] },
      mk('a3', 'u3'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a4', name: 'fn', input: { n: 4 } }] },
      mk('a4', 'u4'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a5', name: 'Read', input: { file_path: '/c' } }] },
      mk('a5', dup),
      { role: 'assistant', content: 'done' },
    ];
    const res = fakeRes();
    await drive(createProxy, fakeReq('POST', '/v1/messages', { model: 'claude', max_tokens: 50, messages }, {}), res);
    const fwd = echo.captured[0].body;
    // The stub reached the wire; the newest copy is intact.
    assert.match(fwd.messages[2].content[0].content, /^\[miser: identical to turn 10\]$/);
    assert.equal(fwd.messages[10].content[0].content, dup);
    // No miser-side size rejection: upstream 200 passed through.
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['x-miser-compact-hint']);
  } finally {
    echo.server.close(); restoreEnv();
  }
});

// ---------------------------------------------------------------------------
// AC7 — terminal passthrough: upstream 400/413 pass verbatim; miser never
// synthesizes a size error and never truncates.
// ---------------------------------------------------------------------------
for (const status of [400, 413]) {
  test(`AC7: upstream ${status} passes through verbatim (no miser synthetic error)`, async () => {
    const echo = await startEcho(() => ({
      status,
      body: { type: 'error', error: { type: 'invalid_request_error', message: `upstream ${status}` } },
    }));
    const { createProxy, restoreEnv } = freshProxy(echo.url);
    try {
      const body = { model: 'claude', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] };
      const res = fakeRes();
      await drive(createProxy, fakeReq('POST', '/v1/messages', body, {}), res);
      assert.equal(res.statusCode, status);           // verbatim upstream status
      assert.match(res.body(), new RegExp(`upstream ${status}`)); // verbatim upstream body
      assert.equal(res.headers['x-miser-provider'], 'anthropic');
      // Not a miser-synthesized error shape.
      assert.ok(!/miser_integrity_error|miser_context_overflow/.test(res.body()));
    } finally {
      echo.server.close(); restoreEnv();
    }
  });
}

test('AC5: a client-illegal request (orphan tool_result) is FORWARDED, not miser-rejected', async () => {
  // Upstream (echo) returns 400; miser must pass THAT through, not synthesize its own.
  const echo = await startEcho(() => ({
    status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'messages.0 upstream authoritative' } },
  }));
  const { createProxy, restoreEnv } = freshProxy(echo.url);
  try {
    const body = {
      model: 'claude', max_tokens: 50,
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'x' }] }],
    };
    const res = fakeRes();
    await drive(createProxy, fakeReq('POST', '/v1/messages', body, {}), res);
    // miser forwarded the client-illegal request; Anthropic's error is authoritative.
    assert.equal(echo.captured.length, 1); // it WAS forwarded (not rejected pre-forward)
    assert.equal(res.statusCode, 400);
    assert.match(res.body(), /upstream authoritative/);
    assert.ok(!/miser_integrity_error/.test(res.body()));
  } finally {
    echo.server.close(); restoreEnv();
  }
});

test('health payload reports process vitals', async () => {
  const echo = await startEcho(() => ({ status: 200, body: {} }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, { MISER_CACHE_HINT: '' });
  try {
    const res = fakeRes();
    await drive(createProxy, fakeReq('GET', '/api/miser/health', null, {}), res);
    const payload = JSON.parse(res.body());
    assert.equal(payload.ok, true);
    for (const key of ['uptimeSecs', 'reqPerMin', 'perLegErrors', 'c1DisabledProjects', 'statsFlushLagMs', 'pendingWrites']) {
      assert.ok(key in payload);
    }
    assert.equal(typeof payload.uptimeSecs, 'number');
    assert.equal(typeof payload.reqPerMin, 'number');
    assert.deepEqual(Object.keys(payload.perLegErrors), ['anthropic', 'codex', 'ollama']);
    assert.ok(Array.isArray(payload.c1DisabledProjects));
  } finally {
    echo.server.close(); restoreEnv();
  }
});

test('/api/miser/stats returns 200 with the expected shape', async () => {
  const echo = await startEcho(() => ({ status: 200, body: {} }));
  const { createProxy, restoreEnv } = freshProxy(echo.url);
  try {
    const res = fakeRes();
    await drive(createProxy, fakeReq('GET', '/api/miser/stats', null, {}), res);
    const payload = JSON.parse(res.body());
    assert.equal(res.statusCode, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.days, 7);
    assert.ok(payload.since);
    assert.ok(payload.perTechnique.dedup);
    assert.ok(payload.perTechnique.cacheHint);
    assert.ok(payload.perTechnique.toolPrune);
    assert.deepEqual(payload.perProject, {});
    assert.deepEqual(Object.keys(payload.totals), ['inputTokensRemoved', 'estRemovedTokens', 'cacheBillingDelta', 'appliedCount', 'toolsRemovedCount', 'anthropicEstCostUSD']);
  } finally {
    echo.server.close(); restoreEnv();
  }
});

test('/api/miser/stats reflects degraded persistence after load failure', async () => {
  const file = path.join(os.tmpdir(), `miser-proxy-test-corrupt-stats-${process.pid}-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(file, '{not json', 'utf8');
  const echo = await startEcho(() => ({ status: 200, body: {} }));
  const prevWarn = console.warn;
  console.warn = () => {};
  const { createProxy, restoreEnv } = freshProxy(echo.url, { MISER_STATS_FILE: file });
  try {
    const res = fakeRes();
    await drive(createProxy, fakeReq('GET', '/api/miser/stats', null, {}), res);
    const payload = JSON.parse(res.body());
    assert.equal(res.statusCode, 200);
    assert.equal(payload.ok, false);
    assert.equal(payload.authoritative, false);
    assert.equal(payload.durable, false);
    assert.equal(payload.degraded, true);
    assert.equal(payload.persistence.healthy, false);
    assert.equal(payload.persistence.lastLoadErrored, true);
    assert.match(payload.note, /degraded/);
    assert.ok(payload.perTechnique.dedup);
  } finally {
    console.warn = prevWarn;
    echo.server.close(); restoreEnv();
  }
});

test('/api/miser/stats exposes load failure mutation drop counters', async () => {
  const file = path.join(os.tmpdir(), `miser-proxy-test-corrupt-drop-stats-${process.pid}-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(file, '{not json', 'utf8');
  const echo = await startEcho(() => ({ status: 200, body: {} }));
  const prevWarn = console.warn;
  const prevError = console.error;
  console.warn = () => {};
  console.error = () => {};
  const { createProxy, restoreEnv } = freshProxy(echo.url, { MISER_STATS_FILE: file });
  try {
    const stats = require('../src/stats.js');
    stats.recordStats('seed', { inputTokensRemoved: 1, techniques: { dedup: true } });
    await stats.flushNow();
    stats.recordAnthropicUsage('dropped', 'anthropic', 'model', { input_tokens: 1 });

    const res = fakeRes();
    await drive(createProxy, fakeReq('GET', '/api/miser/stats', null, {}), res);
    const payload = JSON.parse(res.body());
    assert.equal(res.statusCode, 200);
    assert.equal(payload.recordRejections.total, 1);
    assert.equal(payload.recordRejections.loadFailureRefusal, 1);
    assert.deepEqual(payload.recordRejections.byLabel, { usage: 1 });
    assert.ok(payload.recordRejections.firstDroppedAt);
    assert.ok(payload.recordRejections.lastDroppedAt);
  } finally {
    console.warn = prevWarn;
    console.error = prevError;
    echo.server.close(); restoreEnv();
  }
});

test('/api/miser/stats exposes top-level weekly authority rollup without lowering ok', async () => {
  const file = path.join(os.tmpdir(), `miser-proxy-test-weekly-rollup-${process.pid}-${Date.now()}-${Math.random()}.json`);
  const weekKey = '2026-07-19T11:00:00.000Z';
  fs.writeFileSync(file, JSON.stringify({
    __meta: { recordingStartedAt: '2026-07-20' },
    '2026-07-20': {
      alpha: { usage: { anthropic: { model: { input: 10, requests: 1 } } } },
    },
    '2026-07-26': {},
    __weekly: {
      [weekKey]: {
        alpha: { usage: { anthropic: { model: { input: 70, requests: 7 } } } },
      },
    },
  }), 'utf8');
  const echo = await startEcho(() => ({ status: 200, body: {} }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, { MISER_STATS_FILE: file });
  try {
    require('../src/stats.js').__test.setNowFnForTest(() => new Date('2026-07-26T12:00:00.000Z'));
    await require('../src/stats.js').flushNow();
    const res = fakeRes();
    await drive(createProxy, fakeReq('GET', '/api/miser/stats', null, {}), res);
    const payload = JSON.parse(res.body());
    assert.equal(res.statusCode, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.authoritative, true);
    assert.equal(payload.weeklyAuthoritative, false);
    assert.equal(payload.nonAuthoritativeWeekCount, 2);
    assert.deepEqual(payload.nonAuthoritativeReasons, ['inferred_from_legacy_daily', 'missing_weekly_provenance']);
    const week = payload.weekly.priorCompleteWeeks.find(item => item.weekStart === weekKey);
    assert.equal(week.authoritative, false);
    assert.equal(week.nonAuthoritativeReason, 'missing_weekly_provenance');
    assert.equal(week.coverage, undefined);
  } finally {
    echo.server.close(); restoreEnv();
  }
});

test('/api/miser/watch/refresh runs a configured watcher probe on demand', async () => {
  const echo = await startEcho(() => ({ status: 200, body: {} }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, {
    MISER_WATCH_PROBES: JSON.stringify({ ci: { command: 'echo ok', ttl_s: 90, timeout_s: 5 } }),
  });
  try {
    let calls = 0;
    const watcher = {
      async refreshProbe(id) {
        calls += 1;
        assert.equal(id, 'ci');
        return { ok: true, status: 'ok', probe_id: id, in_flight: false };
      },
    };
    const handler = createProxy({ watcher });
    const res = fakeRes();
    const done = res.whenDone();
    handler(fakeReq('POST', '/api/miser/watch/refresh?id=ci', null, {}), res);
    await done;
    assert.equal(calls, 1);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body()), { ok: true, status: 'ok', probe_id: 'ci', in_flight: false });
    assert.equal(echo.captured.length, 0);
  } finally {
    echo.server.close(); restoreEnv();
  }
});

test('/api/miser/watch/refresh returns disabled without calling injected watcher when disabled', async () => {
  const echo = await startEcho(() => ({ status: 200, body: {} }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, {
    MISER_WATCH_ENABLED: 'off',
    MISER_WATCH_PROBES: JSON.stringify({ ci: { command: 'echo should-not-run', ttl_s: 90, timeout_s: 5 } }),
  });
  try {
    let calls = 0;
    const watcher = {
      async refreshProbe() {
        calls += 1;
        throw new Error('disabled endpoint must not call watcher');
      },
    };
    const handler = createProxy({ watcher });
    const res = fakeRes();
    const done = res.whenDone();
    handler(fakeReq('POST', '/api/miser/watch/refresh?id=ci', null, {}), res);
    await done;

    const payload = JSON.parse(res.body());
    assert.equal(calls, 0);
    assert.equal(res.statusCode, 503);
    assert.equal(payload.status, 'disabled');
    assert.equal(payload.disabled, true);
    assert.equal(payload.error.type, 'watch_disabled');
    assert.equal(echo.captured.length, 0);
  } finally {
    echo.server.close(); restoreEnv();
  }
});

test('/api/miser/stats?days=abc returns 400', async () => {
  const echo = await startEcho(() => ({ status: 200, body: {} }));
  const { createProxy, restoreEnv } = freshProxy(echo.url);
  try {
    const res = fakeRes();
    await drive(createProxy, fakeReq('GET', '/api/miser/stats?days=abc', null, {}), res);
    const payload = JSON.parse(res.body());
    assert.equal(res.statusCode, 400);
    assert.equal(payload.error.type, 'stats_error');
  } finally {
    echo.server.close(); restoreEnv();
  }
});

test('/api/miser/stats?days=-1 returns 400', async () => {
  const echo = await startEcho(() => ({ status: 200, body: {} }));
  const { createProxy, restoreEnv } = freshProxy(echo.url);
  try {
    const res = fakeRes();
    await drive(createProxy, fakeReq('GET', '/api/miser/stats?days=-1', null, {}), res);
    const payload = JSON.parse(res.body());
    assert.equal(res.statusCode, 400);
    assert.equal(payload.error.type, 'stats_error');
  } finally {
    echo.server.close(); restoreEnv();
  }
});

test('/api/miser/quota still returns 200', async () => {
  const echo = await startEcho(() => ({ status: 200, body: {} }));
  const { createProxy, restoreEnv } = freshProxy(echo.url);
  try {
    const res = fakeRes();
    await drive(createProxy, fakeReq('GET', '/api/miser/quota', null, {}), res);
    assert.equal(res.statusCode, 200);
    assert.doesNotThrow(() => JSON.parse(res.body()));
  } finally {
    echo.server.close(); restoreEnv();
  }
});

test('v4 P1/C1: path project beats header project for attribution and injection', async () => {
  const echo = await startEcho(() => ({ status: 200, body: { model: 'claude', usage: { input_tokens: 1 } } }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, {
    MISER_CONTEXT_EDIT_PROJECTS: JSON.stringify({ pathproj: true, headerproj: true }),
  });
  try {
    const body = { model: 'claude', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] };
    const res = fakeRes();
    await drive(createProxy, fakeReq('POST', '/p/pathproj/v1/messages', body, { 'x-termdeck-project': 'headerproj' }), res);
    assert.equal(res.statusCode, 200);
    assert.ok(echo.captured[0].body.context_management);
    assert.match(echo.captured[0].headers['anthropic-beta'], /context-management-2025-06-27/);

    const statsRes = fakeRes();
    await drive(createProxy, fakeReq('GET', '/api/miser/stats?days=1', null, {}), statsRes);
    const stats = JSON.parse(statsRes.body());
    assert.ok(stats.usage.pathproj);
    assert.ok(!stats.usage.headerproj);
  } finally {
    echo.server.close(); restoreEnv();
  }
});

test('v4 C1: default env performs zero mutation', async () => {
  const echo = await startEcho(() => ({ status: 200, body: { usage: { input_tokens: 1 } } }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, { MISER_CONTEXT_EDIT_PROJECTS: '' });
  try {
    const res = fakeRes();
    await drive(createProxy, fakeReq('POST', '/p/alpha/v1/messages', {
      model: 'claude', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }],
    }, {}), res);
    assert.equal(res.statusCode, 200);
    assert.ok(!('context_management' in echo.captured[0].body));
    assert.ok(!echo.captured[0].headers['anthropic-beta']);
  } finally {
    echo.server.close(); restoreEnv();
  }
});

test('enforcement canary warns before blocking repeated NACHO ORCH-control poll upstream', async () => {
  const echo = await startEcho(() => ({ status: 200, body: { role: 'assistant', content: 'ok', usage: { input_tokens: 1 } } }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, {
    MISER_ENFORCEMENT: JSON.stringify({
      '*': { mode: 'observe', override: { overrideFile: '/tmp/miser-proxy-test-overrides-never.json' } },
      'nacho-orch': {
        mode: 'throttle',
        poll: { maxLikelyPollsPer10Min: 1, maxLikelyPollsPerHour: 6, minIdlePollSpacingSec: 600 },
        orchControl: { enabled: true, panels: ['sprints'], maxManagementTurnsPerAssignment: 99 },
      },
    }),
  });
  try {
    const config = require('../src/config.js');
    const { buildGuardDeps } = require('../src/budgets.js');
    const guardDeps = buildGuardDeps(config, { createLedger: () => ({ shouldSend: () => false, markSent: () => {} }) });
    const handler = createProxy({ guardDeps });
    const run = (req, res) => {
      const done = res.whenDone();
      handler(req, res);
      return done;
    };
    const firstBody = {
      model: 'claude',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'curl http://127.0.0.1:20128/api/miser/stats' }],
    };
    const secondBody = {
      model: 'claude',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'curl http://127.0.0.1:20128/api/sessions' }],
    };
    const first = fakeRes();
    await run(fakeReq('POST', '/p/nacho-orch--sprints/v1/messages', firstBody, {}), first);
    assert.match(controlMessage(first).text, /poll budget edge/);
    assert.equal(first.headers['x-miser-control-plane'], 'poll-budget-edge');
    assert.equal(first.headers['x-miser-enforcement'], 'poll-budget-edge');
    assert.equal(first.headers['x-miser-enforcement-warning'], 'poll-budget-edge');
    assert.equal(echo.captured.length, 0);

    const second = fakeRes();
    await run(fakeReq('POST', '/p/nacho-orch--sprints/v1/messages', secondBody, {}), second);
    assert.match(controlMessage(second).text, /poll budget exceeded/);
    assert.equal(second.headers['x-miser-enforcement'], 'poll-budget');
    assert.equal(second.headers['x-miser-enforcement-mode'], 'throttle');
    assert.equal(echo.captured.length, 0);
  } finally {
    echo.server.close(); restoreEnv();
  }
});

test('enforcement warning on Anthropic streaming requests returns SSE control-plane message', async () => {
  const echo = await startEcho(() => ({ status: 200, body: { role: 'assistant', content: 'ok', usage: { input_tokens: 1 } } }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, {
    MISER_ENFORCEMENT: JSON.stringify({
      '*': { mode: 'observe', override: { overrideFile: '/tmp/miser-proxy-test-overrides-never.json' } },
      'nacho-orch': {
        mode: 'throttle',
        poll: { maxLikelyPollsPer10Min: 1, maxLikelyPollsPerHour: 6, minIdlePollSpacingSec: 600 },
        orchControl: { enabled: true, panels: ['sprints'], maxManagementTurnsPerAssignment: 99 },
      },
    }),
  });
  try {
    const config = require('../src/config.js');
    const { buildGuardDeps } = require('../src/budgets.js');
    const guardDeps = buildGuardDeps(config, { createLedger: () => ({ shouldSend: () => false, markSent: () => {} }) });
    const handler = createProxy({ guardDeps });
    const res = fakeRes();
    const done = res.whenDone();
    handler(fakeReq('POST', '/p/nacho-orch--sprints/v1/messages', {
      model: 'claude',
      max_tokens: 50,
      stream: true,
      messages: [{ role: 'user', content: 'curl http://127.0.0.1:20128/api/miser/stats' }],
    }, {}), res);
    await done;

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-miser-control-plane'], 'poll-budget-edge');
    assert.equal(res.headers['x-miser-enforcement'], 'poll-budget-edge');
    assert.equal(res.headers['x-miser-enforcement-warning'], 'poll-budget-edge');
    assert.equal(res.headers['content-type'], 'text/event-stream');
    assert.match(res.body(), /^event: message_start/m);
    assert.match(sseText(res.body()), /poll budget edge/);
    assert.match(sseText(res.body()), /Do not retry/);
    assert.equal(echo.captured.length, 0);
  } finally {
    echo.server.close(); restoreEnv();
  }
});

test('redirect shadow classifies ORCH gh run view but passes upstream response through', async () => {
  const upstreamBody = {
    id: 'msg_upstream_shadow',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-test',
    content: [{ type: 'text', text: 'upstream ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 7, output_tokens: 3 },
  };
  const echo = await startEcho(() => ({ status: 200, body: upstreamBody }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, {
    MISER_ENFORCEMENT: JSON.stringify({
      '*': {
        mode: 'observe',
        redirect: { mode: 'shadow' },
        override: { overrideFile: '/tmp/miser-proxy-test-overrides-never.json' },
      },
    }),
  });
  try {
    const config = require('../src/config.js');
    const { buildGuardDeps } = require('../src/budgets.js');
    const guardDeps = buildGuardDeps(config, { createLedger: () => ({ shouldSend: () => false, markSent: () => {} }) });
    const handler = createProxy({ guardDeps });
    const res = fakeRes();
    const done = res.whenDone();
    handler(fakeReq('POST', '/p/aetheria--orch/v1/messages', {
      model: 'claude-sonnet-5-test',
      max_tokens: 50,
      system: 'You are the ORCH controller.',
      messages: [
        { role: 'user', content: 'MISER_ASSIGNMENT=A check CI once' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'gh run view 123 --log' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'CI output' }] },
      ],
    }, {}), res);
    await done;

    assert.equal(echo.captured.length, 1);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body()), upstreamBody);
    const snapshot = guardDeps.enforcementState.snapshot();
    assert.equal(snapshot.redirect.wouldSynthesize, 1);
    assert.equal(snapshot.recentEvents[0].commandClass, 'POLL_CI');
    assert.equal(snapshot.recentEvents[0].would_synthesize, true);
  } finally {
    echo.server.close(); restoreEnv();
  }
});

function redirectTurnBody(command, extra = {}) {
  return {
    model: 'claude-sonnet-5-test',
    max_tokens: 50,
    system: 'You are the ORCH controller.',
    ...extra,
    messages: [
      { role: 'user', content: 'MISER_ASSIGNMENT=A check watcher-backed state once' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'poll command output' }] },
    ],
  };
}

function redirectEnv(mode, watchDir, opts = {}) {
  const overrideFile = opts.overrideFile || '/tmp/miser-proxy-test-overrides-never.json';
  const projectPolicy = opts.projectPolicy || null;
  const config = {
    '*': {
      mode: 'observe',
      redirect: { mode },
      override: { overrideFile },
    },
  };
  if (projectPolicy) config.aetheria = projectPolicy;
  return {
    MISER_WATCH_DIR: watchDir,
    MISER_ENFORCEMENT: JSON.stringify(config),
  };
}

async function driveRedirectCase({ mode, body, watchDir, echoBody = null, overrideFile = null, projectPolicy = null }) {
  const upstreamBody = echoBody || {
    id: `msg_upstream_${mode}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-test',
    content: [{ type: 'text', text: `upstream ${mode}` }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const echo = await startEcho(() => ({ status: 200, body: upstreamBody }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, redirectEnv(mode, watchDir, { overrideFile, projectPolicy }));
  try {
    const config = require('../src/config.js');
    const { buildGuardDeps } = require('../src/budgets.js');
    const guardDeps = buildGuardDeps(config, { createLedger: () => ({ shouldSend: () => false, markSent: () => {} }) });
    const handler = createProxy({ guardDeps });
    const res = fakeRes();
    const done = res.whenDone();
    handler(fakeReq('POST', '/p/aetheria--orch/v1/messages', body, {}), res);
    await done;
    return { res, echo, upstreamBody, guardDeps, cleanup: () => { echo.server.close(); restoreEnv(); } };
  } catch (err) {
    echo.server.close(); restoreEnv();
    throw err;
  }
}

test('shadow-port canary lets non-ORCH roles reach upstream while a sibling ORCH is redirected', async (t) => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miser-role-canary-'));
  const upstreamBody = {
    id: 'msg_role_canary', type: 'message', role: 'assistant',
    model: 'claude-sonnet-5-test', content: [{ type: 'text', text: 'worker allowed' }],
    stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
  };
  const echo = await startEcho(() => ({ status: 200, body: upstreamBody }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, redirectEnv('enforce', watchDir, {
    projectPolicy: {
      mode: 'block',
      orchControl: { enabled: true, panels: [], warnManagementTurnsPerAssignment: 1, maxManagementTurnsPerAssignment: 1 },
    },
  }));
  let server;
  try {
    const config = require('../src/config.js');
    const { buildGuardDeps } = require('../src/budgets.js');
    const guardDeps = buildGuardDeps(config, { createLedger: () => ({ shouldSend: () => false, markSent: () => {} }) });
    server = http.createServer(createProxy({ guardDeps }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    assert.notEqual(port, 20128);

    const post = (panel, body) => new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port, method: 'POST', path: `/p/aetheria--${panel}/v1/messages`,
        headers: { 'content-type': 'application/json' },
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks)) }));
        res.on('error', reject);
      });
      req.setTimeout(5000, () => req.destroy(new Error('shadow-port canary timed out')));
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });

    const orch = await post('orch', redirectTurnBody('gh run view 123 --log'));
    assert.equal(orch.headers['x-miser-enforcement'], 'zero-llm-redirect');
    assert.equal(echo.captured.length, 0);
    const cases = [
      ['architect', 'Assistant.'],
      ['Aetheria-Concierge-UX-architect', 'Assistant.'],
      ['researcher', 'Assistant.'],
      ['builder', 'Assistant.'],
      ['evaluator', 'Assistant.'],
      ['orch', 'You are a bounded Claude architect lane.'],
    ];
    for (const [panel, system] of cases) {
      for (const command of ['gh run view 123 --log', 'proposal approval gate']) {
        const response = await post(panel, redirectTurnBody(command, { system }));
        assert.equal(response.status, 200, `${panel}/${command}`);
        assert.deepEqual(response.body, upstreamBody, `${panel}/${command}`);
        assert.equal(response.headers['x-miser-enforcement'], undefined);
        assert.equal(response.headers['x-miser-redirect'], undefined);
      }
    }
    assert.equal(echo.captured.length, cases.length * 2);

    const quoted = redirectTurnBody('gh run view 123 --log');
    quoted.messages[0].content = '```text\nROLE: builder\n```';
    const reassigned = redirectTurnBody('gh run view 123 --log', { system: 'You are the architect.' });
    reassigned.messages.unshift(
      { role: 'user', content: 'ROLE: ORCH' },
      { role: 'assistant', content: 'Reassigned.' },
    );
    const longReminder = redirectTurnBody('gh run view 123 --log');
    longReminder.messages[0].content = `<system-reminder>\nROLE: builder\n${'x'.repeat(5000)}\n</system-reminder>`;
    for (const body of [quoted, reassigned, longReminder]) {
      const response = await post('orch', body);
      assert.equal(response.headers['x-miser-enforcement'], 'zero-llm-redirect');
    }
    const unsafeWorker = redirectTurnBody('systemctl --user restart miser', { system: 'You are the architect.' });
    const safetyResponse = await post('architect', unsafeWorker);
    assert.equal(safetyResponse.headers['x-miser-enforcement'], 'orch-hard-safety');
    const notification = redirectTurnBody('gh run view 123 --log');
    notification.messages.splice(1, 0, { role: 'user', content: '<task-notification>\nROLE: builder\n</task-notification>' });
    const nestedReminder = redirectTurnBody('gh run view 123 --log');
    nestedReminder.messages[0].content = '<system-reminder><system-reminder>context</system-reminder>\nROLE: builder\n</system-reminder>';
    const lateDeclaration = redirectTurnBody('gh run view 123 --log');
    lateDeclaration.messages.splice(1, 0, { role: 'user', content: 'ROLE: builder' });
    for (const body of [notification, nestedReminder, lateDeclaration]) {
      assert.equal((await post('orch', body)).headers['x-miser-enforcement'], 'zero-llm-redirect');
    }
    // Exercise the reported observe/enforce interaction on the same real HTTP
    // listener, with ORCH budgeting disabled so only the redirect can block it.
    guardDeps.enforcementConfig.aetheria.mode = 'observe';
    guardDeps.enforcementConfig.aetheria.orchControl.enabled = false;
    const mixedCommand = redirectTurnBody('gh run view 123 --log # git commit');
    assert.equal((await post('orch', mixedCommand)).headers['x-miser-enforcement'], 'zero-llm-redirect');
    assert.equal(echo.captured.length, cases.length * 2, 'R1/R2 bypass attempts never reach upstream');
    t.diagnostic(`shadow=127.0.0.1:${port} mock-upstream=127.0.0.1:${echo.port}; worker passthrough=12; ORCH redirect=8 (including observe/enforce); worker hard-safety block=1`);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => echo.server.close(resolve));
    restoreEnv();
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('redirect off passes poll/control turns through to upstream', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-redirect-off-${process.pid}-`));
  try {
    fs.writeFileSync(path.join(watchDir, 'ci.md'), 'VERDICT: OK\nfrom watcher\n', 'utf8');
    const ctx = await driveRedirectCase({
      mode: 'off',
      watchDir,
      body: redirectTurnBody('gh run view 123 --log'),
    });
    try {
      assert.equal(ctx.echo.captured.length, 1);
      assert.equal(ctx.res.statusCode, 200);
      assert.deepEqual(JSON.parse(ctx.res.body()), ctx.upstreamBody);
      assert.ok(!ctx.res.headers['x-miser-redirect']);
    } finally {
      ctx.cleanup();
    }
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('redirect warn returns synthetic control-plane guidance without upstream', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-redirect-warn-${process.pid}-`));
  try {
    fs.writeFileSync(path.join(watchDir, 'ci.md'), 'VERDICT: OK\nfrom watcher\n', 'utf8');
    const ctx = await driveRedirectCase({
      mode: 'warn',
      watchDir,
      body: redirectTurnBody('gh run view 123 --log'),
    });
    try {
      assert.equal(ctx.echo.captured.length, 0);
      assert.equal(ctx.res.headers['x-miser-control-plane'], 'zero-llm-redirect');
      assert.equal(ctx.res.headers['x-miser-redirect'], 'zero-llm-redirect');
      assert.equal(ctx.res.headers['x-miser-redirect-mode'], 'warn');
      assert.equal(ctx.res.headers['x-miser-redirect-class'], 'POLL_CI');
      assert.equal(ctx.res.headers['x-miser-watch-artifact'], path.join(watchDir, 'ci.md'));
      const { text } = controlMessage(ctx.res);
      assert.match(text, /reason=zero-llm-redirect/);
      assert.match(text, new RegExp(path.join(watchDir, 'ci.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(text, /Do not retry/);
      assert.match(text, /Read .*ci\.md out-of-band/);
      assert.equal(ctx.guardDeps.enforcementState.snapshot().redirect.controlErrors, 1);
    } finally {
      ctx.cleanup();
    }
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('redirect enforce returns control-plane artifact pointer and avoids upstream', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-redirect-enforce-${process.pid}-`));
  try {
    fs.writeFileSync(path.join(watchDir, 'ci.md'), 'VERDICT: OK\nprobe: ci\nOUTPUT_HEAD:\nall green\n', 'utf8');
    const ctx = await driveRedirectCase({
      mode: 'enforce',
      watchDir,
      body: redirectTurnBody('gh run view 123 --log'),
    });
    try {
      const payload = JSON.parse(ctx.res.body());
      assert.equal(ctx.echo.captured.length, 0);
      assert.equal(ctx.res.headers['x-miser-enforcement'], 'zero-llm-redirect');
      assert.equal(ctx.res.headers['x-miser-redirect-mode'], 'enforce');
      assert.equal(ctx.res.headers['x-miser-watch-artifact-state'], 'unknown');
      const { text } = controlMessage(ctx.res);
      assert.match(text, /command_class: POLL_CI/);
      assert.match(text, new RegExp(path.join(watchDir, 'ci.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(text, /operator_action: read_watcher_artifact_out_of_band/);
      assert.match(text, /Do not retry/);
      assert.equal(text.includes('VERDICT: OK'), false);
      assert.equal(ctx.guardDeps.enforcementState.snapshot().recentEvents[0].decision, 'control_error');
    } finally {
      ctx.cleanup();
    }
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('redirect enforce on streaming requests returns SSE control-plane guidance', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-redirect-sse-${process.pid}-`));
  try {
    fs.writeFileSync(path.join(watchDir, 'ci.md'), 'VERDICT: OK\nstream artifact\n', 'utf8');
    const ctx = await driveRedirectCase({
      mode: 'enforce',
      watchDir,
      body: redirectTurnBody('gh run view 123 --log', { stream: true }),
    });
    try {
      assert.equal(ctx.echo.captured.length, 0);
      assert.equal(ctx.res.statusCode, 200);
      assert.equal(ctx.res.headers['content-type'], 'text/event-stream');
      assert.equal(ctx.res.headers['x-miser-redirect-mode'], 'enforce');
      assert.match(ctx.res.body(), /^event: message_start/m);
      assert.match(sseText(ctx.res.body()), /miser_control_plane_error/);
      assert.match(sseText(ctx.res.body()), /Do not retry/);
    } finally {
      ctx.cleanup();
    }
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('redirect enforce with missing watcher artifact returns operator control error', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-redirect-missing-${process.pid}-`));
  try {
    const ctx = await driveRedirectCase({
      mode: 'enforce',
      watchDir,
      body: redirectTurnBody('curl http://127.0.0.1:20128/api/miser/stats'),
    });
    try {
      const artifact = path.join(watchDir, 'miser.md');
      assert.equal(ctx.echo.captured.length, 0);
      assert.equal(ctx.res.headers['x-miser-watch-artifact'], artifact);
      assert.equal(ctx.res.headers['x-miser-watch-artifact-state'], 'missing');
      const { text } = controlMessage(ctx.res);
      assert.match(text, /watcher artifact missing/);
      assert.match(text, /operator_action: refresh_or_repair_watcher_out_of_band/);
      assert.match(text, /Refresh or repair/);
      assert.equal(ctx.guardDeps.enforcementState.snapshot().recentEvents[0].artifactMissing, true);
    } finally {
      ctx.cleanup();
    }
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('redirect enforce with stale watcher artifact returns operator control error', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-redirect-stale-${process.pid}-`));
  try {
    fs.writeFileSync(path.join(watchDir, 'ci.md'), 'VERDICT: OK\nstale artifact\n', 'utf8');
    fs.writeFileSync(path.join(watchDir, 'ci.json'), JSON.stringify({
      generated_at: '1970-01-01T00:00:00.000Z',
      ttl_s: 1,
      status: 'ok',
    }), 'utf8');
    const ctx = await driveRedirectCase({
      mode: 'enforce',
      watchDir,
      body: redirectTurnBody('gh run view 123 --log'),
    });
    try {
      assert.equal(ctx.echo.captured.length, 0);
      assert.equal(ctx.res.headers['x-miser-watch-artifact-state'], 'stale');
      const { text } = controlMessage(ctx.res);
      assert.match(text, /watcher artifact stale/);
      assert.match(text, /stale/);
      assert.match(text, /operator_action: refresh_or_repair_watcher_out_of_band/);
      assert.match(text, /Refresh or repair/);
    } finally {
      ctx.cleanup();
    }
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('repeated redirectable poll requests return bounded synthetic control guidance', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-redirect-repeat-${process.pid}-`));
  try {
    fs.writeFileSync(path.join(watchDir, 'ci.md'), 'VERDICT: OK\nfrom watcher\n', 'utf8');
    const echo = await startEcho(() => ({ status: 200, body: { ok: true } }));
    const { createProxy, restoreEnv } = freshProxy(echo.url, redirectEnv('enforce', watchDir));
    try {
      const config = require('../src/config.js');
      const { buildGuardDeps } = require('../src/budgets.js');
      const guardDeps = buildGuardDeps(config, { createLedger: () => ({ shouldSend: () => false, markSent: () => {} }) });
      const handler = createProxy({ guardDeps });
      for (let i = 0; i < 2; i++) {
        const res = fakeRes();
        const done = res.whenDone();
        handler(fakeReq('POST', '/p/aetheria--orch/v1/messages', redirectTurnBody('gh run view 123 --log'), {}), res);
        await done;
        const { text } = controlMessage(res);
        assert.match(text, /miser_control_plane_error/);
        assert.match(text, /Do not retry/);
      }
      assert.equal(echo.captured.length, 0);
      assert.equal(guardDeps.enforcementState.snapshot().redirect.controlErrors, 2);
    } finally {
      echo.server.close();
      restoreEnv();
    }
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('/v1/messages redirect path never refreshes or inspects the live watcher object', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-redirect-no-watch-refresh-${process.pid}-`));
  try {
    const echo = await startEcho(() => ({ status: 200, body: { ok: true } }));
    const { createProxy, restoreEnv } = freshProxy(echo.url, redirectEnv('enforce', watchDir));
    try {
      const config = require('../src/config.js');
      const { buildGuardDeps } = require('../src/budgets.js');
      const guardDeps = buildGuardDeps(config, { createLedger: () => ({ shouldSend: () => false, markSent: () => {} }) });
      const watcher = {
        enabled: true,
        pathsFor() { assert.fail('pathsFor must not run inside /v1/messages'); },
        refreshProbe() { assert.fail('refreshProbe must not run inside /v1/messages'); },
        listProbes() { assert.fail('listProbes must not run inside /v1/messages'); },
        status() { assert.fail('status must not run inside /v1/messages'); },
      };
      const handler = createProxy({ guardDeps, watcher });
      const res = fakeRes();
      const done = res.whenDone();
      handler(fakeReq('POST', '/p/aetheria--orch/v1/messages', redirectTurnBody('gh run view 123 --log'), {}), res);
      await done;
      assert.match(controlMessage(res).text, new RegExp(path.join(watchDir, 'ci.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(echo.captured.length, 0);
    } finally {
      echo.server.close();
      restoreEnv();
    }
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('watch status endpoint inventories artifacts without running refresh', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-watch-status-${process.pid}-`));
  try {
    const probes = [{ id: 'ci', command: 'exit 77', ttl_s: 60, interval_s: 60, timeout_s: 1 }];
    const echo = await startEcho(() => ({ status: 200, body: { ok: true } }));
    const { createProxy, restoreEnv } = freshProxy(echo.url, {
      MISER_WATCH_DIR: watchDir,
      MISER_WATCH_PROBES: JSON.stringify(probes),
    });
    try {
      const handler = createProxy();
      const res = fakeRes();
      const done = res.whenDone();
      handler(fakeReq('GET', '/api/miser/watch/status', null, {}), res);
      await done;
      const payload = JSON.parse(res.body());
      assert.equal(res.statusCode, 200);
      assert.equal(payload.status, 'missing');
      assert.equal(payload.probe_count, 1);
      assert.equal(payload.probes[0].probe_id, 'ci');
      assert.equal(payload.probes[0].state, 'missing');
      assert.equal(fs.existsSync(path.join(watchDir, 'ci.raw.txt')), false);
      assert.equal(echo.captured.length, 0);
    } finally {
      echo.server.close();
      restoreEnv();
    }
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('redirect warn still returns control error when a project override is active', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-redirect-warn-override-${process.pid}-`));
  const overrideFile = path.join(watchDir, 'overrides.json');
  try {
    fs.writeFileSync(path.join(watchDir, 'ci.md'), 'VERDICT: OK\nfrom watcher\n', 'utf8');
    fs.writeFileSync(overrideFile, JSON.stringify({ aetheria: true }), 'utf8');
    const ctx = await driveRedirectCase({
      mode: 'warn',
      watchDir,
      overrideFile,
      body: redirectTurnBody('gh run view 123 --log'),
    });
    try {
      assert.equal(ctx.echo.captured.length, 0);
      assert.equal(ctx.res.headers['x-miser-redirect-mode'], 'warn');
      assert.match(controlMessage(ctx.res).text, /operator_action: read_watcher_artifact_out_of_band/);
    } finally {
      ctx.cleanup();
    }
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('redirect enforce still returns control error when a project override is active', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-redirect-enforce-override-${process.pid}-`));
  const overrideFile = path.join(watchDir, 'overrides.json');
  try {
    fs.writeFileSync(path.join(watchDir, 'ci.md'), 'VERDICT: OK\noverride window artifact\n', 'utf8');
    fs.writeFileSync(overrideFile, JSON.stringify({ aetheria: true }), 'utf8');
    const ctx = await driveRedirectCase({
      mode: 'enforce',
      watchDir,
      overrideFile,
      body: redirectTurnBody('gh run view 123 --log'),
    });
    try {
      assert.equal(ctx.echo.captured.length, 0);
      assert.equal(ctx.res.headers['x-miser-redirect-mode'], 'enforce');
      assert.match(controlMessage(ctx.res).text, new RegExp(path.join(watchDir, 'ci.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      ctx.cleanup();
    }
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('override still bypasses normal block enforcement for non-redirect turns', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-redirect-override-block-${process.pid}-`));
  const overrideFile = path.join(watchDir, 'overrides.json');
  try {
    fs.writeFileSync(overrideFile, JSON.stringify({ aetheria: true }), 'utf8');
    const ctx = await driveRedirectCase({
      mode: 'enforce',
      watchDir,
      overrideFile,
      projectPolicy: {
        mode: 'throttle',
        redirect: { mode: 'enforce' },
        override: { overrideFile },
        orchControl: {
          enabled: true,
          panels: ['orch'],
          maxManagementTurnsPerAssignment: 0,
          warnManagementTurnsPerAssignment: 99,
        },
      },
      body: {
        model: 'claude-sonnet-5-test',
        max_tokens: 50,
        system: 'You are the ORCH controller.',
        messages: [{ role: 'user', content: 'proposal mediation for this assignment' }],
      },
    });
    try {
      assert.equal(ctx.echo.captured.length, 1);
      assert.equal(ctx.res.statusCode, 200);
      assert.deepEqual(JSON.parse(ctx.res.body()), ctx.upstreamBody);
      assert.ok(!ctx.res.headers['x-miser-redirect']);
      assert.ok(!ctx.res.headers['x-miser-enforcement']);
    } finally {
      ctx.cleanup();
    }
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('redirect enforce exposes reason headers before generic poll-budget responses', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-redirect-precedence-${process.pid}-`));
  try {
    fs.writeFileSync(path.join(watchDir, 'miser.md'), 'VERDICT: OK\nbudget-edge artifact\n', 'utf8');
    const ctx = await driveRedirectCase({
      mode: 'enforce',
      watchDir,
      projectPolicy: {
        mode: 'throttle',
        redirect: { mode: 'enforce' },
        override: { overrideFile: '/tmp/miser-proxy-test-overrides-never.json' },
        poll: { maxLikelyPollsPer10Min: 1, maxLikelyPollsPerHour: 1, minIdlePollSpacingSec: 600 },
        orchControl: {
          enabled: true,
          panels: ['orch'],
          maxManagementTurnsPerAssignment: 99,
        },
      },
      body: redirectTurnBody('curl http://127.0.0.1:20128/api/miser/stats'),
    });
    try {
      assert.equal(ctx.echo.captured.length, 0);
      assert.equal(ctx.res.headers['x-miser-redirect-mode'], 'enforce');
      assert.equal(ctx.res.headers['x-miser-enforcement'], 'zero-llm-redirect');
      assert.notEqual(ctx.res.headers['x-miser-enforcement-warning'], 'poll-budget-edge');
      const { text } = controlMessage(ctx.res);
      assert.match(text, /reason=zero-llm-redirect/);
      assert.match(text, new RegExp(path.join(watchDir, 'miser.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      ctx.cleanup();
    }
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('hard non-redirect ORCH budget blocks still avoid upstream', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-redirect-hard-block-${process.pid}-`));
  try {
    const ctx = await driveRedirectCase({
      mode: 'enforce',
      watchDir,
      projectPolicy: {
        mode: 'throttle',
        redirect: { mode: 'enforce' },
        override: { overrideFile: '/tmp/miser-proxy-test-overrides-never.json' },
        orchControl: {
          enabled: true,
          panels: ['orch'],
          maxManagementTurnsPerAssignment: 0,
          warnManagementTurnsPerAssignment: 99,
        },
      },
      body: {
        model: 'claude-sonnet-5-test',
        max_tokens: 50,
        system: 'You are the ORCH controller.',
        messages: [{ role: 'user', content: 'proposal mediation for this assignment' }],
      },
    });
    try {
      assert.equal(ctx.echo.captured.length, 0);
      assert.equal(ctx.res.headers['x-miser-enforcement'], 'orch-assignment-budget');
      assert.ok(!ctx.res.headers['x-miser-redirect']);
      const { text } = controlMessage(ctx.res);
      assert.match(text, /ORCH assignment management budget exceeded/);
      assert.match(text, /retryable=false/);
      assert.match(text, /Do not retry/);
    } finally {
      ctx.cleanup();
    }
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('fresh ORCH boot setup prompt is forwarded before assignment budget enforcement', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-orch-boot-setup-${process.pid}-`));
  try {
    const upstreamBody = {
      id: 'msg_orch_boot_ok',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-test',
      content: [{ type: 'text', text: '[TermDeck-ORCH-CANARY] online; waiting.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const ctx = await driveRedirectCase({
      mode: 'enforce',
      watchDir,
      echoBody: upstreamBody,
      projectPolicy: {
        mode: 'throttle',
        redirect: { mode: 'enforce' },
        override: { overrideFile: '/tmp/miser-proxy-test-overrides-never.json' },
        orchControl: {
          enabled: true,
          panels: ['orch'],
          maxManagementTurnsPerAssignment: 0,
          warnManagementTurnsPerAssignment: 99,
        },
      },
      body: {
        model: 'claude-sonnet-5-test',
        max_tokens: 50,
        system: 'You are the ORCH controller.',
        messages: [{
          role: 'user',
          content: [
            'PANEL_BOOT',
            '# TermDeck ORCH Canary - Boot Prompt',
            'You are TermDeck-ORCH-CANARY.',
            'Read the handoff, reply online, then wait. Do not run tools.',
          ].join('\n'),
        }],
      },
    });
    try {
      assert.equal(ctx.echo.captured.length, 1);
      assert.equal(ctx.res.statusCode, 200);
      assert.deepEqual(JSON.parse(ctx.res.body()), upstreamBody);
      assert.ok(!ctx.res.headers['x-miser-enforcement']);
    } finally {
      ctx.cleanup();
    }
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('redirect enforce does not redirect DISPATCH_OK commands', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-redirect-dispatch-${process.pid}-`));
  try {
    const ctx = await driveRedirectCase({
      mode: 'enforce',
      watchDir,
      body: redirectTurnBody('date'),
    });
    try {
      assert.equal(ctx.echo.captured.length, 1);
      assert.equal(ctx.res.statusCode, 200);
      assert.deepEqual(JSON.parse(ctx.res.body()), ctx.upstreamBody);
      assert.ok(!ctx.res.headers['x-miser-redirect']);
    } finally {
      ctx.cleanup();
    }
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('redirect enforce does not redirect NEUTRAL turns', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-redirect-neutral-${process.pid}-`));
  try {
    const ctx = await driveRedirectCase({
      mode: 'enforce',
      watchDir,
      body: {
        model: 'claude-sonnet-5-test',
        max_tokens: 50,
        system: 'You are the ORCH controller.',
        messages: [{ role: 'user', content: 'Summarize the last design decision.' }],
      },
    });
    try {
      assert.equal(ctx.echo.captured.length, 1);
      assert.equal(ctx.res.statusCode, 200);
      assert.deepEqual(JSON.parse(ctx.res.body()), ctx.upstreamBody);
      assert.ok(!ctx.res.headers['x-miser-redirect']);
    } finally {
      ctx.cleanup();
    }
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('redirect enforce does not redirect forced tool_choice turns', async () => {
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-redirect-tool-choice-${process.pid}-`));
  try {
    fs.writeFileSync(path.join(watchDir, 'ci.md'), 'VERDICT: OK\nfrom watcher\n', 'utf8');
    const ctx = await driveRedirectCase({
      mode: 'enforce',
      watchDir,
      body: redirectTurnBody('gh run view 123 --log', {
        tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
        tool_choice: { type: 'tool', name: 'Bash' },
      }),
    });
    try {
      assert.equal(ctx.echo.captured.length, 1);
      assert.equal(ctx.res.statusCode, 200);
      assert.deepEqual(JSON.parse(ctx.res.body()), ctx.upstreamBody);
      assert.ok(!ctx.res.headers['x-miser-redirect']);
      assert.equal(ctx.guardDeps.enforcementState.snapshot().redirect.wouldSynthesize, 0);
    } finally {
      ctx.cleanup();
    }
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test('v4 C1: beta merge avoids duplicates and client context_management is never overridden', async () => {
  const echo = await startEcho(() => ({ status: 200, body: { usage: { input_tokens: 1 } } }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, {
    MISER_CONTEXT_EDIT_PROJECTS: JSON.stringify({ alpha: true }),
  });
  try {
    const body = {
      model: 'claude',
      max_tokens: 50,
      context_management: { edits: [] },
      messages: [{ role: 'user', content: 'hi' }],
    };
    const res = fakeRes();
    await drive(createProxy, fakeReq('POST', '/p/alpha/v1/messages', body, {
      'anthropic-beta': 'foo, context-management-2025-06-27',
    }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(echo.captured[0].body.context_management, { edits: [] });
    assert.equal(echo.captured[0].headers['anthropic-beta'], 'foo, context-management-2025-06-27');
  } finally {
    echo.server.close(); restoreEnv();
  }
});

test('v4 M1/C1: usage and applied_edits are captured from non-stream Anthropic JSON', async () => {
  const echo = await startEcho(() => ({
    status: 200,
    body: {
      model: 'claude-sonnet-4',
      usage: {
        input_tokens: 3,
        output_tokens: 4,
        cache_read_input_tokens: 5,
        cache_creation: { ephemeral_1h_input_tokens: 6 },
      },
      context_management: {
        applied_edits: [{ cleared_tool_uses: 2, cleared_input_tokens: 8000 }],
      },
    },
  }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, {
    MISER_CONTEXT_EDIT_PROJECTS: JSON.stringify({ alpha: true }),
  });
  try {
    const res = fakeRes();
    await drive(createProxy, fakeReq('POST', '/p/alpha/v1/messages', {
      model: 'claude', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }],
    }, {}), res);
    const statsRes = fakeRes();
    await drive(createProxy, fakeReq('GET', '/api/miser/stats?days=1&project=alpha', null, {}), statsRes);
    const stats = JSON.parse(statsRes.body());
    assert.deepEqual(stats.usage.alpha.anthropic['claude-sonnet-4'], {
      requests: 1,
      input: 3,
      output: 4,
      cacheRead: 5,
      cacheWrite1h: 6,
    });
    assert.deepEqual(stats.perProject.alpha.contextManagement, {
      clearedToolUses: 2,
      clearedInputTokens: 8000,
      editCount: 1,
    });
  } finally {
    echo.server.close(); restoreEnv();
  }
});

test('v4 C1: injected non-429 non-2xx passes through and writes no usage stats', async () => {
  const echo = await startEcho(() => ({
    status: 400,
    body: { error: { type: 'invalid_request_error' }, usage: { input_tokens: 99 } },
  }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, {
    MISER_CONTEXT_EDIT_PROJECTS: JSON.stringify({ alpha: true }),
  });
  try {
    const res = fakeRes();
    await drive(createProxy, fakeReq('POST', '/p/alpha/v1/messages', {
      model: 'claude', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }],
    }, {}), res);
    assert.equal(res.statusCode, 400);
    assert.ok(echo.captured[0].body.context_management);

    const statsRes = fakeRes();
    await drive(createProxy, fakeReq('GET', '/api/miser/stats?days=1&project=alpha', null, {}), statsRes);
    const stats = JSON.parse(statsRes.body());
    assert.deepEqual(stats.usage, {});
    assert.deepEqual(stats.perProject, {});
    assert.equal(stats.perTechnique.dedup.appliedCount, 0);
    assert.equal(stats.perTechnique.cacheHint.appliedCount, 0);
    assert.equal(stats.perTechnique.toolPrune.appliedCount, 0);
  } finally {
    echo.server.close(); restoreEnv();
  }
});

test('v4 C1: injected 429 returns Anthropic unavailable without cross-provider fallback', async () => {
  const calls = [];
  const deps = {
    transports: {
      anthropic: (messages, body, headers) => {
        calls.push({ name: 'anthropic', body, headers });
        const err = new Error('anthropic 429');
        err.statusCode = 429;
        return Promise.reject(err);
      },
      codex: (codexReq, bearer, res) => {
        calls.push({ name: 'codex', codexReq, bearer });
        res.writeHead(200, { 'x-miser-provider': 'codex' });
        res.end();
        return Promise.resolve();
      },
      ollama: () => { throw new Error('ollama must not be called'); },
    },
    getBearer: () => ({ token: 'fake', accountId: 'acct' }),
    ollamaCap: 32000,
  };
  const echo = await startEcho(() => ({ status: 200, body: {} }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, {
    MISER_CONTEXT_EDIT_PROJECTS: JSON.stringify({ alpha: true }),
  });
  try {
    const res = fakeRes();
    await drive(() => createProxy(deps), fakeReq('POST', '/p/alpha/v1/messages', {
      model: 'claude', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }],
    }, {}), res);
    assert.deepEqual(calls.map(c => c.name), ['anthropic']);
    assert.ok(calls[0].body.context_management);
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['x-miser-provider'], 'anthropic');
    assert.equal(res.headers['x-miser-fallback'], 'disabled');
    assert.equal(JSON.parse(res.body()).error.type, 'miser_provider_unavailable');
  } finally {
    echo.server.close(); restoreEnv();
  }
});

test('v4 C1: breaker trips on 400,400,400 and disables later injection', async () => {
  const echo = await startEcho(() => ({ status: 400, body: { error: 'bad beta' } }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, {
    MISER_CONTEXT_EDIT_PROJECTS: JSON.stringify({ alpha: true }),
  });
  try {
    for (let i = 0; i < 4; i++) {
      const res = fakeRes();
      await drive(createProxy, fakeReq('POST', '/p/alpha/v1/messages', {
        model: 'claude', max_tokens: 50, messages: [{ role: 'user', content: `hi ${i}` }],
      }, {}), res);
    }
    assert.ok(echo.captured[0].body.context_management);
    assert.ok(echo.captured[1].body.context_management);
    assert.ok(echo.captured[2].body.context_management);
    assert.ok(!echo.captured[3].body.context_management);
  } finally {
    echo.server.close(); restoreEnv();
  }
});

// ---------------------------------------------------------------------------
// Sprint B — G3 budget block + B6 drift, full proxy chain (AC2/AC4/AC5)
// ---------------------------------------------------------------------------

const SPRINT_B_PRICING = JSON.stringify({ testmodel: { inputPerMTok: 1_000_000 } }); // $1/input token

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Must be called AFTER freshProxy(): returns the same fresh module instances
// the proxy chain uses, plus a ready guardDeps (real ledger on a tmp file).
function sprintBSetup(overrides = {}) {
  const stats = require('../src/stats.js');
  const { createLedger } = require('../src/alert-ledger.js');
  const ledgerFile = path.join(os.tmpdir(), `miser-proxy-ledger-${process.pid}-${Date.now()}-${Math.random()}.json`);
  const alerts = [];
  const nowFn = () => new Date();
  process.env.MISER_ALERT_LEDGER_FILE = ledgerFile;
  const guardDeps = {
    ledger: createLedger(undefined, nowFn),
    sendAlert: async (t) => { alerts.push(t); },
    nowFn,
    ...overrides,
  };
  return { stats, guardDeps, alerts, cleanupLedger: () => { try { fs.unlinkSync(ledgerFile); } catch (_) {} } };
}

test('Sprint B AC2: capped project → exact 429 block, never forwarded, no usage accrual, counter increments', async () => {
  const echo = await startEcho(() => ({ status: 200, body: { usage: { input_tokens: 1 } } }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, { MISER_PRICING_JSON: SPRINT_B_PRICING });
  let cleanupLedger = () => {};
  try {
    const setup = sprintBSetup({
      budgetsConfig: { alpha: { dailyUSD: 5 } },
      budgetGraceConfig: [],
    });
    cleanupLedger = setup.cleanupLedger;
    setup.stats.recordAnthropicUsage('alpha', 'anthropic', 'testmodel', { input_tokens: 5 }); // $5.00 = cap

    const res = fakeRes();
    await drive(() => createProxy({ guardDeps: setup.guardDeps }), fakeReq('POST', '/v1/messages', {
      model: 'claude', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }],
    }, { 'x-termdeck-project': 'alpha' }), res);

    // Exact §1.4 response.
    assert.equal(res.statusCode, 429);
    assert.deepEqual(JSON.parse(res.body()), {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: "miser: project 'alpha' daily budget of $5.00 exhausted (spent $5.00); resets at next UTC midnight",
      },
    });
    assert.equal(res.headers['x-miser-budget'], 'exhausted');
    assert.equal(res.headers['content-type'], 'application/json');
    const retryAfter = Number(res.headers['retry-after']);
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 86400);
    // No compact headers on the block path (block fires pre-compress).
    assert.ok(!('x-miser-compact-hint' in res.headers));
    assert.ok(!('x-miser-poll-class' in res.headers));
    assert.ok(!('x-miser-input-tokens-est' in res.headers));
    // Upstream NEVER contacted.
    assert.equal(echo.captured.length, 0);
    // Cap alert fired exactly once.
    await tick();
    assert.deepEqual(setup.alerts, ['⛔ miser budget: alpha EXHAUSTED $5.00/$5.00 — blocking until UTC midnight']);
    // Stats: blockedCount recorded; no usage/legacy accrual from the blocked request.
    const result = setup.stats.getStats('1');
    assert.equal(result.perProject.alpha.budget.blockedCount, 1);
    assert.equal(typeof result.perProject.alpha.budget.firstBlockedAt, 'string');
    assert.deepEqual(result.usage.alpha.anthropic.testmodel, { requests: 1, input: 5 }); // only the seed
    assert.equal(result.perProject.alpha.dedup.appliedCount, 0);
    assert.deepEqual(result.perProject.alpha.pollClass, { likely: 0, work: 0 });
  } finally {
    echo.server.close(); restoreEnv(); cleanupLedger();
  }
});

test('Sprint B AC2: grace project at cap is forwarded normally with a GRACE cap alert only', async () => {
  const echo = await startEcho(() => ({ status: 200, body: { role: 'assistant', content: 'ok' } }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, { MISER_PRICING_JSON: SPRINT_B_PRICING });
  let cleanupLedger = () => {};
  try {
    const setup = sprintBSetup({
      budgetsConfig: { alpha: { dailyUSD: 2 } },
      budgetGraceConfig: ['alpha'],
    });
    cleanupLedger = setup.cleanupLedger;
    setup.stats.recordAnthropicUsage('alpha', 'anthropic', 'testmodel', { input_tokens: 3 }); // $3 ≥ $2

    const res = fakeRes();
    await drive(() => createProxy({ guardDeps: setup.guardDeps }), fakeReq('POST', '/v1/messages', {
      model: 'claude', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }],
    }, { 'x-termdeck-project': 'alpha' }), res);

    assert.equal(res.statusCode, 200);            // forwarded, not blocked
    assert.equal(echo.captured.length, 1);
    assert.ok(res.headers['x-miser-compact-hint']); // normal pipeline ran
    await tick();
    assert.deepEqual(setup.alerts, ['⛔ miser budget: alpha EXHAUSTED $3.00/$2.00 — GRACE: alerting only, not blocking']);
    assert.equal(setup.stats.getStats('1').perProject.alpha.budget, undefined); // never blocked
  } finally {
    echo.server.close(); restoreEnv(); cleanupLedger();
  }
});

test('Sprint B AC4: OpenAI-format request is cross-leg blocked on Anthropic spend, transport never invoked', async () => {
  const echo = await startEcho(() => ({ status: 200, body: {} }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, { MISER_PRICING_JSON: SPRINT_B_PRICING });
  let cleanupLedger = () => {};
  try {
    const setup = sprintBSetup({
      budgetsConfig: { alpha: { dailyUSD: 5 } },
      budgetGraceConfig: [],
    });
    cleanupLedger = setup.cleanupLedger;
    setup.stats.recordAnthropicUsage('alpha', 'anthropic', 'testmodel', { input_tokens: 6 }); // $6 > $5

    const transportCalls = [];
    const deps = {
      guardDeps: setup.guardDeps,
      transports: {
        openaiPassthrough: (...args) => { transportCalls.push('openai'); throw new Error('must not forward'); },
        anthropic: (...args) => { transportCalls.push('anthropic'); throw new Error('must not forward'); },
        ollama: (...args) => { transportCalls.push('ollama'); throw new Error('must not forward'); },
      },
    };
    const res = fakeRes();
    await drive(() => createProxy(deps), fakeReq('POST', '/v1/chat/completions', {
      model: 'gpt-x', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }],
    }, { 'x-termdeck-project': 'alpha' }), res);

    assert.equal(res.statusCode, 429);
    assert.match(JSON.parse(res.body()).error.message, /daily budget of \$5\.00 exhausted \(spent \$6\.00\)/);
    assert.deepEqual(transportCalls, []); // NO leg — openai or otherwise — was invoked
    // The blocked OpenAI-format request contributed $0: spend is still $6.00.
    const budgets = require('../src/budgets.js');
    assert.equal(budgets.__test.computeTodaySpendUSD('alpha', new Date()).spend, 6);
  } finally {
    echo.server.close(); restoreEnv(); cleanupLedger();
  }
});

test('Sprint B AC2/AC5e: budget-capped + drifted model → block only, NO drift alert or counter', async () => {
  const echo = await startEcho(() => ({ status: 200, body: {} }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, { MISER_PRICING_JSON: SPRINT_B_PRICING });
  let cleanupLedger = () => {};
  try {
    const setup = sprintBSetup({
      budgetsConfig: { alpha: { dailyUSD: 1 } },
      budgetGraceConfig: [],
      policyConfig: { alpha: { expectedModel: 'claude-sonnet' } },
    });
    cleanupLedger = setup.cleanupLedger;
    setup.stats.recordAnthropicUsage('alpha', 'anthropic', 'testmodel', { input_tokens: 2 }); // capped

    const res = fakeRes();
    await drive(() => createProxy({ guardDeps: setup.guardDeps }), fakeReq('POST', '/v1/messages', {
      model: 'claude-opus-4-8', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }], // drifted!
    }, { 'x-termdeck-project': 'alpha' }), res);

    assert.equal(res.statusCode, 429);
    assert.equal(echo.captured.length, 0);
    await tick();
    // Only the cap alert — budget check short-circuits before the drift check.
    assert.equal(setup.alerts.length, 1);
    assert.match(setup.alerts[0], /^⛔ miser budget: alpha EXHAUSTED/);
    assert.equal(setup.stats.getStats('1').perProject.alpha.policy, undefined); // no drift counter
  } finally {
    echo.server.close(); restoreEnv(); cleanupLedger();
  }
});

test('Sprint B AC5: drifted model under budget → forwarded UNMUTATED, drift alert fires once', async () => {
  const echo = await startEcho(() => ({ status: 200, body: { role: 'assistant', content: 'ok' } }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, { MISER_PRICING_JSON: SPRINT_B_PRICING });
  let cleanupLedger = () => {};
  try {
    const setup = sprintBSetup({
      policyConfig: { alpha: { expectedModel: 'claude-sonnet' } },
    });
    cleanupLedger = setup.cleanupLedger;

    const body = {
      model: 'claude-opus-4-8', max_tokens: 50,
      messages: [{ role: 'user', content: 'do the thing' }],
    };
    const res = fakeRes();
    await drive(() => createProxy({ guardDeps: setup.guardDeps }), fakeReq('POST', '/v1/messages', body, {
      'x-termdeck-project': 'alpha',
    }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(echo.captured.length, 1);
    // Zero mutation from B6: model + messages reach the wire unchanged.
    assert.equal(echo.captured[0].body.model, 'claude-opus-4-8');
    assert.deepEqual(echo.captured[0].body.messages, body.messages);
    assert.ok(res.headers['x-miser-compact-hint']); // normal pipeline untouched
    await tick();
    assert.deepEqual(setup.alerts, [
      '👁 miser policy: alpha model drift — got claude-opus-4-8, expected claude-sonnet* (1× today)',
    ]);
    assert.equal(setup.stats.getStats('1').perProject.alpha.policy.modelDriftCount, 1);
  } finally {
    echo.server.close(); restoreEnv(); cleanupLedger();
  }
});

test('Sprint B: guardrails-OFF (empty guardDeps) leaves the proxy path byte-identical', async () => {
  const echo = await startEcho(() => ({ status: 200, body: { usage: { input_tokens: 1 } } }));
  const { createProxy, restoreEnv } = freshProxy(echo.url);
  try {
    const res = fakeRes();
    await drive(() => createProxy({ guardDeps: {} }), fakeReq('POST', '/v1/messages', {
      model: 'claude', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }],
    }, {}), res);
    assert.equal(res.statusCode, 200);
    assert.equal(echo.captured.length, 1);
    assert.ok(res.headers['x-miser-compact-hint']);
  } finally {
    echo.server.close(); restoreEnv();
  }
});

test('Claude Code quota probe is answered locally and does not poison Anthropic cooldown', async () => {
  const echo = await startEcho(() => ({ status: 429, body: { error: { type: 'rate_limit_error' } } }));
  const { createProxy, restoreEnv } = freshProxy(echo.url);
  try {
    const res = fakeRes();
    await drive(createProxy, fakeReq('POST', '/p/provenspec--orch/v1/messages', {
      model: 'claude-sonnet-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'quota' }],
      metadata: { user_id: '{"session_id":"startup"}' },
    }, {
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
    }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-miser-provider'], 'local');
    assert.equal(res.headers['x-miser-enforcement-reason'], 'claude-code-quota-probe');
    assert.equal(echo.captured.length, 0);
  } finally {
    echo.server.close(); restoreEnv();
  }
});

test('v4 C1: breaker does not trip when 400s are reset by 2xx', async () => {
  const statuses = [400, 200, 400, 200, 400, 200];
  const echo = await startEcho(() => ({ status: statuses.shift(), body: { usage: { input_tokens: 1 } } }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, {
    MISER_CONTEXT_EDIT_PROJECTS: JSON.stringify({ alpha: true }),
  });
  try {
    for (let i = 0; i < 6; i++) {
      const res = fakeRes();
      await drive(createProxy, fakeReq('POST', '/p/alpha/v1/messages', {
        model: 'claude', max_tokens: 50, messages: [{ role: 'user', content: `hi ${i}` }],
      }, {}), res);
    }
    assert.equal(echo.captured.length, 6);
    assert.ok(echo.captured.every(c => c.body.context_management));
  } finally {
    echo.server.close(); restoreEnv();
  }
});
