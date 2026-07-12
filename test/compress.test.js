'use strict';

// compress() v2 test suite — LOSSLESS dedup, no truncation, no ceiling.
// Covers AC1–AC10 (+ the §8.6 threshold grep-guard). All tests are socket-free:
// nothing here binds :20128 or connects to Anthropic/Codex/Ollama.
//
// §8.7 build-time verification note: Anthropic's `tool_result` block legally
// carries a text stub in its `content` (content is a string OR an array of
// blocks — https://docs.anthropic.com/en/api/messages, tool_result schema). So
// replacing a duplicate result's `content` with the string stub
// `[miser: identical to turn N]` is wire-legal and model-equivalent for a
// byte-identical newest copy. Image/document blocks are NOT touched (out of
// scope, §7 Q1) — there is no proven wire-legal stub form for them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  compress,
  estimateTokens,
  messageTokens,
  validateMessageIntegrity,
  normalizeAnthropicBody,
  MIN_KEEP,
  __test,
} = require('../src/compress.js');

// ---------------------------------------------------------------------------
// estimate helpers (observability only)
// ---------------------------------------------------------------------------
test('estimateTokens returns 0 for empty/null', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});

test('estimateTokens approximates sensibly', () => {
  const t = estimateTokens('hello world');
  assert.ok(t > 0 && t < 10);
});

test('compress returns the reduced-body contract { body, messages, tokens, rawTokens }', () => {
  const body = {
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ],
  };
  const result = compress(body);
  assert.ok(result.body && typeof result.body === 'object');
  assert.ok(Array.isArray(result.messages));
  assert.equal(result.body.messages, result.messages); // body carries the same messages
  assert.equal(typeof result.tokens, 'number');
  assert.equal(typeof result.rawTokens, 'number');
});

// ---------------------------------------------------------------------------
// Robustness regressions carried forward from v1 (must not throw)
// ---------------------------------------------------------------------------
test('compress does not throw on object-form system {text}', () => {
  const body = { system: { text: 'x'.repeat(4000) }, messages: [{ role: 'user', content: 'hi' }] };
  const result = compress(body);
  assert.ok(result.rawTokens > 0);
});

test('compress does not throw on null block inside content array', () => {
  const body = { messages: [{ role: 'user', content: [null, { type: 'text', text: 'ok' }] }] };
  const result = compress(body);
  assert.equal(result.messages.length, 1);
});

test('compress does not throw on circular block content', () => {
  const circular = {}; circular.self = circular;
  const body = { messages: [{ role: 'user', content: [circular] }] };
  const result = compress(body);
  assert.ok(result.rawTokens >= 0);
});

// ---------------------------------------------------------------------------
// §3.1 normalization
// ---------------------------------------------------------------------------
test('normalizeAnthropicBody hoists leading role:system into top-level system', () => {
  const messages = [
    { role: 'system', content: 'You are Claude Code.' },
    { role: 'user', content: 'hello' },
  ];
  const { body: out, messages: clean } = normalizeAnthropicBody({}, messages);
  assert.equal(out.system, 'You are Claude Code.');
  assert.equal(clean.length, 1);
  assert.ok(!clean.some(m => m.role === 'system'));
});

test('normalizeAnthropicBody merges existing top-level system with role:system messages', () => {
  const messages = [
    { role: 'system', content: 'Patch block.' },
    { role: 'user', content: 'go' },
  ];
  const { body: out } = normalizeAnthropicBody({ system: 'Base prompt.' }, messages);
  assert.equal(out.system, 'Base prompt.\nPatch block.');
});

// ===========================================================================
// AC1 — 200K request with heavy duplicate tool_results → deduped + forwarded
//       (never miser-413'd).
// ===========================================================================
function bigDuplicateTranscript(dup, uniquePrefix) {
  const mk = (i, content) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu${i}`, content }] });
  return [
    { role: 'user', content: 'FIRST TASK: unique handoff that must survive' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/big.txt' } }] },
    mk(1, dup),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu4', name: 'fn', input: { n: 4 } }] },
    mk(4, `${uniquePrefix}-4`),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu6', name: 'fn', input: { n: 6 } }] },
    mk(6, `${uniquePrefix}-6`),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu8', name: 'fn', input: { n: 8 } }] },
    mk(8, `${uniquePrefix}-8`),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu5', name: 'Read', input: { file_path: '/big.txt' } }] },
    mk(5, dup),
    { role: 'assistant', content: 'done' },
  ];
}

test('AC1: 200K request with heavy duplicate tool_results is deduped + forwarded (never 413)', () => {
  const dup = 'D'.repeat(200000); // ~200K chars of duplicate payload
  const messages = bigDuplicateTranscript(dup, 'unique');
  const result = compress({ messages });
  assert.ok(result.body && Array.isArray(result.messages));
  // Older duplicate (idx2) collapsed to a stub; newest (idx10) intact.
  assert.match(result.messages[2].content[0].content, /^\[miser: identical to turn 10\]$/);
  assert.equal(result.messages[10].content[0].content, dup);
  assert.ok(result.tokens < result.rawTokens);
  assert.ok(validateMessageIntegrity(result.messages).valid);
});

// ===========================================================================
// AC2 — No-truncation ⇒ no brick.
// ===========================================================================
test('AC2: no-truncation ⇒ no brick — a large body forwards with messages[0] unchanged', () => {
  const long = 'y'.repeat(5000);
  const messages = [
    { role: 'user', content: 'FIRST TASK unique handoff' },
    ...Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? 'assistant' : 'user',
      content: `turn-${i} ${long}`,
    })),
  ];
  const result = compress({ messages });
  assert.equal(result.messages.length, 31); // nothing dropped
  assert.equal(result.messages[0].content, 'FIRST TASK unique handoff');
});

test('AC2: client-illegal opener (directive-only block at index 0) is forwarded AS-IS', () => {
  const messages = [
    { role: 'user', content: [] },
    { role: 'assistant', content: 'hi' },
  ];
  const result = compress({ messages });
  assert.deepEqual(result.messages[0].content, []);
  assert.equal(result.messages.length, 2);
});

test('AC2: role:system hoist that EXPOSES an illegal opener still forwards as-is (no repair)', () => {
  const messages = [
    { role: 'system', content: 'directives' },
    { role: 'user', content: [] },
    { role: 'assistant', content: 'ok' },
  ];
  const result = compress({ messages });
  assert.equal(result.body.system, 'directives');
  assert.deepEqual(result.messages[0].content, []); // forwarded as-is, not dropped
  assert.equal(result.messages.length, 2);
});

// AC2 — replay the ACTUAL directive-block brick class. In the live v1 path, a
// >32K transcript was truncated down to MIN_KEEP recent turns; that shift could
// leave an Anthropic directive-only block (content:[] with output_config) at the
// NEW messages[0] → "400 messages.0: use the top-level 'system' parameter…". A
// legal user turn opens THIS body, but a directive block sits at a middle index.
// v2 does NO truncation, so the directive block never migrates to index 0 and the
// forwarded messages[0] stays a legal, non-empty user turn.
test('AC2: directive-block brick class — no truncation keeps a legal messages[0] (directive stays mid-transcript)', () => {
  const big = 'w'.repeat(6000); // each turn ~1.5K tokens → 30 turns ≫ 32K
  const directiveBlock = { role: 'user', content: [], output_config: { type: 'directive' } };
  const messages = [
    { role: 'user', content: `LEGAL OPENER handoff ${big}` }, // real, non-empty opener
    ...Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'assistant' : 'user',
      content: `turn-${i} ${big}`,
    })),
    directiveBlock, // an Anthropic directive block sitting mid/late in the transcript
    { role: 'assistant', content: 'tail' },
  ];
  const result = compress({ messages });
  // Nothing dropped: the legal opener is still messages[0], NOT the directive block.
  assert.equal(result.messages.length, messages.length);
  assert.equal(result.messages[0].content, `LEGAL OPENER handoff ${big}`);
  assert.ok(typeof result.messages[0].content === 'string' && result.messages[0].content.length > 0);
  // The directive block was neither dropped nor relocated to index 0 — it stays put.
  const directiveIdx = result.messages.findIndex(m => Array.isArray(m.content) && m.content.length === 0);
  assert.ok(directiveIdx > 0, 'directive-only block must NOT be forwarded at messages[0]');
});

test('AC2: orphan tool_result at index 0 forwarded as-is (miser emits no rejection)', () => {
  const messages = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'never_paired', content: 'x' }] },
    { role: 'assistant', content: 'reply' },
  ];
  const result = compress({ messages });
  assert.equal(result.messages[0].content[0].tool_use_id, 'never_paired');
  assert.equal(result.messages[0].content[0].content, 'x');
});

test('AC2: empty messages[] forwarded as-is', () => {
  const result = compress({ messages: [] });
  assert.deepEqual(result.messages, []);
});

test('AC2: all-assistant messages forwarded as-is', () => {
  const messages = [
    { role: 'assistant', content: 'a1' },
    { role: 'assistant', content: 'a2' },
  ];
  const result = compress({ messages });
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].content, 'a1');
});

// ===========================================================================
// AC3 — Losslessness (tool_result only).
// ===========================================================================
function transcriptTwoResults(read1, res2, read5, res10) {
  const mk = (id, extra) => ({ type: 'tool_result', tool_use_id: id, ...extra });
  return [
    { role: 'user', content: 'FIRST TASK' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: read1.name, input: read1.input }] },
    { role: 'user', content: [mk('tu1', res2)] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'fn', input: { n: 2 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'unique-4' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu3', name: 'fn', input: { n: 3 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu3', content: 'unique-6' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu4', name: 'fn', input: { n: 4 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu4', content: 'unique-8' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu5', name: read5.name, input: read5.input }] },
    { role: 'user', content: [mk('tu5', res10)] },
    { role: 'assistant', content: 'done' },
  ];
}

test('AC3: Read(f)=A … Edit … Read(f)=B keeps BOTH (different content, same file)', () => {
  const messages = transcriptTwoResults(
    { name: 'Read', input: { file_path: '/a.js' } }, { content: 'OLD contents of a.js' },
    { name: 'Read', input: { file_path: '/a.js' } }, { content: 'NEW contents of a.js' },
  );
  const result = compress({ messages });
  assert.equal(result.messages[2].content[0].content, 'OLD contents of a.js');
  assert.equal(result.messages[10].content[0].content, 'NEW contents of a.js');
  assert.ok(validateMessageIntegrity(result.messages).valid);
});

test('AC3: Read(f)=A … Read(f)=A stubs the older, newest authoritative & reconstructable', () => {
  const same = 'byte-identical contents of a.js';
  const messages = transcriptTwoResults(
    { name: 'Read', input: { file_path: '/a.js' } }, { content: same },
    { name: 'Read', input: { file_path: '/a.js' } }, { content: same },
  );
  const result = compress({ messages });
  assert.match(result.messages[2].content[0].content, /^\[miser: identical to turn 10\]$/);
  assert.equal(result.messages[2].content[0].tool_use_id, 'tu1');
  assert.equal(result.messages[10].content[0].content, same); // reconstruct target
});

test('AC3: identical bytes from DIFFERENT tools/files → BOTH kept (paired identity)', () => {
  const same = 'coincidentally identical bytes';
  const messages = transcriptTwoResults(
    { name: 'Read', input: { file_path: '/a.js' } }, { content: same },
    { name: 'Read', input: { file_path: '/b.js' } }, { content: same },
  );
  const result = compress({ messages });
  assert.equal(result.messages[2].content[0].content, same);
  assert.equal(result.messages[10].content[0].content, same);
});

test('AC3: identical text with OPPOSITE is_error → BOTH kept', () => {
  const messages = transcriptTwoResults(
    { name: 'Bash', input: { cmd: 'x' } }, { content: 'ambiguous stdout', is_error: true },
    { name: 'Bash', input: { cmd: 'x' } }, { content: 'ambiguous stdout', is_error: false },
  );
  const result = compress({ messages });
  assert.equal(result.messages[2].content[0].is_error, true);
  assert.equal(result.messages[2].content[0].content, 'ambiguous stdout');
  assert.equal(result.messages[10].content[0].is_error, false);
  assert.equal(result.messages[10].content[0].content, 'ambiguous stdout');
});

test('AC3: same content AND same is_error collapses, preserving is_error on the stub', () => {
  const messages = transcriptTwoResults(
    { name: 'Bash', input: { cmd: 'x' } }, { content: 'same failing output', is_error: true },
    { name: 'Bash', input: { cmd: 'x' } }, { content: 'same failing output', is_error: true },
  );
  const result = compress({ messages });
  assert.match(result.messages[2].content[0].content, /^\[miser: identical to turn 10\]$/);
  assert.equal(result.messages[2].content[0].is_error, true);
  assert.equal(result.messages[10].content[0].content, 'same failing output');
});

test('AC3: image/document blocks are NEVER touched (out of scope)', () => {
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const messages = [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'shot', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [img] }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'fn', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'u' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'fn', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'v' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't4', name: 'fn', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't4', content: 'w' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't5', name: 'shot', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't5', content: [img] }] },
    { role: 'assistant', content: 'done' },
  ];
  const result = compress({ messages });
  // v2 only collapses by replacing content with a STRING stub; an array-of-image
  // content is preserved byte-for-byte (image dedup out of scope).
  assert.deepEqual(result.messages[2].content[0].content, [img]);
  assert.deepEqual(result.messages[10].content[0].content, [img]);
});

// ===========================================================================
// AC4 — Preserve-set content unchanged (cache-hint off vs on).
// ===========================================================================
test('AC4: cacheHint=off → byte-identical system + preserve set', () => {
  const body = {
    system: 'Top-level system prompt.',
    messages: [
      { role: 'user', content: 'FIRST TASK' },
      { role: 'assistant', content: 'reply' },
    ],
  };
  const result = compress(body, { cacheHint: false });
  assert.equal(result.body.system, 'Top-level system prompt.');
  assert.equal(result.messages[0].content, 'FIRST TASK');
});

test('AC4: cacheHint=on → system TEXT byte-identical, only cache_control added', () => {
  const body = {
    system: 'Top-level system prompt.',
    messages: Array.from({ length: MIN_KEEP + 2 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${i}`,
    })),
  };
  const result = compress(body, { cacheHint: true });
  assert.ok(Array.isArray(result.body.system));
  assert.equal(result.body.system.length, 1);
  assert.equal(result.body.system[0].text, 'Top-level system prompt.');
  assert.deepEqual(result.body.system[0].cache_control, { type: 'ephemeral' });
});

test('AC4: cache-hint SKIPPED when no system (no tools/user placement)', () => {
  const body = {
    messages: Array.from({ length: MIN_KEEP + 2 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${i}`,
    })),
  };
  const result = compress(body, { cacheHint: true });
  assert.ok(!('system' in result.body) || result.body.system == null);
});

test('AC4: cache-hint NOT inserted when the client already sent a breakpoint (≤1 breakpoint)', () => {
  const body = {
    system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    messages: Array.from({ length: MIN_KEEP + 2 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${i}`,
    })),
  };
  const result = compress(body, { cacheHint: true });
  const bps = result.body.system.filter(b => b && b.cache_control).length;
  assert.equal(bps, 1);
});

test('AC4: cache-hint NOT inserted for a short conversation (≤ MIN_KEEP turns)', () => {
  const body = {
    system: 'sys',
    messages: [{ role: 'user', content: 'FIRST TASK' }, { role: 'assistant', content: 'ok' }],
  };
  const result = compress(body, { cacheHint: true });
  assert.equal(result.body.system, 'sys');
});

// MF2 regression guard: a client breakpoint on tools[] must suppress insertion
// (§3.4 "insert iff zero client breakpoints"). Before the fix, bodyHasCacheControl
// ignored tools[] → a SECOND breakpoint landed on system.
test('AC4: cache-hint NOT inserted when the client breakpoint is on tools[] (MF2)', () => {
  const body = {
    system: 'Top-level system prompt.',
    tools: [
      { name: 'Read', description: 'read a file', input_schema: { type: 'object' } },
      { name: 'Write', description: 'write a file', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } },
    ],
    messages: Array.from({ length: MIN_KEEP + 2 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${i}`,
    })),
  };
  const result = compress(body, { cacheHint: true });
  // system stays a plain string (no marker inserted) — the tools[] breakpoint is
  // the client's single breakpoint and must not be duplicated.
  assert.equal(result.body.system, 'Top-level system prompt.');
  // Total client breakpoints across the body is exactly 1 (the tools one).
  const toolBps = result.body.tools.filter(t => t && t.cache_control).length;
  const sysBps = Array.isArray(result.body.system)
    ? result.body.system.filter(b => b && b.cache_control).length : 0;
  assert.equal(toolBps + sysBps, 1);
});

// MF1 regression guard: hoisting a role:system message when top-level system is a
// block array carrying a client cache_control breakpoint must PRESERVE that
// breakpoint (I5 / §3.4 default OFF: never remove a client cache_control marker).
test('AC4: system-hoist preserves a client cache_control breakpoint on block-array system (MF1, cacheHint off)', () => {
  const body = {
    system: [
      { type: 'text', text: 'Stable boot prefix.', cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      { role: 'system', content: 'Hoisted directive block.' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'ok' },
    ],
  };
  const result = compress(body, { cacheHint: false });
  // system remains a block array (not flattened to a string).
  assert.ok(Array.isArray(result.body.system));
  // The client breakpoint survives on the original block.
  assert.deepEqual(result.body.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(result.body.system[0].text, 'Stable boot prefix.');
  // The hoisted role:system text is APPENDED as an additional text block.
  const texts = result.body.system.map(b => b.text);
  assert.ok(texts.includes('Hoisted directive block.'));
  // role:system was stripped from messages[].
  assert.ok(!result.messages.some(m => m.role === 'system'));
});

// ---------------------------------------------------------------------------
// MF1 residual (round-2): a client cache_control breakpoint on a HOISTED
// `role:system` message's OWN content blocks must survive the hoist EXACTLY. The
// round-1 fix only preserved breakpoints on the TOP-LEVEL block-array `system`;
// a role:system content-block breakpoint was flattened away via text extraction.
// Each of the four cases below FAILS if the fix is reverted (the string/flatten
// path drops the role:system breakpoint).
// ---------------------------------------------------------------------------

// Case 1: NO top-level system + role:system content is a block array with a
// cache_control breakpoint → top-level system MUST become a BLOCK ARRAY keeping
// that cache_control block (NOT a flattened string).
test('MF1: no top-level system + role:system block with cache_control → block-array system preserves BP (cacheHint off)', () => {
  const body = {
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'Boot', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'ok' },
    ],
  };
  const result = compress(body, { cacheHint: false });
  assert.ok(Array.isArray(result.body.system), 'system must be a block array, not a flattened string');
  const bps = result.body.system.filter(b => b && b.cache_control).length;
  assert.equal(bps, 1);
  const bootBlock = result.body.system.find(b => b.text === 'Boot');
  assert.ok(bootBlock, 'the Boot block must survive');
  assert.deepEqual(bootBlock.cache_control, { type: 'ephemeral' });
  assert.ok(!result.messages.some(m => m.role === 'system'));
});

// Case 2: top-level STRING system + a structured role:system with a breakpoint →
// produce a BLOCK-ARRAY system that preserves the role:system breakpoint (must NOT
// string-merge it away).
test('MF1: string top-level system + structured role:system BP → block-array system preserves the role:system BP', () => {
  const body = {
    system: 'Plain top-level prompt.',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'Hoisted', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: 'go' },
    ],
  };
  const result = compress(body, { cacheHint: false });
  assert.ok(Array.isArray(result.body.system), 'system must be a block array (not string-merged)');
  // Top-level string is preserved as a text block, in order, first.
  const texts = result.body.system.map(b => b.text);
  assert.deepEqual(texts, ['Plain top-level prompt.', 'Hoisted']);
  const hoisted = result.body.system.find(b => b.text === 'Hoisted');
  assert.deepEqual(hoisted.cache_control, { type: 'ephemeral' });
  assert.equal(result.body.system.filter(b => b && b.cache_control).length, 1);
});

// Case 3: top-level block-array WITH cache_control + structured role:system with
// its OWN breakpoint → keep BOTH breakpoints as blocks.
test('MF1: block-array top-level BP + structured role:system BP → BOTH breakpoints preserved as blocks', () => {
  const body = {
    system: [{ type: 'text', text: 'Stable prefix', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'Hoisted directive', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: 'go' },
    ],
  };
  const result = compress(body, { cacheHint: false });
  assert.ok(Array.isArray(result.body.system));
  assert.equal(result.body.system.filter(b => b && b.cache_control).length, 2, 'BOTH client breakpoints must survive');
  const prefix = result.body.system.find(b => b.text === 'Stable prefix');
  const directive = result.body.system.find(b => b.text === 'Hoisted directive');
  assert.deepEqual(prefix.cache_control, { type: 'ephemeral' });
  assert.deepEqual(directive.cache_control, { type: 'ephemeral' });
});

// Case 4: top-level block-array WITHOUT cache_control + structured role:system
// WITH a breakpoint → must NOT fall into the string-merge path; the role:system
// breakpoint is preserved as a block.
test('MF1: block-array top-level (no BP) + structured role:system BP → NOT string-merged; role:system BP preserved', () => {
  const body = {
    system: [{ type: 'text', text: 'Prefix without BP' }],
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'Hoisted', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: 'go' },
    ],
  };
  const result = compress(body, { cacheHint: false });
  assert.ok(Array.isArray(result.body.system), 'must not flatten to a string — that would drop the role:system BP');
  const hoisted = result.body.system.find(b => b.text === 'Hoisted');
  assert.ok(hoisted, 'the hoisted block must survive');
  assert.deepEqual(hoisted.cache_control, { type: 'ephemeral' });
  assert.equal(result.body.system.filter(b => b && b.cache_control).length, 1);
});

// §3.4 opt-in interaction: with cacheHint ON, a preserved role:system breakpoint
// (now living in top-level `system` blocks) must be SEEN by bodyHasCacheControl so
// miser does NOT insert a duplicate breakpoint.
test('MF1 + §3.4: cacheHint ON does not insert a duplicate BP when role:system already carried one', () => {
  // The client breakpoint sits on the FIRST of two role:system blocks (not the
  // last). If the fix were reverted, the role:system BP would be destroyed on
  // hoist, bodyHasCacheControl would see none, and applyCacheHint would insert a
  // NEW breakpoint on the LAST system block — landing the BP on 'Tail', not 'Boot'.
  // The fix instead preserves the ORIGINAL breakpoint on 'Boot' and inserts none.
  const body = {
    messages: [
      { role: 'system', content: [
        { type: 'text', text: 'Boot', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Tail' },
      ] },
      ...Array.from({ length: MIN_KEEP + 2 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `turn-${i}`,
      })),
    ],
  };
  const result = compress(body, { cacheHint: true });
  assert.ok(Array.isArray(result.body.system));
  // Exactly ONE breakpoint total — the client's own, not a miser-inserted second.
  assert.equal(result.body.system.filter(b => b && b.cache_control).length, 1);
  // The surviving breakpoint is on the ORIGINAL 'Boot' block — proving it was
  // preserved, not destroyed-then-reinserted onto the last ('Tail') block.
  const boot = result.body.system.find(b => b.text === 'Boot');
  const tail = result.body.system.find(b => b.text === 'Tail');
  assert.deepEqual(boot.cache_control, { type: 'ephemeral' });
  assert.ok(!(tail && tail.cache_control), 'BP must NOT have been (re)inserted on the last block');
});

// ===========================================================================
// AC5 — miser-introduced adjacency safety (revert dedup) + no synthetic reject.
// ===========================================================================
test('AC5: client OWN malformed pairing forwarded as-is (no miser_integrity_error)', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'fn', input: {} }] },
    { role: 'assistant', content: 'interjection breaking adjacency' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
  ];
  const result = compress({ messages });
  assert.equal(result.messages.length, 3);
  assert.ok(!('error' in result));
});

test('AC5: validateMessageIntegrity (internal) rejects a non-adjacent pair', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'fn', input: {} }] },
    { role: 'assistant', content: 'interjection' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
  ];
  const r = validateMessageIntegrity(messages);
  assert.equal(r.valid, false);
  assert.match(r.error, /preceding/);
});

test('AC5: validateMessageIntegrity rejects an unanswered tool_use', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'fn', input: {} }] },
    { role: 'user', content: 'plain reply, no tool_result' },
  ];
  const r = validateMessageIntegrity(messages);
  assert.equal(r.valid, false);
  assert.match(r.error, /following/);
});

// LOAD-BEARING revert proof. The real dedupMiddle preserves tool_use_id, so it
// can never break adjacency — leaving the §3.5 revert branch untested. We inject
// a dedup that DELIBERATELY corrupts a tool_result's tool_use_id (breaking
// adjacency) and assert compress() detects the integrity failure and REVERTS to
// the §3.1-normalized (pre-dedup) messages. If the `validateMessageIntegrity(work)`
// / revert block is removed, compress() would forward the corrupted messages and
// this test FAILS (adjacency broken + wrong tool_use_id surfaced).
test('AC5: compress() reverts dedup when miser\'s OWN dedup would break adjacency', () => {
  const messages = [
    { role: 'user', content: 'FIRST TASK' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'fn', input: { n: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'r1' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'fn', input: { n: 2 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'r2' }] },
  ];
  // Injected adjacency-breaking "dedup": rewrite an outside-tail tool_result's
  // tool_use_id so it no longer pairs with the preceding assistant tool_use.
  const breakingDedup = (work) => {
    for (const m of work) {
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      m.content = m.content.map(b =>
        (b && b.type === 'tool_result') ? { ...b, tool_use_id: 'CORRUPTED', content: 'STUBBED' } : b);
    }
  };
  // The dedup impl is injected via the module-private test-only seam (NOT via the
  // public compress(body, opts) API — production callers can't reach it). Always
  // reset in finally so the override never leaks into another test.
  let result;
  __test.setDedupImpl(breakingDedup);
  try {
    result = compress({ messages });
  } finally {
    __test.setDedupImpl(null);
  }
  // Reverted: the forwarded messages are the pre-dedup normalized set, NOT the
  // corrupted ones. Original tool_use_ids + content survive; adjacency holds.
  assert.equal(result.messages[2].content[0].tool_use_id, 'tu1');
  assert.equal(result.messages[2].content[0].content, 'r1');
  assert.equal(result.messages[4].content[0].tool_use_id, 'tu2');
  assert.equal(result.messages[4].content[0].content, 'r2');
  assert.ok(validateMessageIntegrity(result.messages).valid);
  // Guard: prove the injected dedup really WOULD have broken adjacency (so the
  // test is meaningful — it forces the revert branch, not a no-op).
  const corrupted = messages.map(m => ({ ...m }));
  breakingDedup(corrupted);
  assert.equal(validateMessageIntegrity(corrupted).valid, false);
});

// ===========================================================================
// AC6 — No ceiling: a 100K zero-duplicate request forwards unchanged.
// ===========================================================================
test('AC6: 100K zero-duplicate request forwards unchanged (minus normalization)', () => {
  const chunk = 'z'.repeat(6000);
  const messages = Array.from({ length: 18 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `unique-${i} ${chunk}`,
  }));
  const result = compress({ messages });
  assert.equal(result.messages.length, 18);
  assert.equal(result.tokens, result.rawTokens);
  for (let i = 0; i < 18; i++) {
    assert.equal(result.messages[i].content, `unique-${i} ${chunk}`);
  }
});

// A hard load-bearing guard against a REINTRODUCED hard-coded ceiling. The prior
// AC6 fixture (~27K estimated tokens) would survive a hidden 32K gate, so it is
// not a real no-ceiling proof. This fixture estimates to WELL OVER 200K tokens
// (32 turns × ~32K chars ≈ 1M chars ≈ ~256K tokens) with ZERO duplicate
// tool_results, so nothing can be deduped: if ANY ceiling (32K, 100K, 200K…) were
// reintroduced, the forwarded body would be shorter than the input and this fails.
test('AC6: a >200K-token zero-duplicate request forwards byte-for-byte (no reintroduced ceiling)', () => {
  const chunk = 'q'.repeat(32000);
  const messages = Array.from({ length: 32 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `unique-${i} ${chunk}`,
  }));
  const result = compress({ messages });
  assert.ok(result.rawTokens > 200000, `fixture must exceed any plausible ceiling (got ${result.rawTokens} est tokens)`);
  assert.equal(result.messages.length, 32);       // nothing dropped by a ceiling
  assert.equal(result.tokens, result.rawTokens);  // nothing reduced at all
  for (let i = 0; i < 32; i++) {
    assert.equal(result.messages[i].content, `unique-${i} ${chunk}`); // byte-for-byte
  }
});

// ===========================================================================
// AC8 — reduced-body contract: hoisted system rides on body.
// ===========================================================================
test('AC8: role:system hoist puts top-level system on the FORWARDED body', () => {
  const body = {
    model: 'claude',
    messages: [
      { role: 'system', content: 'You are Claude Code.' },
      { role: 'user', content: 'hi' },
    ],
  };
  const result = compress(body);
  assert.equal(result.body.system, 'You are Claude Code.');
  assert.ok(!result.body.messages.some(m => m.role === 'system'));
  assert.equal(result.body.messages, result.messages);
});

// ===========================================================================
// AC10 — deploy-reaches-prod canary shape (compress half).
// ===========================================================================
test('AC10: middle duplicate tool_result (locatable pair, outside preserve set) → stub forwarded', () => {
  const dup = 'CANARY-DUP-' + 'q'.repeat(500);
  const mk = (id, content) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] });
  const messages = [
    { role: 'user', content: 'FIRST TASK' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'Read', input: { file_path: '/c' } }] },
    mk('a1', dup),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a2', name: 'fn', input: { n: 2 } }] },
    mk('a2', 'u2'),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a3', name: 'fn', input: { n: 3 } }] },
    mk('a3', 'u3'),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a4', name: 'fn', input: { n: 4 } }] },
    mk('a4', 'u4'),
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a5', name: 'Read', input: { file_path: '/c' } }] },
    mk('a5', dup),
    { role: 'assistant', content: 'done' },
  ];
  const result = compress({ messages });
  assert.equal(result.messages.length, 12);
  assert.match(result.messages[2].content[0].content, /^\[miser: identical to turn 10\]$/);
  assert.equal(result.messages[10].content[0].content, dup);
});

// ===========================================================================
// §8.6 — grep-guard: NO primary code path reads/branches on a compression
// threshold, and no config key named compressionThreshold exists.
// ===========================================================================
test('§8.6 grep-guard: no primary source branches on a compression threshold', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const primaryFiles = ['compress.js', 'proxy.js', 'config.js', 'index.js', 'router.js'];
  for (const f of primaryFiles) {
    const txt = fs.readFileSync(path.join(srcDir, f), 'utf8');
    assert.ok(!/compressionThreshold/.test(txt), `${f} must not reference compressionThreshold`);
    assert.ok(!/MISER_COMPRESSION_THRESHOLD/.test(txt), `${f} must not read MISER_COMPRESSION_THRESHOLD`);
  }
  delete require.cache[require.resolve('../src/config.js')];
  const cfg = require('../src/config.js');
  assert.ok(!('compressionThreshold' in cfg), 'config exports no compressionThreshold');
});

test('§8.6 behavioral: a 100K request forwards unchanged regardless of any (absent) threshold env', () => {
  const prev = process.env.MISER_COMPRESSION_THRESHOLD;
  process.env.MISER_COMPRESSION_THRESHOLD = '1'; // even a hostile tiny value must not gate
  try {
    const chunk = 'k'.repeat(6000);
    const messages = Array.from({ length: 18 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `unique-${i} ${chunk}`,
    }));
    const result = compress({ messages });
    assert.equal(result.messages.length, 18);
    assert.equal(result.tokens, result.rawTokens);
  } finally {
    if (prev === undefined) delete process.env.MISER_COMPRESSION_THRESHOLD;
    else process.env.MISER_COMPRESSION_THRESHOLD = prev;
  }
});

// keep messageTokens exported-symbol used (avoid unused-import lints in strict tools)
test('messageTokens counts content + turn overhead', () => {
  assert.ok(messageTokens({ role: 'user', content: 'abcd' }) >= 4);
});
