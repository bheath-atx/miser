'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compress, estimateTokens, messageTokens, validateMessageIntegrity } = require('../src/compress.js');

test('estimateTokens returns 0 for empty/null', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});

test('estimateTokens approximates sensibly', () => {
  const t = estimateTokens('hello world');
  assert.ok(t > 0 && t < 10);
});

test('compress is a no-op under threshold', () => {
  const body = {
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ],
  };
  const result = compress(body, 32000);
  assert.equal(result.messages.length, 2);
  assert.equal(result.tokens, result.rawTokens);
});

test('compress drops oldest messages when over threshold', () => {
  const long = 'x'.repeat(1000);
  const messages = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: long,
  }));
  const result = compress({ messages }, 500);
  assert.ok(result.messages.length < messages.length);
});

test('compress always keeps at least MIN_KEEP messages', () => {
  const long = 'x'.repeat(50000);
  const messages = [
    { role: 'user', content: long },
    { role: 'assistant', content: long },
    { role: 'user', content: long },
    { role: 'assistant', content: long },
    { role: 'user', content: long },
  ];
  const result = compress({ messages }, 1);
  assert.ok(result.messages.length >= 4);
});

test('compress accounts for system tokens', () => {
  const body = { system: 'x'.repeat(4000), messages: [{ role: 'user', content: 'hi' }] };
  const result = compress(body, 100);
  // system alone (~1000 tokens) exceeds threshold — messages list may be at MIN_KEEP
  assert.ok(result.rawTokens > 100);
});

test('compress never orphans tool_result when dropping pair would hit MIN_KEEP', () => {
  const long = 'x'.repeat(5000);
  // 5 messages: exactly at MIN_KEEP+1 so dropping the pair would hit MIN_KEEP
  const messages = [
    { role: 'user', content: long },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'fn', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: long }] },
    { role: 'assistant', content: long },
    { role: 'user', content: long },
  ];
  const result = compress({ messages }, 1);
  const integrity = validateMessageIntegrity(result.messages);
  assert.ok(integrity.valid, `orphaned tool_result: ${integrity.error}`);
});

test('compress drops tool_use+tool_result pair together when safe', () => {
  const long = 'x'.repeat(5000);
  // 6 messages: enough room to drop the pair without hitting MIN_KEEP
  const messages = [
    { role: 'user', content: long },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'fn', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: long }] },
    { role: 'assistant', content: long },
    { role: 'user', content: long },
    { role: 'assistant', content: long },
  ];
  const result = compress({ messages }, 1);
  const integrity = validateMessageIntegrity(result.messages);
  assert.ok(integrity.valid, `orphaned tool_result after compress: ${integrity.error}`);
});

test('validateMessageIntegrity catches orphaned tool_result', () => {
  const messages = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing_id', content: 'x' }] },
  ];
  const result = validateMessageIntegrity(messages);
  assert.equal(result.valid, false);
  assert.ok(result.error.includes('missing_id'));
});

test('validateMessageIntegrity passes clean messages', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'fn', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
  ];
  assert.deepEqual(validateMessageIntegrity(messages), { valid: true });
});
