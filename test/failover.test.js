'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { routeRequest, teardownResponse } = require('../src/router.js');
const { compress } = require('../src/compress.js');
const { translateToResponses } = require('../src/translate-responses.js');
const { translateToOllama } = require('../src/translate.js');
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

test('Codex leg receives a validated Responses request + the subscription bearer', async () => {
  const captured = {};
  const calls = [];
  const deps = {
    transports: {
      anthropic: failTransport('anthropic', calls, 429),
      codex: (codexReq, bearer, res) => {
        captured.codexReq = codexReq;
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
  // default format is the Responses API: system → instructions, input items with
  // typed content parts, and NO anthropic-only keys leaked.
  assert.equal(captured.codexReq.instructions, 'sys');
  assert.ok(Array.isArray(captured.codexReq.input));
  assert.equal(captured.codexReq.input[0].type, 'message');
  assert.ok(captured.codexReq.input[0].content.every(p => typeof p.text === 'string' && p.text.length > 0));
  assert.ok(!('system' in captured.codexReq));
  assert.ok(!('messages' in captured.codexReq));
});

// REGRESSION (Codex inversion finding #1): if the Anthropic messages flatten to
// no usable text, the Responses request would be empty — the router must fail
// closed past Codex to Ollama, never ship an empty Codex request.
test('empty-flattening messages skip Codex and fail over to Ollama', async () => {
  const calls = [];
  const deps = {
    transports: {
      anthropic: failTransport('anthropic', calls, 429),
      codex: successTransport('codex', calls), // would succeed — must be skipped
      ollama: successTransport('ollama', calls),
    },
    getBearer: fakeBearer,
    ollamaCap: 32000,
  };
  const emptyMsgs = [{ role: 'user', content: [] }]; // flattens to nothing
  const res = makeRes();
  await routeRequest(emptyMsgs, { model: 'claude', messages: emptyMsgs }, {}, res, 'proj', 0, 'anthropic', deps);
  const names = calls.map(c => c.name);
  assert.deepEqual(names, ['anthropic', 'ollama']);
  assert.ok(!names.includes('codex'), 'Codex must be skipped when the translated request would be empty');
});

// ===========================================================================
// AC9 (MF3) — LOAD-BEARING: the reduced body (hoisted top-level system + dedup
// stub) produced by compress() is exactly what Legs 2 (Codex) and 3 (Ollama)
// forward under an Anthropic 429. If any leg rebuilt from the ORIGINAL (pre-
// reduction) body — a role:system turn still in messages[], the duplicate NOT
// stubbed — these assertions fail.
// ===========================================================================

// A transcript that (a) needs role:system HOIST and (b) has a byte-identical
// duplicate tool_result OUTSIDE the recent tail so dedup stubs the older copy.
function reducibleTranscript() {
  const dup = 'DUP-' + 'x'.repeat(400);
  const mk = (id, content) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] });
  const messages = [
    { role: 'system', content: 'HOISTED-SYSTEM-MARKER' },              // must hoist to top-level
    { role: 'user', content: 'FIRST TASK unique handoff' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'Read', input: { file_path: '/c' } }] },
    mk('a1', dup),                                                     // OLD dup → stubbed
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a2', name: 'fn', input: { n: 2 } }] },
    mk('a2', 'u2'),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a3', name: 'fn', input: { n: 3 } }] },
    mk('a3', 'u3'),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a4', name: 'fn', input: { n: 4 } }] },
    mk('a4', 'u4'),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a5', name: 'Read', input: { file_path: '/c' } }] },
    mk('a5', dup),                                                     // NEW dup → authoritative
    { role: 'assistant', content: 'done' },
  ];
  return { body: { model: 'claude', max_tokens: 100, messages }, dup };
}

test('AC9/MF3: Anthropic 429 → Leg 2 (Codex) receives the reduced body — hoisted system + dedup stub', async () => {
  const { body: originalBody } = reducibleTranscript();
  const reduced = compress(originalBody, { format: 'anthropic', cacheHint: false });

  // Sanity: compress() actually hoisted + stubbed (so the leg assertions are meaningful).
  // After the role:system hoist, the older duplicate lands at index 2 and points
  // at the newest authoritative copy at turn 10.
  assert.equal(reduced.body.system, 'HOISTED-SYSTEM-MARKER');
  assert.match(reduced.messages[2].content[0].content, /^\[miser: identical to turn 10\]$/);

  const captured = {};
  const calls = [];
  const deps = {
    transports: {
      anthropic: failTransport('anthropic', calls, 429),
      codex: (codexReq, bearer, res) => {
        captured.codexReq = codexReq;
        res.writeHead(200, { 'x-miser-provider': 'codex' });
        res.end();
        return Promise.resolve();
      },
      ollama: (...a) => { calls.push({ name: 'ollama', args: a }); throw new Error('ollama must not be called'); },
    },
    getBearer: fakeBearer,
    ollamaCap: 32000,
  };
  const res = makeRes();
  // proxy.js forwards (reduced.messages, reduced.body). Mirror that exactly.
  await routeRequest(reduced.messages, reduced.body, {}, res, 'proj', 0, 'anthropic', deps);

  // The Codex request is built from the REDUCED args (translateToResponses).
  const expected = translateToResponses(reduced.messages, reduced.body);
  // Leg 2 carries the HOISTED system as `instructions` (would be absent if it
  // rebuilt from originalBody, where system is still a role:system message turn).
  assert.equal(captured.codexReq.instructions, 'HOISTED-SYSTEM-MARKER');
  assert.deepEqual(captured.codexReq, expected);
  // The dedup stub reached Leg 2: the flattened tool_result text is the stub, and
  // the full duplicate payload appears EXACTLY ONCE (the newest authoritative
  // copy). If the leg rebuilt from originalBody it would appear TWICE.
  const flat = JSON.stringify(captured.codexReq.input);
  assert.match(flat, /\[miser: identical to turn 10\]/);
  const dupHits = (flat.match(/DUP-x{400}/g) || []).length;
  assert.equal(dupHits, 1, 'the duplicate payload must reach Leg 2 exactly once (older copy stubbed)');
});

test('AC9/MF3: Anthropic 429 → Codex 429 → Leg 3 (Ollama) receives the reduced body — hoisted system + dedup stub', async () => {
  const { body: originalBody } = reducibleTranscript();
  const reduced = compress(originalBody, { format: 'anthropic', cacheHint: false });

  const captured = {};
  const calls = [];
  const deps = {
    transports: {
      anthropic: failTransport('anthropic', calls, 429),
      codex: failTransport('codex', calls, 429),
      ollama: (messages, body, res, project, savedTokens, opts) => {
        captured.messages = messages;
        captured.body = body;
        res.writeHead(200, { 'x-miser-provider': 'ollama' });
        res.end();
        return Promise.resolve();
      },
    },
    getBearer: fakeBearer,
    ollamaCap: 32000,
  };
  const res = makeRes();
  await routeRequest(reduced.messages, reduced.body, {}, res, 'proj', 0, 'anthropic', deps);

  // Leg 3 got the reduced body verbatim — hoisted top-level system present, and
  // the role:system turn is gone from messages[].
  assert.equal(captured.body.system, 'HOISTED-SYSTEM-MARKER');
  assert.ok(!captured.messages.some(m => m.role === 'system'));
  // Translate exactly as forwardToOllama does and assert the stub survived and
  // the hoisted system became the leading system turn (proves reduced-body use).
  const ollamaBody = translateToOllama(captured.messages, captured.body, 'test-model');
  assert.equal(ollamaBody.messages[0].role, 'system');
  assert.equal(ollamaBody.messages[0].content, 'HOISTED-SYSTEM-MARKER');
  const flat = JSON.stringify(ollamaBody.messages);
  assert.match(flat, /\[miser: identical to turn 10\]/);
  const dupHits = (flat.match(/DUP-x{400}/g) || []).length;
  assert.equal(dupHits, 1, 'the duplicate payload must reach Leg 3 exactly once (older copy stubbed)');
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

// ===========================================================================
// SF3 (grok SF2) — PROXY-LEVEL end-to-end: a real client request flows through
// the proxy handler → compress() → routeRequest(); an Anthropic 429 (injected via
// the proxy's routeRequest deps seam) must fail over to Leg 2 (Codex). This closes
// the last wiring gap at the proxy layer — proving the proxy actually calls
// routeRequest such that failover fires, not just that routeRequest can fail over
// when driven directly. Zero sockets: transports are mocked; index.js (the only
// port bind) is never loaded.
// ===========================================================================
const { createProxy } = require('../src/proxy.js');

// Minimal fake req that streams a JSON body to the proxy's on('data')/on('end').
function proxyReq(bodyObj, headers = {}) {
  const raw = JSON.stringify(bodyObj);
  const listeners = {};
  const req = { method: 'POST', url: '/v1/messages', headers, on(evt, cb) { listeners[evt] = cb; return req; } };
  process.nextTick(() => {
    if (listeners.data) listeners.data(Buffer.from(raw));
    if (listeners.end) listeners.end();
  });
  return req;
}

test('SF3: proxy request → compress → routeRequest(Anthropic 429) → fails over to Leg 2 (Codex)', async () => {
  const calls = [];
  const captured = {};
  // Injected deps ride through createProxy → routeRequest verbatim. The Anthropic
  // leg 429s; the Codex leg captures what it received and succeeds. Ollama would
  // throw if reached.
  const deps = {
    transports: {
      anthropic: failTransport('anthropic', calls, 429),
      codex: (codexReq, bearer, res) => {
        calls.push({ name: 'codex' });
        captured.codexReq = codexReq;
        res.writeHead(200, { 'x-miser-provider': 'codex' });
        res.end('ok:codex');
        return Promise.resolve();
      },
      ollama: (...a) => { calls.push({ name: 'ollama', args: a }); throw new Error('ollama must not be called'); },
    },
    getBearer: fakeBearer,
    ollamaCap: 32000,
  };
  const handler = createProxy(deps);
  const res = makeRes();
  // A transcript that needs a role:system HOIST so we can also prove the REDUCED
  // (compressed) body — not the original — is what reaches Leg 2.
  const body = {
    model: 'claude',
    max_tokens: 100,
    messages: [
      { role: 'system', content: 'PROXY-HOISTED-SYSTEM' },
      { role: 'user', content: 'hello from client' },
    ],
  };
  const done = new Promise((resolve) => { const e = res.end.bind(res); res.end = (c) => { const r = e(c); resolve(); return r; }; });
  handler(proxyReq(body), res);
  await done;

  // Failover fired end-to-end at the PROXY layer: Anthropic → Codex, no Ollama.
  assert.deepEqual(calls.map(c => c.name), ['anthropic', 'codex']);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-miser-provider'], 'codex');
  // Leg 2 received the REDUCED body: the role:system was hoisted to `instructions`
  // (it would be absent if the proxy had forwarded the pre-compress original).
  assert.equal(captured.codexReq.instructions, 'PROXY-HOISTED-SYSTEM');
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
