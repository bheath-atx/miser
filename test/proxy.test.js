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
      captured.push({ url: req.url, body: parsed, raw });
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
function freshProxy(anthropicUrl, extraEnv = {}) {
  for (const k of Object.keys(require.cache)) {
    if (/\/src\/(proxy|router|config|compress|stats|toolprune)\.js$/.test(k.replace(/\\/g, '/'))) {
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
    this.headers = null;
    this.chunks = [];
    this._doneResolvers = [];
    this.on('finish', () => this._doneResolvers.forEach(r => r()));
  }
  writeHead(code, headers) {
    if (this.headersSent) throw new Error('writeHead twice');
    this.headersSent = true; this.statusCode = code; this.headers = headers || {}; return this;
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

test('health payload drops the deleted threshold; reports cacheHint', async () => {
  const echo = await startEcho(() => ({ status: 200, body: {} }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, { MISER_CACHE_HINT: '' });
  try {
    const res = fakeRes();
    await drive(createProxy, fakeReq('GET', '/api/miser/health', null, {}), res);
    const payload = JSON.parse(res.body());
    assert.equal(payload.ok, true);
    assert.ok(!('threshold' in payload));
    assert.equal(payload.cacheHint, true);
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
    assert.deepEqual(Object.keys(payload.totals), ['inputTokensRemoved', 'cacheBillingDelta', 'appliedCount']);
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
