'use strict';

// Second-proof (sanctioned by the prompt: "fake/local upstreams"). Exercises the
// REAL forwardToCodex transport against an in-process fake upstream bound to an
// EPHEMERAL 127.0.0.1 port. This never touches :20128, the live Miser service,
// or any real Codex/OpenAI/Anthropic endpoint. It proves Codex-inversion
// finding #1's fix at the transport level: a 401/403 must reject BEFORE writing
// response headers, so the router can fail over to Ollama.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const config = require('../src/config.js');
const { forwardToCodex } = require('../src/router.js');
const { makeRes } = require('./_harness.js');

function startFakeUpstream(status, body) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body || '{}');
    });
    // Ephemeral port on loopback — explicitly NOT :20128.
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

async function withCodexUpstream(status, body, fn) {
  const { srv, port } = await startFakeUpstream(status, body);
  assert.notEqual(port, 20128, 'fake upstream must never bind :20128');
  const prev = config.codexUrl;
  config.codexUrl = `http://127.0.0.1:${port}/v1/chat/completions`;
  try { await fn(port); }
  finally { config.codexUrl = prev; srv.close(); }
}

const OPENAI_REQ = { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
const RESPONSES_REQ = {
  model: 'gpt-5.5',
  instructions: 'be helpful',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  stream: true, store: false,
};
const BEARER = { token: 'FAKE-SUBSCRIPTION-TOKEN', accountId: 'acct_fake' };

for (const status of [401, 403]) {
  test(`real forwardToCodex rejects on ${status} WITHOUT writing headers (enables Ollama failover)`, async () => {
    await withCodexUpstream(status, '{"error":"expired subscription token"}', async () => {
      const res = makeRes();
      await assert.rejects(
        () => forwardToCodex(OPENAI_REQ, BEARER, res, 'proj', 0),
        (e) => e.statusCode === status,
      );
      assert.equal(res.headersSent, false, `must not stream a ${status} auth error to the client`);
    });
  });
}

test('real forwardToCodex rejects on 500 without writing headers', async () => {
  await withCodexUpstream(500, 'upstream boom', async () => {
    const res = makeRes();
    await assert.rejects(() => forwardToCodex(OPENAI_REQ, BEARER, res, 'proj', 0), (e) => e.statusCode === 500);
    assert.equal(res.headersSent, false);
  });
});

test('real forwardToCodex sends subscription Bearer + codex headers, never OPENAI_API_KEY', async () => {
  const seen = {};
  const { srv, port } = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      seen.auth = req.headers['authorization'];
      seen.acct = req.headers['chatgpt-account-id'];
      seen.beta = req.headers['openai-beta'];
      seen.originator = req.headers['originator'];
      seen.ua = req.headers['user-agent'];
      seen.version = req.headers['version'];
      seen.accept = req.headers['accept'];
      res.writeHead(401, { 'content-type': 'application/json' }); // reject so we don't need a real stream
      res.end('{}');
    });
    s.listen(0, '127.0.0.1', () => resolve({ srv: s, port: s.address().port }));
  });
  const prev = config.codexUrl;
  config.codexUrl = `http://127.0.0.1:${port}/backend-api/codex/responses`;
  try {
    const res = makeRes();
    await assert.rejects(() => forwardToCodex(RESPONSES_REQ, BEARER, res, 'proj', 0));
    assert.equal(seen.auth, 'Bearer FAKE-SUBSCRIPTION-TOKEN');
    assert.equal(seen.acct, 'acct_fake');
    // PINNED from live capture: real codex request sends NO openai-beta header.
    assert.equal(seen.beta, undefined);
    assert.equal(seen.originator, 'codex_cli_rs');
    assert.match(seen.ua, /codex/);
    assert.equal(seen.version, '0.144.1');
    assert.equal(seen.accept, 'text/event-stream');
    assert.ok(seen.auth !== 'Bearer sk-METERED'); // never the api key
  } finally {
    config.codexUrl = prev; srv.close();
  }
});

// Full 2xx path: fake Codex upstream emits Responses-API SSE; assert the client
// receives ANTHROPIC SSE (message_start → text_delta → message_stop).
test('real forwardToCodex translates Responses SSE → Anthropic SSE on 200', async () => {
  const frames = [
    'event: response.created\ndata: {"type":"response.created","response":{"usage":{"input_tokens":5}}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" world"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"output_tokens":2}}}\n\n',
  ];
  const { srv, port } = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const f of frames) res.write(f);
      res.end();
    });
    s.listen(0, '127.0.0.1', () => resolve({ srv: s, port: s.address().port }));
  });
  const prev = config.codexUrl;
  config.codexUrl = `http://127.0.0.1:${port}/backend-api/codex/responses`;
  try {
    const res = makeRes();
    await forwardToCodex(RESPONSES_REQ, BEARER, res, 'proj', 0);
    const body = res.body();
    assert.match(body, /event: message_start/);
    assert.match(body, /"type":"text_delta","text":"Hello"/);
    assert.match(body, /"type":"text_delta","text":" world"/);
    assert.match(body, /event: message_stop/);
    // no raw Responses events leak to the client
    assert.ok(!body.includes('response.output_text.delta'));
    assert.equal(res.headers['x-miser-provider'], 'codex');
  } finally {
    config.codexUrl = prev; srv.close();
  }
});
