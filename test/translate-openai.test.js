'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { translateToOpenAI, validateOpenAIRequest } = require('../src/translate-openai.js');

test('top-level Anthropic system becomes a leading OpenAI system message', () => {
  const req = translateToOpenAI(
    [{ role: 'user', content: 'hi' }],
    { system: 'You are helpful.', model: 'claude', max_tokens: 100 },
  );
  assert.equal(req.messages[0].role, 'system');
  assert.equal(req.messages[0].content, 'You are helpful.');
  assert.equal(req.messages[1].role, 'user');
  assert.equal(req.messages[1].content, 'hi');
});

test('block-array system is flattened to text', () => {
  const req = translateToOpenAI(
    [{ role: 'user', content: 'hi' }],
    { system: [{ type: 'text', text: 'Line A' }, { type: 'text', text: 'Line B' }] },
  );
  assert.equal(req.messages[0].role, 'system');
  assert.equal(req.messages[0].content, 'Line A\nLine B');
});

test('text ordering is preserved across blocks and messages', () => {
  const req = translateToOpenAI(
    [
      { role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
      { role: 'assistant', content: 'three' },
      { role: 'user', content: 'four' },
    ],
    {},
  );
  const texts = req.messages.map(m => m.content);
  assert.deepEqual(texts, ['one\ntwo', 'three', 'four']);
});

test('tool_use / tool_result blocks are degraded to inline text (not structured)', () => {
  const req = translateToOpenAI(
    [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'grep', input: { q: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'match' }] },
    ],
    {},
  );
  assert.ok(req.messages.every(m => typeof m.content === 'string'));
  assert.match(req.messages[0].content, /\[tool call: grep/);
  assert.match(req.messages[1].content, /\[tool result: match\]/);
  // no structured tool fields leaked
  assert.ok(req.messages.every(m => !('tool_calls' in m) && !('tool_use_id' in m)));
});

test('empty / directive-only messages are dropped (never content:[])', () => {
  const req = translateToOpenAI(
    [
      { role: 'user', content: [] },                 // Anthropic directive-only form
      { role: 'assistant', content: '' },            // empty string
      { role: 'user', content: 'real' },
    ],
    {},
  );
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].content, 'real');
  assert.ok(req.messages.every(m => typeof m.content === 'string' && m.content.length > 0));
});

// The load-bearing regression test for the recovered brick.
test('translated request CANNOT trigger the prior messages.0 error', () => {
  // Reconstruct the exact bad shape: a top-level system AND an Anthropic
  // system-directive block sitting at messages[0] (content:[] + output_config).
  const badAnthropic = {
    system: 'top-level system prompt',
    model: 'claude',
    max_tokens: 200,
    messages: [
      { role: 'assistant', content: [], output_config: { foo: 'bar' } }, // directive-only
      { role: 'user', content: 'actual question' },
    ],
  };
  const req = translateToOpenAI(badAnthropic.messages, badAnthropic);
  const check = validateOpenAIRequest(req);
  assert.equal(check.valid, true, `should be valid: ${check.error}`);

  // Structural guarantees that make messages.0 impossible downstream:
  assert.ok(req.messages.every(m => typeof m.content === 'string'), 'all content is string');
  assert.ok(req.messages.every(m => m.content.length > 0), 'no empty content');
  assert.ok(req.messages.every(m => !('output_config' in m)), 'no output_config leak');
  assert.equal(req.messages[0].role, 'system');
  assert.equal(req.messages[0].content, 'top-level system prompt');
  // Anthropic-only top-level keys never survive onto the request
  assert.ok(!('system' in req));
  assert.ok(!('output_config' in req));
  assert.ok(!('tools' in req));
});

test('validateOpenAIRequest rejects an array-content (Anthropic block) message', () => {
  const bad = { model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
  const check = validateOpenAIRequest(bad);
  assert.equal(check.valid, false);
  assert.match(check.error, /content must be a string/);
});

// REGRESSION (Codex inversion finding #3): a system object with a non-string
// .text must never become message content.
test('non-string object system.text is dropped, never emitted as content', () => {
  const req = translateToOpenAI([{ role: 'user', content: 'hi' }], { system: { text: { nested: true } } });
  const check = validateOpenAIRequest(req);
  assert.equal(check.valid, true, `should stay valid: ${check.error}`);
  assert.ok(req.messages.every(m => typeof m.content === 'string'), 'all content strings');
  assert.equal(req.messages[0].role, 'user', 'bogus system turn dropped');
});

test('string object system.text is accepted as the system turn', () => {
  const req = translateToOpenAI([{ role: 'user', content: 'hi' }], { system: { text: 'hello sys' } });
  assert.equal(req.messages[0].role, 'system');
  assert.equal(req.messages[0].content, 'hello sys');
});

test('block-array system with a non-string block.text is skipped, not stringified', () => {
  const req = translateToOpenAI([{ role: 'user', content: 'hi' }], {
    system: [{ type: 'text', text: 'good' }, { type: 'text', text: { bad: 1 } }],
  });
  assert.equal(req.messages[0].content, 'good');
  assert.ok(req.messages.every(m => typeof m.content === 'string'));
});

test('validateOpenAIRequest rejects a leaked anthropic-only key', () => {
  const bad = { model: 'x', system: 'leak', messages: [{ role: 'user', content: 'hi' }] };
  const check = validateOpenAIRequest(bad);
  assert.equal(check.valid, false);
  assert.match(check.error, /anthropic-only key/);
});
