'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { routeRequest, teardownResponse } = require('../src/router.js');
const { makeRes, successTransport, failTransport } = require('./_harness.js');

// Fake subscription bearer — never reads ~/.codex/auth.json.
const fakeBearer = () => ({ token: 'FAKE-ACCESS-TOKEN', accountId: 'acct_test' });

function buildDeps(overrides) {
  const calls = [];
  const transports = {
    anthropic: successTransport('anthropic', calls),
    openaiPassthrough: successTransport('openai', calls),
    codex: successTransport('codex', calls),
    ollama: successTransport('ollama', calls),
    ...(overrides.transports || {}),
  };
  return {
    calls,
    deps: { transports, getBearer: overrides.getBearer || fakeBearer, ollamaCap: 32000 },
  };
}

const ANTH_MSGS = [{ role: 'user', content: 'hi' }];
const ANTH_BODY = { model: 'claude', max_tokens: 100, system: 'sys', messages: ANTH_MSGS };

test('happy path: Anthropic succeeds, no failover', async () => {
  const { calls, deps } = buildDeps({});
  const res = makeRes();
  await routeRequest(ANTH_MSGS, ANTH_BODY, {}, res, 'proj', 0, 'anthropic', deps);
  assert.deepEqual(calls.map(c => c.name), ['anthropic']);
  assert.equal(res.headers['x-miser-provider'], 'anthropic');
});

// REQUIRED TEST 1
test('Anthropic 429 → Codex success → Ollama NOT called', async () => {
  const calls = [];
  const deps = {
    transports: {
      anthropic: failTransport('anthropic', calls, 429),
      codex: successTransport('codex', calls),
      // If Ollama is reached, record it AND blow up so the test fails loudly.
      ollama: (...a) => { calls.push({ name: 'ollama', args: a }); throw new Error('ollama must not be called'); },
    },
    getBearer: fakeBearer,
    ollamaCap: 32000,
  };
  const res = makeRes();
  await routeRequest(ANTH_MSGS, ANTH_BODY, {}, res, 'proj', 0, 'anthropic', deps);

  const names = calls.map(c => c.name);
  assert.deepEqual(names, ['anthropic', 'codex']);
  assert.ok(!names.includes('ollama'), 'Ollama must NOT be called when Codex succeeds');
  assert.equal(res.headers['x-miser-provider'], 'codex');
});

// REQUIRED TEST 2
test('Anthropic 429 → Codex 429 → Ollama IS called', async () => {
  const calls = [];
  const deps = {
    transports: {
      anthropic: failTransport('anthropic', calls, 429),
      codex: failTransport('codex', calls, 429),
      ollama: successTransport('ollama', calls),
    },
    getBearer: fakeBearer,
    ollamaCap: 32000,
  };
  const res = makeRes();
  await routeRequest(ANTH_MSGS, ANTH_BODY, {}, res, 'proj', 0, 'anthropic', deps);
  assert.deepEqual(calls.map(c => c.name), ['anthropic', 'codex', 'ollama']);
  assert.equal(res.headers['x-miser-provider'], 'ollama');
});

test('Anthropic 429 → no bearer (fail closed) → Ollama IS called (Codex skipped)', async () => {
  const calls = [];
  const deps = {
    transports: {
      anthropic: failTransport('anthropic', calls, 429),
      codex: successTransport('codex', calls), // would succeed, but must be skipped
      ollama: successTransport('ollama', calls),
    },
    getBearer: () => { const e = new Error('no token'); e.statusCode = 401; throw e; },
    ollamaCap: 32000,
  };
  const res = makeRes();
  await routeRequest(ANTH_MSGS, ANTH_BODY, {}, res, 'proj', 0, 'anthropic', deps);
  const names = calls.map(c => c.name);
  assert.deepEqual(names, ['anthropic', 'ollama']);
  assert.ok(!names.includes('codex'), 'Codex must be skipped when bearer is unavailable');
});

// REGRESSION (Codex inversion finding #1): an expired/invalid subscription
// token yields a Codex 401/403 — that must fail closed to Ollama, NOT stream
// the auth error to the client as a "successful" Codex response.
for (const status of [401, 403, 400, 502]) {
  test(`Anthropic 429 → Codex ${status} → fails over to Ollama (no auth error streamed)`, async () => {
    const calls = [];
    const deps = {
      transports: {
        anthropic: failTransport('anthropic', calls, 429),
        codex: failTransport('codex', calls, status),
        ollama: successTransport('ollama', calls),
      },
      getBearer: fakeBearer,
      ollamaCap: 32000,
    };
    const res = makeRes();
    await routeRequest(ANTH_MSGS, ANTH_BODY, {}, res, 'proj', 0, 'anthropic', deps);
    assert.deepEqual(calls.map(c => c.name), ['anthropic', 'codex', 'ollama']);
    assert.equal(res.headers['x-miser-provider'], 'ollama');
  });
}

test('Codex leg receives a validated OpenAI request + the subscription bearer', async () => {
  const captured = {};
  const calls = [];
  const deps = {
    transports: {
      anthropic: failTransport('anthropic', calls, 429),
      codex: (openaiReq, bearer, res) => {
        captured.openaiReq = openaiReq;
        captured.bearer = bearer;
        res.writeHead(200, { 'x-miser-provider': 'codex' });
        res.end();
        return Promise.resolve();
      },
      ollama: successTransport('ollama', calls),
    },
    getBearer: fakeBearer,
    ollamaCap: 32000,
  };
  const res = makeRes();
  await routeRequest(ANTH_MSGS, ANTH_BODY, {}, res, 'proj', 0, 'anthropic', deps);
  // bearer is the subscription token, not an sk- API key
  assert.equal(captured.bearer.token, 'FAKE-ACCESS-TOKEN');
  assert.ok(!captured.bearer.token.startsWith('sk-'));
  // translated request obeys the OpenAI contract (system extracted, string content)
  assert.equal(captured.openaiReq.messages[0].role, 'system');
  assert.ok(captured.openaiReq.messages.every(m => typeof m.content === 'string'));
  assert.ok(!('system' in captured.openaiReq));
});

test('non-429 Anthropic error propagates (no failover on a hard error)', async () => {
  const calls = [];
  const deps = {
    transports: {
      anthropic: failTransport('anthropic', calls, 400),
      codex: successTransport('codex', calls),
      ollama: successTransport('ollama', calls),
    },
    getBearer: fakeBearer,
    ollamaCap: 32000,
  };
  const res = makeRes();
  await assert.rejects(
    () => routeRequest(ANTH_MSGS, ANTH_BODY, {}, res, 'proj', 0, 'anthropic', deps),
    /anthropic 400/,
  );
  assert.deepEqual(calls.map(c => c.name), ['anthropic']);
});

test('openai passthrough format: 429 → Ollama (Codex leg not used)', async () => {
  const calls = [];
  const deps = {
    transports: {
      openaiPassthrough: failTransport('openai', calls, 429),
      codex: successTransport('codex', calls),
      ollama: successTransport('ollama', calls),
    },
    getBearer: fakeBearer,
    ollamaCap: 32000,
  };
  const res = makeRes();
  await routeRequest(ANTH_MSGS, { model: 'gpt', messages: ANTH_MSGS }, {}, res, 'proj', 0, 'openai', deps);
  const names = calls.map(c => c.name);
  assert.deepEqual(names, ['openai', 'ollama']);
});

// REGRESSION (Codex inversion finding #2): a post-header upstream error must
// tear down the downstream response, not leave it hung.
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

// REQUIRED: tests do not bind or connect to :20128. Proven at RUNTIME (not by
// opening a probe socket — that would itself be a forbidden connection): the
// ONLY code that calls server.listen(config.port) is src/index.js. If it was
// never pulled into the module cache, no server was ever instantiated in this
// process, so nothing bound (or could have connected to) :20128.
test('server entrypoint (the only .listen on :20128) is never loaded during tests', () => {
  const loaded = Object.keys(require.cache).map(p => p.replace(/\\/g, '/'));
  assert.ok(
    !loaded.some(p => p.endsWith('/src/index.js')),
    'src/index.js (the server bind) must not be required by any test',
  );
  // Sanity: index.js IS the file that binds the port (documents the invariant).
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(idx, /server\.listen\(config\.port/, 'index.js is the port-binding entrypoint');
});
