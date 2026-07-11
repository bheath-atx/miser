'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  compress,
  estimateTokens,
  messageTokens,
  validateMessageIntegrity,
  normalizeAnthropicBody,
} = require('../src/compress.js');

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

// REDESIGN: the old contract here was "blind-truncate oldest messages when over
// threshold" — that is exactly the root-cause bug (it silently dropped the first
// task/handoff turn). The new contract never blind-drops preserved turns; when
// there is nothing losslessly dedupable it surfaces pressure instead.
test('compress does NOT blind-truncate; surfaces overflow when nothing is dedupable', () => {
  const long = 'x'.repeat(1000);
  const messages = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `turn-${i} ${long}`, // each turn unique text -> nothing to dedup
  }));
  const result = compress({ messages }, 500);
  // No message is silently dropped — every turn is preserved verbatim.
  assert.equal(result.messages.length, 20);
  assert.equal(result.messages[0].content, `turn-0 ${long}`);
  // Instead of masking, it reports context pressure for the proxy to surface.
  assert.equal(result.overflow, true);
  assert.ok(result.reason && /threshold/.test(result.reason));
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

test('normalizeAnthropicBody hoists leading role:system into top-level system', () => {
  const body = { model: 'claude-sonnet-4-20250514', max_tokens: 4096 };
  const messages = [
    { role: 'system', content: 'You are Claude Code.' },
    { role: 'user', content: 'hello' },
  ];
  const { body: out, messages: clean } = normalizeAnthropicBody(body, messages);
  assert.equal(out.system, 'You are Claude Code.');
  assert.equal(clean.length, 1);
  assert.equal(clean[0].role, 'user');
  assert.ok(!clean.some(m => m.role === 'system'));
});

test('normalizeAnthropicBody merges existing top-level system with role:system messages', () => {
  const body = { system: 'Base prompt.' };
  const messages = [
    { role: 'system', content: 'Patch block.' },
    { role: 'user', content: 'go' },
  ];
  const { body: out, messages: clean } = normalizeAnthropicBody(body, messages);
  assert.equal(out.system, 'Base prompt.\nPatch block.');
  assert.ok(!clean.some(m => m.role === 'system'));
});

test('normalizeAnthropicBody strips non-leading role:system messages', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'system', content: 'stray system turn' },
    { role: 'assistant', content: 'hello' },
  ];
  const { body: out, messages: clean } = normalizeAnthropicBody({}, messages);
  assert.equal(out.system, 'stray system turn');
  assert.deepEqual(clean.map(m => m.role), ['user', 'assistant']);
});

test('compression pipeline preserves top-level system and strips role:system over threshold', () => {
  const long = 'x'.repeat(4000);
  const body = {
    system: 'Top-level system prompt.',
    model: 'claude-sonnet-4-20250514',
    messages: [
      { role: 'system', content: 'Should not stay in messages.' },
      ...Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: long,
      })),
    ],
  };

  const { body: normalizedBody, messages: normalizedMessages } =
    normalizeAnthropicBody(body, body.messages);
  const pipelineBody = { ...normalizedBody, messages: normalizedMessages };
  const { messages: compressed } = compress(pipelineBody, 32000);

  const outgoing = { ...normalizedBody, messages: compressed };
  assert.equal(outgoing.system, 'Top-level system prompt.\nShould not stay in messages.');
  assert.ok(!outgoing.messages.some(m => m.role === 'system'));
  assert.ok(outgoing.messages.length < body.messages.length, 'compression should have dropped turns');
});

// --- REDESIGN: preserve-set + lossless dedup + fail-visible ------------------

// Build a valid alternating assistant(tool_use)/user(tool_result) transcript.
// idx0 is a unique first task turn; two tool_results (middle idx2 + tail idx10)
// share identical content so the older one is dedup-eligible.
function transcriptWithDuplicateResults(dupContent) {
  return [
    { role: 'user', content: 'FIRST TASK: unique handoff instruction that must survive' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'fn', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: dupContent }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'fn', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'unique-4' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu3', name: 'fn', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu3', content: 'unique-6' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu4', name: 'fn', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu4', content: 'unique-8' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu5', name: 'fn', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu5', content: dupContent }] },
    { role: 'assistant', content: 'done' },
  ];
}

test('BEHAVIOR 1: first task turn is NEVER dropped when over threshold', () => {
  const messages = transcriptWithDuplicateResults('D'.repeat(4000));
  const result = compress({ messages }, 1000);
  // The first non-system user turn (the handoff) survives byte-for-byte.
  assert.equal(result.messages[0].role, 'user');
  assert.equal(
    result.messages[0].content,
    'FIRST TASK: unique handoff instruction that must survive',
  );
  // And the compressed transcript is still tool-pair valid.
  assert.ok(validateMessageIntegrity(result.messages).valid);
});

test('BEHAVIOR 3: duplicate tool_results are losslessly deduped to newest copy', () => {
  const dup = 'D'.repeat(4000);
  const messages = transcriptWithDuplicateResults(dup);
  const result = compress({ messages }, 1000);

  // Older duplicate (middle) -> compact stub pointing at the newest copy.
  assert.equal(result.messages[2].content[0].type, 'tool_result');
  assert.equal(result.messages[2].content[0].tool_use_id, 'tu1'); // id preserved -> pairing intact
  assert.match(result.messages[2].content[0].content, /^\[miser: deduped, identical to turn 10\]$/);

  // Newest copy (tail) is untouched.
  assert.equal(result.messages[10].content[0].content, dup);

  // A genuinely-unique tool_result is NOT collapsed.
  assert.equal(result.messages[4].content[0].content, 'unique-4');

  // Dedup did not break integrity.
  assert.ok(validateMessageIntegrity(result.messages).valid);
});

test('BEHAVIOR 3b: same-path reads with DIFFERENT content are BOTH preserved (Read->Edit->Read)', () => {
  // Ubiquitous real pattern: read a file, edit it, read it again. The two reads
  // share a path but differ in bytes. Collapsing them on path alone would drop
  // the pre-edit snapshot = data loss. Dedup keys on EXACT content, so both survive.
  const messages = [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/a.js' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'OLD contents of a.js' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'x1', name: 'Read', input: { file_path: '/b.js' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x1', content: 'contents of b.js' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'y1', name: 'fn', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'y1', content: 'yyy' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'z1', name: 'fn', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'z1', content: 'zzz' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: '/a.js' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r2', content: 'NEW contents of a.js' }] },
    { role: 'assistant', content: 'done' },
  ];
  const result = compress({ messages }, 1);

  // Pre-edit read of /a.js (idx2) is preserved IN FULL — not stubbed.
  assert.equal(result.messages[2].content[0].content, 'OLD contents of a.js');
  // Post-edit read of /a.js (idx10) is also kept in full.
  assert.equal(result.messages[10].content[0].content, 'NEW contents of a.js');
  // A read of a DIFFERENT file (/b.js) is never collapsed.
  assert.equal(result.messages[4].content[0].content, 'contents of b.js');
  assert.ok(validateMessageIntegrity(result.messages).valid);
});

test('BEHAVIOR 3c: same-path reads with IDENTICAL content DO dedup to newest', () => {
  // Two reads of the same path returning byte-identical content ARE redundant,
  // so the older one collapses to a stub (tool_use_id preserved), newest kept.
  const same = 'byte-identical contents of a.js';
  const messages = [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/a.js' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: same }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'x1', name: 'Read', input: { file_path: '/b.js' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x1', content: 'contents of b.js' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'y1', name: 'fn', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'y1', content: 'yyy' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'z1', name: 'fn', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'z1', content: 'zzz' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: '/a.js' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r2', content: same }] },
    { role: 'assistant', content: 'done' },
  ];
  const result = compress({ messages }, 1);

  // Older identical read (idx2) -> stub, id preserved.
  assert.match(result.messages[2].content[0].content, /^\[miser: deduped, identical to turn 10\]$/);
  assert.equal(result.messages[2].content[0].tool_use_id, 'r1');
  // Newest copy kept in full.
  assert.equal(result.messages[10].content[0].content, same);
  // Different file untouched.
  assert.equal(result.messages[4].content[0].content, 'contents of b.js');
  assert.ok(validateMessageIntegrity(result.messages).valid);
});

// A 12-turn valid transcript whose idx2 (tu1) and idx10 (tu5) tool_results carry
// caller-supplied extra fields, so we can probe semantic identity beyond content.
function transcriptWithTwoResults(res2Extra, res10Extra) {
  const mk = (id, extra) => ({ type: 'tool_result', tool_use_id: id, ...extra });
  return [
    { role: 'user', content: 'FIRST TASK' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'fn', input: {} }] },
    { role: 'user', content: [mk('tu1', res2Extra)] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'fn', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'unique-4' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu3', name: 'fn', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu3', content: 'unique-6' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu4', name: 'fn', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu4', content: 'unique-8' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu5', name: 'fn', input: {} }] },
    { role: 'user', content: [mk('tu5', res10Extra)] },
    { role: 'assistant', content: 'done' },
  ];
}

test('BEHAVIOR 3d: same content but different is_error are BOTH preserved', () => {
  // A command that FAILED, then later SUCCEEDED with byte-identical stdout.
  // Content matches but is_error differs — the error state is semantic and must
  // not be erased by collapse.
  const messages = transcriptWithTwoResults(
    { content: 'ambiguous stdout', is_error: true },
    { content: 'ambiguous stdout', is_error: false },
  );
  const result = compress({ messages }, 1);

  // Neither is stubbed; both keep content AND their distinct is_error flag.
  assert.equal(result.messages[2].content[0].content, 'ambiguous stdout');
  assert.equal(result.messages[2].content[0].is_error, true);
  assert.equal(result.messages[10].content[0].content, 'ambiguous stdout');
  assert.equal(result.messages[10].content[0].is_error, false);
  assert.ok(validateMessageIntegrity(result.messages).valid);
});

test('BEHAVIOR 3e: same content AND same is_error collapses, preserving the flag on the stub', () => {
  const messages = transcriptWithTwoResults(
    { content: 'same failing output', is_error: true },
    { content: 'same failing output', is_error: true },
  );
  const result = compress({ messages }, 1);

  // Older copy (idx2) -> stub, but is_error and pairing id survive on the stub.
  assert.match(result.messages[2].content[0].content, /^\[miser: deduped, identical to turn 10\]$/);
  assert.equal(result.messages[2].content[0].tool_use_id, 'tu1');
  assert.equal(result.messages[2].content[0].is_error, true);
  // Newest copy kept in full.
  assert.equal(result.messages[10].content[0].content, 'same failing output');
  assert.equal(result.messages[10].content[0].is_error, true);
  assert.ok(validateMessageIntegrity(result.messages).valid);
});

test('BEHAVIOR 2: validateMessageIntegrity rejects a non-adjacent tool pair', () => {
  // tu1's tool_use exists, but an assistant text turn is interleaved between the
  // tool_use and its tool_result — the old "id present anywhere" check would pass
  // this; the adjacency-correct check must reject it.
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'fn', input: {} }] },
    { role: 'assistant', content: 'interjection breaking adjacency' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
  ];
  const result = validateMessageIntegrity(messages);
  assert.equal(result.valid, false);
  assert.ok(result.error.includes('tu1'));
  assert.match(result.error, /preceding/);
});

test('BEHAVIOR 2b: validateMessageIntegrity rejects an unanswered tool_use', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'fn', input: {} }] },
    { role: 'user', content: 'plain reply, no tool_result' },
  ];
  const result = validateMessageIntegrity(messages);
  assert.equal(result.valid, false);
  assert.ok(result.error.includes('tu1'));
  assert.match(result.error, /following/);
});

test('BEHAVIOR 4: fail-visible when preserve-set alone exceeds threshold', () => {
  // Every turn is a unique, non-dedupable text block, so lossless dedup cannot
  // get under threshold. Instead of silently truncating, compress() must flag
  // overflow and keep the preserve set (including the first task turn) intact.
  const long = 'y'.repeat(8000);
  const messages = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `unique-turn-${i} ${long}`,
  }));
  const result = compress({ messages }, 4000);
  assert.equal(result.overflow, true);
  assert.ok(result.reason && /threshold/.test(result.reason));
  // Nothing silently dropped; first task turn preserved verbatim.
  assert.equal(result.messages.length, 12);
  assert.equal(result.messages[0].content, `unique-turn-0 ${long}`);
});
