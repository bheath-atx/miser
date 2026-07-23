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
    if (/\/src\/(proxy|router|config|compress|stats|toolprune|routing|context-management|usage|budgets|policy-watchdog|pricing|daily-rollup|alert-ledger)\.js$/.test(k.replace(/\\/g, '/'))) {
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

test('v4 C1: injected 429 keeps failover behavior', async () => {
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
    assert.deepEqual(calls.map(c => c.name), ['anthropic', 'codex']);
    assert.ok(calls[0].body.context_management);
    assert.equal(res.headers['x-miser-provider'], 'codex');
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
  const guardDeps = {
    ledger: createLedger(ledgerFile, nowFn),
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
