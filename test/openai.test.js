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

// REDESIGN: compress no longer blind-truncates oldest turns (that was the
// root-cause bug). With no losslessly-dedupable content it preserves every turn
// and surfaces overflow for the proxy to act on.
test('compress does NOT blind-truncate OpenAI messages; surfaces overflow instead', () => {
  const long = 'x'.repeat(2000);
  const messages = [
    { role: 'system', content: 'Be helpful.' },
    ...Array.from({ length: 15 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${i} ${long}`, // unique per turn -> nothing to dedup
    })),
  ];
  const result = compress({ messages }, 500);
  assert.equal(result.messages.length, messages.length); // no silent drops
  assert.equal(result.overflow, true);
});
