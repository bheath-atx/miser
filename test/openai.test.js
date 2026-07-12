'use strict';

// §3.8 OpenAI-format path (`/v1/chat/completions`) tests. compress() v2:
// skips Anthropic normalization/first-message rules and losslessly dedups
// repeated tool results on paired identity. Socket-free.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { translateToOllama } = require('../src/translate.js');
const { compress, MIN_KEEP } = require('../src/compress.js');

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

test('compress (openai): system stays in messages[], no anthropic normalization', () => {
  const body = {
    model: 'gpt-5.5',
    messages: [
      { role: 'system', content: 'Be helpful.' },
      { role: 'user', content: 'hello' },
    ],
  };
  const result = compress(body, { format: 'openai' });
  // system NOT hoisted to body.system — it remains a messages[] turn.
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].role, 'system');
  assert.ok(!('system' in result.body) || result.body.system == null);
  assert.equal(result.tokens, result.rawTokens); // nothing dedupable → no reduction
});

test('compress (openai): no blind truncation — every unique turn preserved', () => {
  const long = 'x'.repeat(2000);
  const messages = [
    { role: 'system', content: 'Be helpful.' },
    ...Array.from({ length: 15 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${i} ${long}`,
    })),
  ];
  const result = compress({ messages }, { format: 'openai' });
  assert.equal(result.messages.length, messages.length); // no silent drops
  assert.equal(result.tokens, result.rawTokens);
});

// §3.8 — role:'tool' identity = [fn.name, fn.arguments, content], paired by
// tool_call_id to the answering assistant.tool_calls[].
test('compress (openai): duplicate role:tool results deduped to newest (paired by tool_call_id)', () => {
  const dup = 'byte-identical tool output';
  const asstCall = (id) => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name: 'get_file', arguments: '{"path":"/a"}' } }],
  });
  const toolMsg = (id, content) => ({ role: 'tool', tool_call_id: id, content });
  const messages = [
    { role: 'user', content: 'task' },
    asstCall('c1'), toolMsg('c1', dup),
    asstCall('c2'), toolMsg('c2', 'u2'),
    asstCall('c3'), toolMsg('c3', 'u3'),
    asstCall('c4'), toolMsg('c4', 'u4'),
    asstCall('c5'), toolMsg('c5', dup), // newest identical (same fn name+args+content)
    { role: 'assistant', content: 'done' },
  ];
  const result = compress({ messages }, { format: 'openai' });
  // Older (idx2) collapsed to a stub; newest (idx10) intact.
  assert.match(result.messages[2].content, /^\[miser: identical to turn 10\]$/);
  assert.equal(result.messages[10].content, dup);
});

test('compress (openai): different fn arguments → NOT deduped even if content matches', () => {
  const same = 'identical bytes';
  const asstCall = (id, args) => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name: 'get_file', arguments: args } }],
  });
  const toolMsg = (id, content) => ({ role: 'tool', tool_call_id: id, content });
  const messages = [
    { role: 'user', content: 'task' },
    asstCall('c1', '{"path":"/a"}'), toolMsg('c1', same),
    asstCall('c2', '{"x":1}'), toolMsg('c2', 'u2'),
    asstCall('c3', '{"x":2}'), toolMsg('c3', 'u3'),
    asstCall('c4', '{"x":3}'), toolMsg('c4', 'u4'),
    asstCall('c5', '{"path":"/b"}'), toolMsg('c5', same), // different args → different identity
    { role: 'assistant', content: 'done' },
  ];
  const result = compress({ messages }, { format: 'openai' });
  assert.equal(result.messages[2].content, same);
  assert.equal(result.messages[10].content, same);
});

// §3.8 legacy role:'function' identity = [name, paired function_call.arguments, content].
test('compress (openai): legacy role:function results deduped on function_call identity', () => {
  const dup = 'legacy function output';
  const asstFn = (args) => ({ role: 'assistant', content: null, function_call: { name: 'lookup', arguments: args } });
  const fnMsg = (content) => ({ role: 'function', name: 'lookup', content });
  const messages = [
    { role: 'user', content: 'task' },
    asstFn('{"q":"a"}'), fnMsg(dup),
    asstFn('{"q":"b"}'), fnMsg('u2'),
    asstFn('{"q":"c"}'), fnMsg('u3'),
    asstFn('{"q":"d"}'), fnMsg('u4'),
    asstFn('{"q":"a"}'), fnMsg(dup), // same name + same args + same content → newest wins
    { role: 'assistant', content: 'done' },
  ];
  const result = compress({ messages }, { format: 'openai' });
  assert.match(result.messages[2].content, /^\[miser: identical to turn 10\]$/);
  assert.equal(result.messages[10].content, dup);
});

test('compress (openai): un-locatable pair → treated as unique (never deduped)', () => {
  const dup = 'orphan output';
  const toolMsg = (id, content) => ({ role: 'tool', tool_call_id: id, content });
  const messages = [
    { role: 'user', content: 'task' },
    toolMsg('missing1', dup), // no answering assistant.tool_calls
    { role: 'assistant', content: 'mid' },
    { role: 'user', content: 'more' },
    { role: 'assistant', content: 'mid2' },
    { role: 'user', content: 'more2' },
    { role: 'assistant', content: 'mid3' },
    { role: 'user', content: 'more3' },
    { role: 'assistant', content: 'mid4' },
    { role: 'user', content: 'more4' },
    toolMsg('missing2', dup), // also un-locatable
    { role: 'assistant', content: 'done' },
  ];
  const result = compress({ messages }, { format: 'openai' });
  // Neither collapsed — un-locatable pairs are always unique.
  assert.equal(result.messages[1].content, dup);
  assert.equal(result.messages[10].content, dup);
});

test('compress (openai): tail results (within MIN_KEEP) are authoritative, never stubbed', () => {
  const dup = 'tail dup';
  const asstCall = (id) => ({
    role: 'assistant', content: null,
    tool_calls: [{ id, type: 'function', function: { name: 'f', arguments: '{}' } }],
  });
  const toolMsg = (id, content) => ({ role: 'tool', tool_call_id: id, content });
  // Two identical results both inside the last MIN_KEEP turns → neither stubbed.
  const messages = [
    { role: 'user', content: 'task' },
    ...Array.from({ length: MIN_KEEP }, (_, i) => (i % 2 === 0 ? asstCall(`c${i}`) : toolMsg(`c${i - 1}`, dup))),
  ];
  const result = compress({ messages }, { format: 'openai' });
  const stubbed = result.messages.filter(m => m.role === 'tool' && /^\[miser: identical/.test(m.content));
  assert.equal(stubbed.length, 0);
});
