'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { translateToOllama, translateOllamaStream } = require('../src/translate.js');
const { makeRes } = require('./_harness.js');

test('adds system message from string system field', () => {
  const result = translateToOllama([], { system: 'Be helpful.', max_tokens: 256 }, 'qwen2.5-coder:14b');
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[0].content, 'Be helpful.');
});

test('adds system message from block array system field', () => {
  const result = translateToOllama([], { system: [{ type: 'text', text: 'Be helpful.' }] }, 'qwen2.5-coder:14b');
  assert.equal(result.messages[0].content, 'Be helpful.');
});

// REGRESSION (Codex inversion R2 finding #2): object-form system must not crash
// the Ollama fallback leg.
test('object-form system {text} does not throw and yields a system turn', () => {
  const result = translateToOllama([{ role: 'user', content: 'hi' }], { system: { text: 'Be helpful.' } }, 'q');
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[0].content, 'Be helpful.');
});

test('object-form system with non-string text is dropped, does not throw', () => {
  const result = translateToOllama([{ role: 'user', content: 'hi' }], { system: { text: { nested: 1 } } }, 'q');
  assert.equal(result.messages[0].role, 'user'); // no bogus system turn
  assert.ok(result.messages.every(m => typeof m.content === 'string'));
});

test('non-array object message content does not throw', () => {
  const result = translateToOllama([{ role: 'user', content: { weird: true } }], {}, 'q');
  assert.ok(Array.isArray(result.messages));
});

// REGRESSION (Codex inversion R3 finding #2): null/malformed blocks in a content
// array must not throw.
test('null block inside content array does not throw', () => {
  const result = translateToOllama([{ role: 'user', content: [null, { type: 'text', text: 'ok' }] }], {}, 'q');
  assert.ok(result.messages.some(m => m.content.includes('ok')));
});

test('circular tool_use input does not throw', () => {
  const circular = {}; circular.self = circular;
  const result = translateToOllama(
    [{ role: 'assistant', content: [{ type: 'tool_use', name: 'fn', input: circular }] }], {}, 'q',
  );
  assert.ok(Array.isArray(result.messages));
});

test('passes string content through unchanged', () => {
  const messages = [{ role: 'user', content: 'hello' }];
  const result = translateToOllama(messages, {}, 'qwen2.5:7b');
  assert.equal(result.messages[0].content, 'hello');
});

test('flattens text content blocks to string', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
  const result = translateToOllama(messages, {}, 'qwen2.5:7b');
  assert.equal(result.messages[0].content, 'hello');
});

test('sets correct model, stream, and num_predict', () => {
  const result = translateToOllama([], { max_tokens: 512 }, 'qwen2.5:3b');
  assert.equal(result.model, 'qwen2.5:3b');
  assert.equal(result.stream, true);
  assert.equal(result.options.num_predict, 512);
});

test('defaults num_predict to 4096 when max_tokens absent', () => {
  const result = translateToOllama([], {}, 'qwen2.5:3b');
  assert.equal(result.options.num_predict, 4096);
});

test('empty Ollama stream produces a complete Anthropic SSE message, not empty 200', async () => {
  const res = makeRes();
  const result = await translateOllamaStream(Readable.from([]), res, 'qwen', {
    headers: { 'x-miser-provider': 'ollama' },
    emptyText: 'miser: local fallback returned an empty response',
  });
  assert.equal(result.ok, false);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  assert.equal(res.headers['x-miser-provider'], 'ollama');
  assert.match(res.body(), /event: message_start/);
  assert.match(res.body(), /miser: local fallback returned an empty response/);
  assert.match(res.body(), /event: message_stop/);
});

test('Ollama stream that starts but never sends done is completed cleanly', async () => {
  const res = makeRes();
  const line = `${JSON.stringify({ message: { content: 'partial text' } })}\n`;
  const result = await translateOllamaStream(Readable.from([line]), res, 'qwen', {
    headers: { 'x-miser-provider': 'ollama' },
  });
  assert.equal(result.ok, false);
  assert.match(res.body(), /partial text/);
  assert.match(res.body(), /event: content_block_stop/);
  assert.match(res.body(), /event: message_stop/);
});

test('Ollama error JSON produces a complete Anthropic SSE message', async () => {
  const res = makeRes();
  const line = `${JSON.stringify({ error: 'model exploded' })}\n`;
  const result = await translateOllamaStream(Readable.from([line]), res, 'qwen', {
    headers: { 'x-miser-provider': 'ollama' },
  });
  assert.equal(result.ok, false);
  assert.match(res.body(), /miser: local fallback error: model exploded/);
  assert.match(res.body(), /event: message_stop/);
});

test('Ollama done with no text emits controlled empty-response message', async () => {
  const res = makeRes();
  const line = `${JSON.stringify({ done: true, eval_count: 0 })}\n`;
  const result = await translateOllamaStream(Readable.from([line]), res, 'qwen', {
    headers: { 'x-miser-provider': 'ollama' },
    emptyText: 'miser: empty done',
  });
  assert.equal(result.ok, false);
  assert.match(res.body(), /miser: empty done/);
  assert.match(res.body(), /event: message_stop/);
});
