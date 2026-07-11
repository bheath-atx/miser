'use strict';

// Rough token estimate: ~4 chars per token (GPT-style approximation).
// Good enough for threshold decisions without pulling in tiktoken.
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function messageTokens(msg) {
  const content = typeof msg.content === 'string'
    ? msg.content
    : msg.content.map(b => b.text || JSON.stringify(b)).join('');
  return estimateTokens(content) + 4; // 4-token overhead per message turn
}

function systemToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map(b => b.text || '').filter(Boolean).join('\n');
}

function messageSystemText(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map(b => b.text || '').filter(Boolean).join('\n');
  }
  return '';
}

// Hoist role:system messages into top-level `system` and strip them from messages[].
// Anthropic rejects system prompts in messages — they must use the top-level field.
function normalizeAnthropicBody(body, messages) {
  const out = { ...body };
  const systemMsgs = messages.filter(m => m.role === 'system');
  const cleanMessages = messages.filter(m => m.role !== 'system');

  if (systemMsgs.length === 0) {
    return { body: out, messages: cleanMessages };
  }

  let system = out.system;
  for (const msg of systemMsgs) {
    const text = messageSystemText(msg);
    if (!text) continue;
    system = system ? `${systemToText(system)}\n${text}` : text;
  }
  if (system) {
    out.system = system;
  } else {
    delete out.system;
  }

  return { body: out, messages: cleanMessages };
}

// --- compression internals --------------------------------------------------

function cloneMsg(msg) {
  // Shallow clone; dedup replaces `.content` with a fresh array so the caller's
  // original message objects are never mutated.
  return { ...msg };
}

function contentBlocks(msg) {
  return Array.isArray(msg.content) ? msg.content : [];
}

// Dedup key for a tool_result block: the ENTIRE block EXCEPT `tool_use_id`.
//
// `tool_use_id` is only the pairing pointer and legitimately varies between two
// otherwise-identical results, so it is excluded. EVERY other field is semantic
// and must participate in identity — content, but also `is_error`, `cache_control`,
// etc. Keying on content alone would let two results with identical text but
// opposite `is_error` (e.g. a command that failed, then later succeeded with the
// same stdout) collapse, silently erasing the error state. Keying on the whole
// block minus the id is provably lossless: blocks collapse ONLY if every semantic
// field is identical. (A differing field → different key → both preserved; a
// false-distinct is harmless, a false-identical is now impossible.)
function dedupKey(block) {
  const { tool_use_id, ...semantic } = block; // exclude ONLY the pairing id
  return `tr:${JSON.stringify(semantic)}`;
}

// Lossless middle dedup. Walks newest -> oldest so the FIRST occurrence recorded
// for any key is the newest copy; older identical copies are replaced with a
// compact stub that PRESERVES `tool_use_id` (so pairing/adjacency is untouched).
// The first task turn and the recent tail are never rewritten. Returns the count
// of blocks stubbed.
function dedupMiddle(messages, firstTaskIdx, tailStart) {
  const seen = new Map(); // key -> index of newest occurrence
  let deduped = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];

    // Tail: authoritative newest copies. Record keys, never rewrite.
    if (i >= tailStart) {
      for (const b of contentBlocks(m)) {
        if (b && b.type === 'tool_result') {
          const k = dedupKey(b);
          if (!seen.has(k)) seen.set(k, i);
        }
      }
      continue;
    }

    // First task/handoff turn is part of the preserve set — never touch it.
    if (i === firstTaskIdx) continue;
    if (!Array.isArray(m.content)) continue;

    m.content = m.content.map(b => {
      // Only tool_result blocks are dedup candidates. Text blocks (which may
      // carry unique user instructions or distinct assistant reasoning) are
      // NEVER collapsed.
      if (!b || b.type !== 'tool_result') return b;
      const k = dedupKey(b);
      if (seen.has(k)) {
        deduped++;
        // Preserve every semantic field (is_error, cache_control, ...) and the
        // pairing id; replace only the bulky content with the stub marker.
        return { ...b, content: `[miser: deduped, identical to turn ${seen.get(k)}]` };
      }
      seen.set(k, i);
      return b;
    });
  }

  return deduped;
}

// Turn-preserving, lossless compressor.
//
// Root cause it fixes: the previous implementation blind-truncated the oldest
// messages, silently dropping the first task/handoff turn (a lane once booted
// with "no command"). This version NEVER drops the preserve set:
//   - top-level `system`,
//   - the first non-system user turn (the task/handoff),
//   - the recent tail (MIN_KEEP, floor raised 4 -> 8).
// The middle is compressed ONLY by lossless dedup of duplicate tool_results and
// repeated same-file re-reads. If that still leaves the context over threshold,
// we surface pressure (`overflow`) instead of silently discarding context —
// letting the proxy return a 413-class response so Claude Code's native
// compaction can fire.
//
// Returns { messages, tokens, rawTokens, overflow, reason }.
function compress(body, threshold) {
  const messages = body.messages || [];
  const systemTokens = estimateTokens(systemToText(body.system));

  const rawTokens = systemTokens + messages.reduce((sum, m) => sum + messageTokens(m), 0);

  if (rawTokens <= threshold) {
    return { messages, tokens: rawTokens, rawTokens, overflow: false };
  }

  const MIN_KEEP = Math.min(8, messages.length);
  const tailStart = messages.length - MIN_KEEP;
  const firstTaskIdx = messages.findIndex(m => m.role === 'user'); // -1 if none

  const work = messages.map(cloneMsg);
  dedupMiddle(work, firstTaskIdx, tailStart);

  // Adjacency safety: dedup must never break tool pairing. If it somehow did,
  // undo the compression entirely and surface the raw context.
  const integ = validateMessageIntegrity(work);
  if (!integ.valid) {
    console.warn(`[miser] compress: dedup rejected (${integ.error}); reverting to raw context`);
    return {
      messages,
      tokens: rawTokens,
      rawTokens,
      overflow: rawTokens > threshold,
      reason: `dedup would break tool pairing (${integ.error}); reverted to raw context`,
    };
  }

  const tokens = systemTokens + work.reduce((sum, m) => sum + messageTokens(m), 0);
  const overflow = tokens > threshold;
  const reason = overflow
    ? `preserve-set still ${tokens} tok after lossless dedup (threshold ${threshold}); `
      + `surfacing context pressure instead of silently truncating preserved turns`
    : undefined;

  return { messages: work, tokens, rawTokens, overflow, reason };
}

// Adjacency-correct integrity check. Returns { valid: true } or
// { valid: false, error: string }.
//
// Anthropic requires each `tool_result` to correspond to a `tool_use` in the
// IMMEDIATELY PRECEDING assistant turn, and each `tool_use` to be answered by a
// `tool_result` in the IMMEDIATELY FOLLOWING user turn. Merely having the id
// "present somewhere earlier" is not enough — a reordered/detached pair still
// 400s. We verify true adjacency in both directions.
function validateMessageIntegrity(messages) {
  // Every tool_result must be answered by the immediately-preceding assistant tool_use.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

    const results = msg.content.filter(b => b && b.type === 'tool_result');
    if (results.length === 0) continue;

    const prev = messages[i - 1];
    const prevUseIds = new Set();
    if (prev && prev.role === 'assistant' && Array.isArray(prev.content)) {
      for (const b of prev.content) {
        if (b && b.type === 'tool_use') prevUseIds.add(b.id);
      }
    }

    for (const r of results) {
      if (!prevUseIds.has(r.tool_use_id)) {
        return {
          valid: false,
          error: `orphaned or misordered tool_result: tool_use_id ${r.tool_use_id} has no `
            + `corresponding tool_use in the immediately preceding assistant turn`,
        };
      }
    }
  }

  // Every tool_use must be answered by the immediately-following user tool_result.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    const uses = msg.content.filter(b => b && b.type === 'tool_use');
    if (uses.length === 0) continue;

    const next = messages[i + 1];
    const nextResultIds = new Set();
    if (next && next.role === 'user' && Array.isArray(next.content)) {
      for (const b of next.content) {
        if (b && b.type === 'tool_result') nextResultIds.add(b.tool_use_id);
      }
    }

    for (const u of uses) {
      if (!nextResultIds.has(u.id)) {
        return {
          valid: false,
          error: `unanswered tool_use: id ${u.id} has no corresponding tool_result in the `
            + `immediately following user turn`,
        };
      }
    }
  }

  return { valid: true };
}

module.exports = {
  compress,
  estimateTokens,
  messageTokens,
  validateMessageIntegrity,
  normalizeAnthropicBody,
};
