'use strict';

const os = require('node:os');
const path = require('node:path');
// Pin stats file before any src require.
process.env.MISER_STATS_FILE = path.join(os.tmpdir(), `miser-failover-test-${process.pid}-${Date.now()}.json`);

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { routeRequest, teardownResponse } = require('../src/router.js');
const { createBreaker } = require('../src/circuit-breaker.js');
const { createProxy } = require('../src/proxy.js');
const { makeRes, successTransport, failTransport } = require('./_harness.js');

const fastRetry = { sleepFn: () => Promise.resolve(), jitterFn: () => 0.5, maxAttempts: 1 };
const fakeBearer = () => ({ token: 'FAKE-ACCESS-TOKEN', accountId: 'acct_test' });

const ANTH_MSGS = [{ role: 'user', content: 'hi' }];
const ANTH_BODY = { model: 'claude', max_tokens: 100, system: 'sys', messages: ANTH_MSGS };

function assertAnthropicUnavailable(res, statusCode, reason) {
  assert.equal(res.statusCode, statusCode);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(res.headers['x-miser-provider'], 'anthropic');
  assert.equal(res.headers['x-miser-provider-status'], 'unavailable');
  assert.equal(res.headers['x-miser-fallback'], 'disabled');
  assert.equal(res.headers['x-miser-error'], 'provider_unavailable');
  assert.equal(res.headers['x-miser-error-reason'], reason);
  const body = JSON.parse(res.body());
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'miser_provider_unavailable');
  assert.equal(body.error.upstream, 'anthropic');
  assert.equal(body.error.reason, reason);
  assert.equal(body.error.fallback, 'disabled');
  assert.ok(!('role' in body), 'provider unavailable response must not be an assistant turn');
  assert.ok(!('content' in body), 'provider unavailable response must not substitute assistant content');
}

function assertStreamingAnthropicUnavailable(res, statusCode, reason) {
  assert.equal(res.statusCode, statusCode);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  assert.equal(res.headers['x-miser-provider'], 'anthropic');
  assert.equal(res.headers['x-miser-provider-status'], 'unavailable');
  assert.equal(res.headers['x-miser-fallback'], 'disabled');
  assert.equal(res.headers['x-miser-error'], 'provider_unavailable');
  assert.equal(res.headers['x-miser-error-reason'], reason);
  assert.match(res.body(), /^event: error\ndata: /);
  assert.match(res.body(), /"type":"miser_provider_unavailable"/);
  assert.match(res.body(), new RegExp(`"reason":"${reason}"`));
  assert.doesNotMatch(res.body(), /event: message_start/);
  assert.doesNotMatch(res.body(), /qwen2\.5-coder/);
}

function proxyReq(bodyObj, url = '/v1/messages', headers = {}) {
  const raw = JSON.stringify(bodyObj);
  const listeners = {};
  const req = { method: 'POST', url, headers, on(evt, cb) { listeners[evt] = cb; return req; } };
  process.nextTick(() => {
    if (listeners.data) listeners.data(Buffer.from(raw));
    if (listeners.end) listeners.end();
  });
  return req;
}

test('happy path: Anthropic succeeds, no failover', async () => {
  const calls = [];
  const res = makeRes();
  await routeRequest(ANTH_MSGS, ANTH_BODY, {}, res, 'proj', 0, 'anthropic', {
    transports: {
      anthropic: successTransport('anthropic', calls),
      codex: (...a) => { calls.push({ name: 'codex', args: a }); throw new Error('codex must not be called'); },
      ollama: (...a) => { calls.push({ name: 'ollama', args: a }); throw new Error('ollama must not be called'); },
    },
    getBearer: fakeBearer,
  });
  assert.deepEqual(calls.map(c => c.name), ['anthropic']);
  assert.equal(res.headers['x-miser-provider'], 'anthropic');
});

test('Anthropic 429 on Claude route does not call Codex/OpenAI or Ollama', async () => {
  const calls = [];
  const res = makeRes();
  await routeRequest(ANTH_MSGS, ANTH_BODY, {}, res, 'proj', 0, 'anthropic', {
    transports: {
      anthropic: failTransport('anthropic', calls, 429),
      openaiPassthrough: (...a) => { calls.push({ name: 'openai', args: a }); throw new Error('openai must not be called'); },
      codex: (...a) => { calls.push({ name: 'codex', args: a }); throw new Error('codex must not be called'); },
      ollama: (...a) => { calls.push({ name: 'ollama', args: a }); throw new Error('ollama must not be called'); },
    },
    getBearer: fakeBearer,
    retryOpts: fastRetry,
  });

  assert.deepEqual(calls.map(c => c.name), ['anthropic']);
  assertAnthropicUnavailable(res, 429, 'anthropic_rate_limited');
  assert.equal(res.headers['retry-after'], '120');
});

test('Anthropic 429 cooldown on Claude route does not call any provider', async () => {
  const calls = [];
  const cooldowns = new Map();
  const deps = {
    transports: {
      anthropic: failTransport('anthropic', calls, 429),
      openaiPassthrough: (...a) => { calls.push({ name: 'openai', args: a }); throw new Error('openai must not be called'); },
      codex: (...a) => { calls.push({ name: 'codex', args: a }); throw new Error('codex must not be called'); },
      ollama: (...a) => { calls.push({ name: 'ollama', args: a }); throw new Error('ollama must not be called'); },
    },
    getBearer: fakeBearer,
    anthropic429Cooldowns: cooldowns,
    anthropic429CooldownMs: 120000,
    retryOpts: fastRetry,
  };

  const first = makeRes();
  await routeRequest(ANTH_MSGS, ANTH_BODY, {}, first, 'proj', 0, 'anthropic', deps);
  const second = makeRes();
  await routeRequest(ANTH_MSGS, ANTH_BODY, {}, second, 'proj', 0, 'anthropic', deps);

  assert.deepEqual(calls.map(c => c.name), ['anthropic']);
  assertAnthropicUnavailable(first, 429, 'anthropic_rate_limited');
  assertAnthropicUnavailable(second, 429, 'anthropic_429_cooldown');
});

test('tool-result continuation gets provider-unavailable error, not fallback assistant turn', async () => {
  const calls = [];
  const toolMsgs = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'date' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
  ];
  const res = makeRes();
  await routeRequest(toolMsgs, { model: 'claude', max_tokens: 100, messages: toolMsgs }, {}, res, 'pkachu', 0, 'anthropic', {
    transports: {
      anthropic: failTransport('anthropic', calls, 429),
      codex: (...a) => { calls.push({ name: 'codex', args: a }); throw new Error('codex must not be called'); },
      ollama: (...a) => { calls.push({ name: 'ollama', args: a }); throw new Error('ollama must not be called'); },
    },
    getBearer: fakeBearer,
    retryOpts: fastRetry,
  });

  assert.deepEqual(calls.map(c => c.name), ['anthropic']);
  assertAnthropicUnavailable(res, 429, 'anthropic_rate_limited');
  assert.doesNotMatch(res.body(), /miser_local_/);
});

test('forced tool_choice turn gets provider-unavailable error, not fallback assistant turn', async () => {
  const calls = [];
  const msgs = [{ role: 'user', content: 'run the selected tool' }];
  const res = makeRes();
  await routeRequest(msgs, {
    model: 'claude',
    max_tokens: 100,
    messages: msgs,
    tool_choice: { type: 'tool', name: 'Bash' },
  }, {}, res, 'proj', 0, 'anthropic', {
    transports: {
      anthropic: failTransport('anthropic', calls, 429),
      codex: (...a) => { calls.push({ name: 'codex', args: a }); throw new Error('codex must not be called'); },
      ollama: (...a) => { calls.push({ name: 'ollama', args: a }); throw new Error('ollama must not be called'); },
    },
    getBearer: fakeBearer,
    retryOpts: fastRetry,
  });

  assert.deepEqual(calls.map(c => c.name), ['anthropic']);
  assertAnthropicUnavailable(res, 429, 'anthropic_rate_limited');
  assert.doesNotMatch(res.body(), /miser_local_/);
});

test('streaming Claude unavailability uses SSE error shape without fallback message events', async () => {
  const calls = [];
  const res = makeRes();
  await routeRequest(ANTH_MSGS, { ...ANTH_BODY, stream: true }, {}, res, 'proj', 0, 'anthropic', {
    transports: {
      anthropic: failTransport('anthropic', calls, 429),
      codex: (...a) => { calls.push({ name: 'codex', args: a }); throw new Error('codex must not be called'); },
      ollama: (...a) => { calls.push({ name: 'ollama', args: a }); throw new Error('ollama must not be called'); },
    },
    getBearer: fakeBearer,
    retryOpts: fastRetry,
  });

  assert.deepEqual(calls.map(c => c.name), ['anthropic']);
  assertStreamingAnthropicUnavailable(res, 429, 'anthropic_rate_limited');
});

test('Anthropic retryable transport failure returns 503 without Codex/Ollama fallback', async () => {
  const calls = [];
  const res = makeRes();
  await routeRequest(ANTH_MSGS, ANTH_BODY, {}, res, 'proj', 0, 'anthropic', {
    transports: {
      anthropic: (...args) => {
        calls.push({ name: 'anthropic', args });
        const err = new Error('connect ECONNRESET');
        err.retryable = true;
        return Promise.reject(err);
      },
      codex: (...a) => { calls.push({ name: 'codex', args: a }); throw new Error('codex must not be called'); },
      ollama: (...a) => { calls.push({ name: 'ollama', args: a }); throw new Error('ollama must not be called'); },
    },
    getBearer: fakeBearer,
    retryOpts: fastRetry,
  });

  assert.deepEqual(calls.map(c => c.name), ['anthropic']);
  assertAnthropicUnavailable(res, 503, 'anthropic_transport_unavailable');
});

test('streaming Anthropic transport failure returns SSE unavailable error', async () => {
  const calls = [];
  const res = makeRes();
  await routeRequest(ANTH_MSGS, { ...ANTH_BODY, stream: true }, {}, res, 'proj', 0, 'anthropic', {
    transports: {
      anthropic: (...args) => {
        calls.push({ name: 'anthropic', args });
        const err = new Error('connect ECONNRESET');
        err.retryable = true;
        return Promise.reject(err);
      },
      codex: (...a) => { calls.push({ name: 'codex', args: a }); throw new Error('codex must not be called'); },
      ollama: (...a) => { calls.push({ name: 'ollama', args: a }); throw new Error('ollama must not be called'); },
    },
    getBearer: fakeBearer,
    retryOpts: fastRetry,
  });

  assert.deepEqual(calls.map(c => c.name), ['anthropic']);
  assertStreamingAnthropicUnavailable(res, 503, 'anthropic_transport_unavailable');
});

test('Anthropic breaker OPEN returns provider-unavailable error without Codex/Ollama fallback', async () => {
  const anthropicBreaker = createBreaker('provider-admission-anth', { threshold: 3 });
  anthropicBreaker.recordFailure(); anthropicBreaker.recordFailure(); anthropicBreaker.recordFailure();
  assert.equal(anthropicBreaker.getState().state, 'OPEN');

  const calls = [];
  const res = makeRes();
  await routeRequest(ANTH_MSGS, ANTH_BODY, {}, res, 'proj', 0, 'anthropic', {
    transports: {
      anthropic: (...a) => { calls.push({ name: 'anthropic', args: a }); throw new Error('anthropic must not be called'); },
      codex: (...a) => { calls.push({ name: 'codex', args: a }); throw new Error('codex must not be called'); },
      ollama: (...a) => { calls.push({ name: 'ollama', args: a }); throw new Error('ollama must not be called'); },
    },
    breakers: { anthropic: anthropicBreaker },
    getBearer: fakeBearer,
    retryOpts: fastRetry,
  });

  assert.deepEqual(calls, []);
  assertAnthropicUnavailable(res, 503, 'anthropic_breaker_open');
});

test('streaming Anthropic breaker OPEN returns SSE unavailable error', async () => {
  const anthropicBreaker = createBreaker('provider-admission-anth-stream', { threshold: 3 });
  anthropicBreaker.recordFailure(); anthropicBreaker.recordFailure(); anthropicBreaker.recordFailure();
  assert.equal(anthropicBreaker.getState().state, 'OPEN');

  const calls = [];
  const res = makeRes();
  await routeRequest(ANTH_MSGS, { ...ANTH_BODY, stream: true }, {}, res, 'proj', 0, 'anthropic', {
    transports: {
      anthropic: (...a) => { calls.push({ name: 'anthropic', args: a }); throw new Error('anthropic must not be called'); },
      codex: (...a) => { calls.push({ name: 'codex', args: a }); throw new Error('codex must not be called'); },
      ollama: (...a) => { calls.push({ name: 'ollama', args: a }); throw new Error('ollama must not be called'); },
    },
    breakers: { anthropic: anthropicBreaker },
    getBearer: fakeBearer,
    retryOpts: fastRetry,
  });

  assert.deepEqual(calls, []);
  assertStreamingAnthropicUnavailable(res, 503, 'anthropic_breaker_open');
});

test('TermDeck suggestion mode returns empty local JSON without touching upstreams', async () => {
  const calls = [];
  const msgs = [{
    role: 'user',
    content: '[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]\n\nReply with ONLY the suggestion, no quotes or explanation.',
  }];
  const res = makeRes();
  await routeRequest(msgs, { model: 'claude', max_tokens: 100, messages: msgs }, {}, res, 'aetheria', 0, 'anthropic', {
    transports: {
      anthropic: (...a) => { calls.push({ name: 'anthropic', args: a }); throw new Error('anthropic must not be called'); },
      codex: (...a) => { calls.push({ name: 'codex', args: a }); throw new Error('codex must not be called'); },
      ollama: (...a) => { calls.push({ name: 'ollama', args: a }); throw new Error('ollama must not be called'); },
    },
    getBearer: fakeBearer,
  });

  assert.deepEqual(calls, []);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-miser-provider'], 'local');
  assert.equal(res.headers['x-miser-enforcement'], 'suggestion-mode-zero-llm');
  assert.equal(res.headers['x-miser-enforcement-reason'], 'termdeck-suggestion-mode-zero-llm');
  assert.equal(JSON.parse(res.body()).content[0].text, '');
});

test('TermDeck suggestion mode returns empty local SSE without touching upstreams', async () => {
  const calls = [];
  const msgs = [{
    role: 'user',
    content: '[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]\n\nReply with ONLY the suggestion, no quotes or explanation.',
  }];
  const res = makeRes();
  await routeRequest(msgs, { model: 'claude', max_tokens: 100, messages: msgs, stream: true }, {}, res, 'aetheria', 0, 'anthropic', {
    transports: {
      anthropic: (...a) => { calls.push({ name: 'anthropic', args: a }); throw new Error('anthropic must not be called'); },
      codex: (...a) => { calls.push({ name: 'codex', args: a }); throw new Error('codex must not be called'); },
      ollama: (...a) => { calls.push({ name: 'ollama', args: a }); throw new Error('ollama must not be called'); },
    },
    getBearer: fakeBearer,
  });

  assert.deepEqual(calls, []);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  assert.equal(res.headers['x-miser-provider'], 'local');
  assert.equal(res.headers['x-miser-enforcement'], 'suggestion-mode-zero-llm');
  assert.match(res.body(), /event: message_stop/);
});

test('regression: Ollama qwen2.5-coder cannot answer a Claude-panel request', async () => {
  const calls = [];
  const handler = createProxy({
    transports: {
      anthropic: failTransport('anthropic', calls, 429),
      codex: (...a) => { calls.push({ name: 'codex', args: a }); throw new Error('codex must not be called'); },
      ollama: (...a) => {
        calls.push({ name: 'ollama', args: a });
        const res = a.find(x => x && typeof x.writeHead === 'function');
        res.writeHead(200, { 'x-miser-provider': 'ollama', 'x-miser-model': 'qwen2.5-coder:14b' });
        res.end('qwen answered');
        return Promise.resolve();
      },
    },
    getBearer: fakeBearer,
    retryOpts: fastRetry,
  });
  const res = makeRes();
  const done = new Promise((resolve) => {
    const end = res.end.bind(res);
    res.end = (chunk) => { const ret = end(chunk); resolve(); return ret; };
  });

  handler(proxyReq(ANTH_BODY, '/p/pkachu--orch/v1/messages'), res);
  await done;

  assert.deepEqual(calls.map(c => c.name), ['anthropic']);
  assertAnthropicUnavailable(res, 429, 'anthropic_rate_limited');
  assert.doesNotMatch(res.body(), /qwen answered|qwen2\.5-coder|ok:ollama/);
});

test('openai passthrough format: 429 may use explicit Ollama fallback, Codex leg not used', async () => {
  const calls = [];
  const res = makeRes();
  await routeRequest(ANTH_MSGS, { model: 'gpt', messages: ANTH_MSGS }, {}, res, 'proj', 0, 'openai', {
    transports: {
      openaiPassthrough: failTransport('openai', calls, 429),
      codex: (...a) => { calls.push({ name: 'codex', args: a }); throw new Error('codex must not be called'); },
      ollama: successTransport('ollama', calls),
    },
    getBearer: fakeBearer,
  });

  assert.deepEqual(calls.map(c => c.name), ['openai', 'ollama']);
  assert.equal(res.headers['x-miser-provider'], 'ollama');
});

test('non-429 Anthropic error propagates (no failover on a hard error)', async () => {
  const calls = [];
  const res = makeRes();
  await assert.rejects(
    () => routeRequest(ANTH_MSGS, ANTH_BODY, {}, res, 'proj', 0, 'anthropic', {
      transports: {
        anthropic: failTransport('anthropic', calls, 400),
        codex: successTransport('codex', calls),
        ollama: successTransport('ollama', calls),
      },
      getBearer: fakeBearer,
    }),
    /anthropic 400/,
  );
  assert.deepEqual(calls.map(c => c.name), ['anthropic']);
});

test('teardownResponse destroys the response on post-header upstream error', () => {
  let destroyedWith;
  const res = { destroyed: false, destroy(e) { this.destroyed = true; destroyedWith = e; } };
  const err = new Error('stream broke');
  teardownResponse(res, err);
  assert.equal(res.destroyed, true);
  assert.equal(destroyedWith, err);
});

test('teardownResponse falls back to end() when destroy() is unavailable', () => {
  let ended = false;
  const res = { writableEnded: false, end() { ended = true; } };
  teardownResponse(res, new Error('x'));
  assert.equal(ended, true);
});

test('teardownResponse is a no-op on an already-destroyed response', () => {
  let called = false;
  const res = { destroyed: true, destroy() { called = true; } };
  teardownResponse(res, new Error('x'));
  assert.equal(called, false);
});

test('server entrypoint (the only .listen on :20128) is never loaded during tests', () => {
  const loaded = Object.keys(require.cache).map(p => p.replace(/\\/g, '/'));
  assert.ok(
    !loaded.some(p => p.endsWith('/src/index.js')),
    'src/index.js (the server bind) must not be required by any test',
  );
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(idx, /server\.listen\(config\.port/, 'index.js is the port-binding entrypoint');
});
