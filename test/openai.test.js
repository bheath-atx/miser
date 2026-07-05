'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { translateToOllama } = require('../src/translate.js');
const { compress } = require('../src/compress.js');

// OpenAI format: system message lives IN the messages array, not in body.system
test('translateToOllama handles OpenAI-style messages (system in array)', () => {
  const messages = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Hello' },
  ];
  const result = translateToOllama(messages, {}, 'qwen2.5-coder:14b');
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[0].content, 'You are helpful.');
  assert.equal(result.messages[1].role, 'user');
});

test('compress works on OpenAI-format body (no separate system field)', () => {
  const body = {
    model: 'gpt-5.5',
    messages: [
      { role: 'system', content: 'Be helpful.' },
      { role: 'user', content: 'hello' },
    ],
  };
  const result = compress(body, 32000);
  assert.equal(result.messages.length, 2);
  assert.equal(result.tokens, result.rawTokens);
});

test('compress drops oldest OpenAI messages when over threshold', () => {
  const long = 'x'.repeat(2000);
  const messages = [
    { role: 'system', content: 'Be helpful.' },
    ...Array.from({ length: 15 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: long,
    })),
  ];
  const result = compress({ messages }, 500);
  assert.ok(result.messages.length < messages.length);
});
