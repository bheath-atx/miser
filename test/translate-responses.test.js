'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { translateToResponses, validateResponsesRequest, translateResponsesStream } = require('../src/translate-responses.js');

// --- Request translation ---------------------------------------------------
test('top-level system becomes Responses `instructions`', () => {
  const req = translateToResponses([{ role: 'user', content: 'hi' }], { system: 'You are helpful.', max_tokens: 50 });
  assert.equal(req.instructions, 'You are helpful.');
  assert.ok(!('system' in req));
  assert.ok(!('messages' in req));
});

test('messages become input items with typed content parts', () => {
  const req = translateToResponses(
    [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
    {},
  );
  assert.equal(req.input[0].type, 'message');
  assert.equal(req.input[0].role, 'user');
  assert.equal(req.input[0].content[0].type, 'input_text');
  assert.equal(req.input[0].content[0].text, 'q');
  // assistant turns use output_text
  assert.equal(req.input[1].role, 'assistant');
  assert.equal(req.input[1].content[0].type, 'output_text');
});

test('empty / directive-only messages are dropped (no empty content parts)', () => {
  const req = translateToResponses(
    [{ role: 'user', content: [] }, { role: 'assistant', content: '' }, { role: 'user', content: 'real' }],
    {},
  );
  assert.equal(req.input.length, 1);
  assert.equal(req.input[0].content[0].text, 'real');
});

test('tool blocks degrade to inline text (never structured)', () => {
  const req = translateToResponses(
    [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'grep', input: { q: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'match' }] },
    ],
    {},
  );
  assert.match(req.input[0].content[0].text, /\[tool call: grep/);
  assert.match(req.input[1].content[0].text, /\[tool result: match\]/);
});

test('max_tokens maps to max_output_tokens; store:false; stream forced true', () => {
  const req = translateToResponses([{ role: 'user', content: 'hi' }], { max_tokens: 256 });
  assert.equal(req.max_output_tokens, 256);
  assert.equal(req.store, false);
  assert.equal(req.stream, true);
});

// REGRESSION (Codex inversion R2 finding): stream must be forced true even when
// the client requested stream:false — the transport only handles SSE.
test('stream is forced true even when client requests stream:false', () => {
  const req = translateToResponses([{ role: 'user', content: 'hi' }], { stream: false });
  assert.equal(req.stream, true);
});

// The brick-prevention guarantee for the Responses shape.
test('validateResponsesRequest passes a clean request and rejects leaks', () => {
  const good = translateToResponses([{ role: 'user', content: 'hi' }], { system: 'sys' });
  assert.equal(validateResponsesRequest(good).valid, true);

  // REGRESSION (Codex inversion finding #1): empty input must be rejected so the
  // router fails closed to Ollama instead of shipping a useless Codex request.
  assert.equal(validateResponsesRequest({ input: [] }).valid, false);
  assert.match(validateResponsesRequest({ input: [] }).error, /empty input/);
  assert.equal(validateResponsesRequest({ input: [], system: 'x' }).valid, false);
  assert.equal(validateResponsesRequest({ input: [{ type: 'message', role: 'user', content: [] }] }).valid, false);
  assert.equal(validateResponsesRequest({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }] }] }).valid, false);
  assert.match(validateResponsesRequest({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: [] }] }] }).error, /non-empty string/);
});

test('object-form system.text non-string is dropped, request stays valid', () => {
  const req = translateToResponses([{ role: 'user', content: 'hi' }], { system: { text: { nested: true } } });
  assert.ok(!('instructions' in req) || typeof req.instructions === 'string');
  assert.equal(validateResponsesRequest(req).valid, true);
});

// --- Stream translation: Responses SSE → Anthropic SSE ---------------------
function fakeUpstream() {
  const em = new EventEmitter();
  em.setEncoding = () => {}; // translateResponsesStream calls this
  return em;
}
function collectRes() {
  return {
    writableEnded: false,
    chunks: [],
    write(c) { this.chunks.push(String(c)); return true; },
    end() { this.writableEnded = true; },
    body() { return this.chunks.join(''); },
  };
}

test('translateResponsesStream emits Anthropic events from Responses SSE', () => {
  const up = fakeUpstream();
  const res = collectRes();
  translateResponsesStream(up, res, 'gpt-5.5');
  up.emit('data', 'event: response.created\ndata: {"type":"response.created","response":{"usage":{"input_tokens":7}}}\n\n');
  up.emit('data', 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n');
  up.emit('data', 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"output_tokens":3}}}\n\n');
  up.emit('end');
  const body = res.body();
  assert.match(body, /event: message_start/);
  assert.match(body, /"input_tokens":7/);
  assert.match(body, /"type":"text_delta","text":"Hi"/);
  assert.match(body, /"output_tokens":3/);
  assert.match(body, /event: message_stop/);
  assert.ok(res.writableEnded);
});

// REGRESSION (Codex inversion finding #2): CRLF-framed SSE must parse as frames.
test('translateResponsesStream parses CRLF-framed SSE', () => {
  const up = fakeUpstream();
  const res = collectRes();
  translateResponsesStream(up, res, 'm');
  up.emit('data', 'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"crlf"}\r\n\r\n');
  up.emit('data', 'event: response.completed\r\ndata: {"type":"response.completed"}\r\n\r\n');
  up.emit('end');
  const body = res.body();
  assert.match(body, /"text":"crlf"/);
  assert.match(body, /event: message_stop/);
});

test('translateResponsesStream parses CRLF split across chunk boundary', () => {
  const up = fakeUpstream();
  const res = collectRes();
  translateResponsesStream(up, res, 'm');
  // split right inside the \r\n\r\n frame terminator
  up.emit('data', 'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"split"}\r');
  up.emit('data', '\n\r\nevent: response.completed\r\ndata: {"type":"response.completed"}\r\n\r\n');
  up.emit('end');
  assert.match(res.body(), /"text":"split"/);
});

test('translateResponsesStream tolerates split frames across chunks', () => {
  const up = fakeUpstream();
  const res = collectRes();
  translateResponsesStream(up, res, 'm');
  up.emit('data', 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","del');
  up.emit('data', 'ta":"partial"}\n\n');
  up.emit('end');
  assert.match(res.body(), /"text":"partial"/);
});

test('translateResponsesStream ends cleanly on response.failed (no hang)', () => {
  const up = fakeUpstream();
  const res = collectRes();
  translateResponsesStream(up, res, 'm');
  up.emit('data', 'event: response.failed\ndata: {"type":"response.failed"}\n\n');
  up.emit('end');
  assert.match(res.body(), /event: message_stop/);
  assert.ok(res.writableEnded);
});

test('translateResponsesStream ignores unknown events and malformed data', () => {
  const up = fakeUpstream();
  const res = collectRes();
  translateResponsesStream(up, res, 'm');
  up.emit('data', 'event: response.some_future_event\ndata: {"type":"x"}\n\n');
  up.emit('data', 'event: response.output_text.delta\ndata: {bad json\n\n');
  up.emit('data', 'event: response.completed\ndata: {"type":"response.completed"}\n\n');
  up.emit('end');
  const body = res.body();
  assert.match(body, /event: message_stop/);
  assert.ok(res.writableEnded);
});
