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
