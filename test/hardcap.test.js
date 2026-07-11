'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hardCapOllamaBody, bodyTokens } = require('../src/hardcap.js');
const { estimateTokens } = require('../src/compress.js');
const { _buildCappedOllamaBody } = require('../src/router.js');

const CAP = 32000;

test('no-op when already under cap', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'short' }] };
  const out = hardCapOllamaBody(body, CAP);
  assert.deepEqual(out.messages, body.messages);
  assert.ok(bodyTokens(out.messages) <= CAP);
});

test('drops oldest whole messages when over cap', () => {
  const big = 'x'.repeat(40000); // ~10k tokens each
  const messages = Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant', content: big,
  }));
  const out = hardCapOllamaBody({ model: 'm', messages }, CAP);
  assert.ok(bodyTokens(out.messages) <= CAP);
  assert.ok(out.messages.length < messages.length);
  // newest message survives
  assert.equal(out.messages[out.messages.length - 1].content, big);
});

test('trims INSIDE an oversized final message (single huge message)', () => {
  const huge = 'y'.repeat(400000); // ~100k tokens, one message
  const out = hardCapOllamaBody({ model: 'm', messages: [{ role: 'user', content: huge }] }, CAP);
  assert.equal(out.messages.length, 1);
  assert.ok(out.messages[0].content.length < huge.length, 'content was truncated');
  assert.ok(bodyTokens(out.messages) <= CAP, `over cap: ${bodyTokens(out.messages)}`);
  // keeps the TAIL (most recent context)
  assert.ok(huge.endsWith(out.messages[0].content));
});

test('oversized double-fallback payload: Ollama body ends up <= 32k (translate→cap)', () => {
  // Simulate the double-fallback: a compressed-but-still-huge Anthropic payload
  // reaching the Ollama leg. _buildCappedOllamaBody = exactly what
  // forwardToOllama does before sending (translateToOllama → hardCapOllamaBody).
  const huge = 'z'.repeat(500000);
  const messages = [
    { role: 'user', content: huge },
    { role: 'assistant', content: 'x'.repeat(300000) },
    { role: 'user', content: huge },
  ];
  const originalBody = { system: 'w'.repeat(200000), max_tokens: 1024, messages };
  const capped = _buildCappedOllamaBody(messages, originalBody, CAP);
  assert.ok(bodyTokens(capped.messages) <= CAP, `Ollama would receive > cap: ${bodyTokens(capped.messages)}`);
});

test('system message alone, if huge, is trimmed below cap', () => {
  const hugeSys = 's'.repeat(300000);
  const out = hardCapOllamaBody({
    model: 'm',
    messages: [{ role: 'system', content: hugeSys }, { role: 'user', content: 'hi' }],
  }, CAP);
  assert.ok(bodyTokens(out.messages) <= CAP);
  // the live user turn is preserved
  assert.equal(out.messages[out.messages.length - 1].content, 'hi');
});

// REGRESSION (Codex inversion R2 finding #3): num_predict must be clamped.
test('hard-cap clamps an oversized num_predict', () => {
  const out = hardCapOllamaBody(
    { model: 'm', messages: [{ role: 'user', content: 'hi' }], options: { num_predict: 100000 } },
    CAP,
  );
  assert.ok(out.options.num_predict <= 4096, `num_predict not clamped: ${out.options.num_predict}`);
});

test('hard-cap leaves a small num_predict untouched', () => {
  const out = hardCapOllamaBody(
    { model: 'm', messages: [{ role: 'user', content: 'hi' }], options: { num_predict: 512 } },
    CAP,
  );
  assert.equal(out.options.num_predict, 512);
});

// REGRESSION (Codex inversion R4 finding #2): negative num_predict (Ollama's
// "infinite" sentinel) must be clamped to a sane positive bound.
test('hard-cap clamps a negative/unbounded num_predict', () => {
  for (const bad of [-1, 0, NaN, Infinity, -100000]) {
    const out = hardCapOllamaBody(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], options: { num_predict: bad } },
      CAP,
    );
    assert.ok(out.options.num_predict > 0 && out.options.num_predict <= 4096,
      `num_predict not sanely bounded for input ${bad}: ${out.options.num_predict}`);
  }
});

test('num_predict clamp survives the truncation path too', () => {
  const huge = 'y'.repeat(400000);
  const out = hardCapOllamaBody(
    { model: 'm', messages: [{ role: 'user', content: huge }], options: { num_predict: 999999 } },
    CAP,
  );
  assert.ok(out.options.num_predict <= 4096);
  assert.ok(bodyTokens(out.messages) <= CAP);
});

test('estimate math sanity: capped token estimate matches char length', () => {
  const huge = 'q'.repeat(400000);
  const out = hardCapOllamaBody({ model: 'm', messages: [{ role: 'user', content: huge }] }, CAP);
  assert.equal(estimateTokens(out.messages[0].content) + 4, bodyTokens(out.messages));
  assert.ok(bodyTokens(out.messages) <= CAP);
});
