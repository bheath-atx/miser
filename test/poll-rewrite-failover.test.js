'use strict';

const prevCodexFormat = process.env.MISER_CODEX_FORMAT;
const prevCodexModel = process.env.MISER_CODEX_MODEL;
process.env.MISER_CODEX_FORMAT = 'responses';
delete process.env.MISER_CODEX_MODEL;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');

const config = require('../src/config.js');
const { createProxy } = require('../src/proxy.js');
const {
  createPollRewriteBreaker,
  shouldRewrite,
  applyPollRewrite,
  formatRewriteHeader,
} = require('../src/poll-rewrite.js');

after(() => {
  if (prevCodexFormat === undefined) delete process.env.MISER_CODEX_FORMAT;
  else process.env.MISER_CODEX_FORMAT = prevCodexFormat;
  if (prevCodexModel === undefined) delete process.env.MISER_CODEX_MODEL;
  else process.env.MISER_CODEX_MODEL = prevCodexModel;
});

function fakeReq(method, url, bodyObj, headers = {}) {
  const raw = JSON.stringify(bodyObj);
  const listeners = {};
  const req = { method, url, headers, on(evt, cb) { listeners[evt] = cb; return req; } };
  process.nextTick(() => {
    if (listeners.data) listeners.data(Buffer.from(raw));
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
    this.headersSent = true;
    this.statusCode = code;
    this.headers = { ...this.headers, ...(headers || {}) };
    return this;
  }
  _write(chunk, _enc, cb) { this.chunks.push(chunk.toString()); cb(); }
  end(chunk) { if (chunk != null) this.chunks.push(String(chunk)); return super.end(); }
  whenDone() { return new Promise(resolve => this._doneResolvers.push(resolve)); }
}

test('AC41: Codex Responses failover drops G7 output-token/model/thinking levers by translation', async () => {
  assert.equal(config.codexFormat, 'responses');
  const calls = [];
  const events = [];
  const pollRewrite = {
    projects: {
      pkachu: {
        panels: ['canary'],
        maxTokens: 1024,
        thinking: 'strip',
        modelMap: { 'claude-opus-4-8': 'claude-haiku-4-5-20251001' },
      },
    },
    breaker: createPollRewriteBreaker({ windowMs: 300000, threshold: 3, resetMs: 1800000 }, {}),
    shouldRewrite,
    applyPollRewrite,
    formatRewriteHeader,
    recordPollRewriteStats: (_project, event) => events.push(event),
    nowFn: () => new Date('2026-07-20T12:00:00.000Z'),
  };
  const deps = {
    transports: {
      anthropic: (_messages, body) => {
        calls.push({ leg: 'anthropic', body });
        const err = new Error('anthropic 429');
        err.statusCode = 429;
        return Promise.reject(err);
      },
      codex: (codexReq, bearer, res) => {
        calls.push({ leg: 'codex', codexReq, bearer });
        res.writeHead(200, { 'x-miser-provider': 'codex' });
        res.end(JSON.stringify({ ok: true }));
        return Promise.resolve();
      },
      ollama: () => { throw new Error('ollama must not be called'); },
    },
    getBearer: () => ({ token: 'fake', accountId: 'acct' }),
    pollRewrite,
  };
  const body = {
    model: 'claude-opus-4-8',
    max_tokens: 8000,
    thinking: { type: 'enabled', budget_tokens: 4000 },
    messages: [{ role: 'user', content: 'poll?' }],
  };
  const res = new FakeRes();
  const done = res.whenDone();
  createProxy(deps)(fakeReq('POST', '/p/pkachu--canary/v1/messages', body), res);
  await done;

  assert.equal(calls[0].body.max_tokens, 1024);
  assert.equal(calls[0].body.model, 'claude-haiku-4-5-20251001');
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0].body, 'thinking'), false);
  assert.equal(calls[1].codexReq.model, 'gpt-5.5');
  assert.equal(Object.prototype.hasOwnProperty.call(calls[1].codexReq, 'max_tokens'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[1].codexReq, 'max_output_tokens'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(calls[1].codexReq, 'thinking'), false);
  assert.deepEqual(events, [{ levers: ['model', 'thinking', 'maxTokens'] }]);
});
