'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { compress } = require('../src/compress.js');

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
      const { status, body } = handler(parsed, req) || { status: 200, body: { role: 'assistant', content: 'ok' } };
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, captured, url: `http://127.0.0.1:${port}` });
    });
  });
}

function freshProxy(anthropicUrl, extraEnv = {}) {
  for (const k of Object.keys(require.cache)) {
    if (/\/src\/(proxy|router|config|stats|toolprune)\.js$/.test(k.replace(/\\/g, '/'))) {
      delete require.cache[k];
    }
  }
  const prev = { ...process.env };
  const statsFile = extraEnv.MISER_STATS_FILE
    || path.join(os.tmpdir(), `miser-compact-test-stats-${process.pid}-${Date.now()}-${Math.random()}.json`);
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

function fakeReq(method, url, bodyObj, headers = {}) {
  const raw = bodyObj == null ? '' : JSON.stringify(bodyObj);
  const listeners = {};
  const req = {
    method, url, headers,
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

function bodyForRawTokens(model, rawTokens) {
  const chars = Math.max(0, (rawTokens - 4) * 4);
  return {
    model,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'x'.repeat(chars) }],
  };
}

async function proxyOnce(body, opts = {}) {
  const echo = await startEcho(() => ({
    status: opts.status || 200,
    body: opts.responseBody || { role: 'assistant', content: 'ok' },
  }));
  const { createProxy, restoreEnv } = freshProxy(echo.url, opts.env || {});
  try {
    const res = fakeRes();
    await drive(createProxy, fakeReq('POST', '/v1/messages', body, opts.headers || {}), res);
    return { res, captured: echo.captured };
  } finally {
    echo.server.close();
    restoreEnv();
  }
}

test('compact hint is none for a small Sonnet request and raw token estimate matches compress()', async () => {
  const body = { model: 'claude-sonnet-4-20250514', max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] };
  const { res, captured } = await proxyOnce(body);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-miser-compact-hint'], 'none');
  assert.equal(res.headers['x-miser-input-tokens-est'], String(compress(body, { cacheHint: true }).rawTokens));
  assert.equal(res.headers['x-miser-poll-class'], 'likely');
  assert.equal(res.headers['x-miser-techniques'], 'none');
  assert.ok(!('x-miser-oversized-turns' in res.headers));
  assert.deepEqual(captured[0].body, body);
});

test('compact hint is recommend above 40% of the Sonnet window', async () => {
  const { res } = await proxyOnce(bodyForRawTokens('claude-sonnet-4-20250514', 82_000));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-miser-compact-hint'], 'recommend');
});

test('compact hint is urgent above 70% of the Sonnet window', async () => {
  const { res } = await proxyOnce(bodyForRawTokens('claude-sonnet-4-20250514', 142_000));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-miser-compact-hint'], 'urgent');
});

test('same absolute token estimate is none on the larger Opus window', async () => {
  const { res } = await proxyOnce(bodyForRawTokens('claude-opus-4-20250514', 82_000));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-miser-compact-hint'], 'none');
});

test('unknown model defaults to the 200K window', async () => {
  const { res } = await proxyOnce(bodyForRawTokens('unknown-model', 82_000));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-miser-compact-hint'], 'recommend');
});

test('poll class is unlikely for a first-time long user message', async () => {
  const { res } = await proxyOnce({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'z'.repeat(600) }],
  });
  assert.equal(res.headers['x-miser-poll-class'], 'unlikely');
});

test('poll class is likely for a repeated long last-user fingerprint in the same project', async () => {
  const echo = await startEcho(() => ({ status: 200, body: { role: 'assistant', content: 'ok' } }));
  const { createProxy, restoreEnv } = freshProxy(echo.url);
  try {
    const body = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'repeat '.repeat(100) }],
    };
    const headers = { 'x-termdeck-project': 'repeat-project' };
    const first = fakeRes();
    await drive(createProxy, fakeReq('POST', '/v1/messages', body, headers), first);
    const second = fakeRes();
    await drive(createProxy, fakeReq('POST', '/v1/messages', body, headers), second);
    assert.equal(first.headers['x-miser-poll-class'], 'unlikely');
    assert.equal(second.headers['x-miser-poll-class'], 'likely');
  } finally {
    echo.server.close();
    restoreEnv();
  }
});

test('oversized tool_result header lists the correct message index', async () => {
  const body = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 10,
    messages: [
      { role: 'user', content: 'run tool' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'o'.repeat(32_769) }] },
    ],
  };
  const { res } = await proxyOnce(body);
  assert.equal(res.headers['x-miser-oversized-turns'], '2');
  assert.equal(res.headers['x-miser-compact-hint'], 'recommend');
});

test('oversized tool_result header is absent when no tool_result exceeds 32KB', async () => {
  const body = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 10,
    messages: [
      { role: 'user', content: 'run tool' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'o'.repeat(32_768) }] },
    ],
  };
  const { res } = await proxyOnce(body);
  assert.ok(!('x-miser-oversized-turns' in res.headers));
});

for (const status of [400, 500]) {
  test(`compact headers are absent on upstream ${status}`, async () => {
    const body = { model: 'claude-sonnet-4-20250514', max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] };
    const { res } = await proxyOnce(body, { status, responseBody: { error: { message: `upstream ${status}` } } });
    assert.equal(res.statusCode, status);
    for (const name of [
      'x-miser-input-tokens-est',
      'x-miser-poll-class',
      'x-miser-oversized-turns',
      'x-miser-compact-hint',
      'x-miser-techniques',
    ]) {
      assert.ok(!(name in res.headers), `${name} should be absent`);
    }
  });
}

test('/api/miser/stats includes per-project pollClass likely/work counts', async () => {
  const echo = await startEcho(() => ({ status: 200, body: { role: 'assistant', content: 'ok' } }));
  const { createProxy, restoreEnv } = freshProxy(echo.url);
  try {
    const headers = { 'x-termdeck-project': 'stats-project' };
    const likely = fakeRes();
    await drive(createProxy, fakeReq('POST', '/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'short' }],
    }, headers), likely);

    const work = fakeRes();
    await drive(createProxy, fakeReq('POST', '/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'w'.repeat(600) }],
    }, headers), work);

    const stats = fakeRes();
    await drive(createProxy, fakeReq('GET', '/api/miser/stats?project=stats-project', null, {}), stats);
    const payload = JSON.parse(stats.body());
    assert.deepEqual(payload.perProject['stats-project'].pollClass, { likely: 1, work: 1 });
  } finally {
    echo.server.close();
    restoreEnv();
  }
});
