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
    if (/\/src\/(proxy|router|routing|stats|pricing|config|compress|toolprune|context-management|usage|quota)\.js$/.test(key.replace(/\\/g, '/'))) {
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
