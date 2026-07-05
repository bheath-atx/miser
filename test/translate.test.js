'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { translateToOllama } = require('../src/translate.js');

test('adds system message from string system field', () => {
  const result = translateToOllama([], { system: 'Be helpful.', max_tokens: 256 }, 'qwen2.5-coder:14b');
  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[0].content, 'Be helpful.');
});

test('adds system message from block array system field', () => {
  const result = translateToOllama([], { system: [{ type: 'text', text: 'Be helpful.' }] }, 'qwen2.5-coder:14b');
  assert.equal(result.messages[0].content, 'Be helpful.');
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
