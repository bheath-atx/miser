'use strict';

// miser compress() v2 — LOSSLESS redundancy removal, NOT truncation.
//
// The v1 implementation blind-truncated the oldest turns down to a 32K ceiling.
// That (a) could leave a directive-only block at messages[0] → Anthropic
// `400 messages.0` (the pkachu brick) and (b) silently discarded ~⅔ of an orch's
// working memory every turn while masking the pressure so the client's native
// compaction never fired.
//
// v2 removes ALL truncation and ALL size ceilings. Its ONLY reductions are:
//   1. hoist `role:system` messages into top-level `system` (§3.1),
//   2. losslessly dedup byte-identical `tool_result` blocks (§3.3),
//   3. (opt-in, default OFF) a single cache_control breakpoint on `system` (§3.4).
// After dedup it re-validates tool adjacency and reverts ONLY the dedup on
// failure (§3.5). It NEVER removes/reorders messages (beyond the system hoist),
// NEVER truncates, NEVER repairs a client-illegal opener, and emits NO synthetic
// client rejection. A client-illegal request is forwarded as-is so Anthropic's
// authoritative error reaches the client (I1–I7, §3.1a).
//
// Pipeline order is FIXED: §3.1 → §3.1a (no-op, by construction) → §3.3 dedup →
// §3.5 validate/revert → §3.4 cache-hint (LAST, so a revert can never drop it).
//
// compress() returns { body, messages, tokens, rawTokens } (I6): `body` is the
// REDUCED body (hoisted system, optional cache hint) that proxy.js forwards to
// EVERY leg — no leg rebuilds from originalBody.

const { systemToText } = require('./translate-openai.js');

// Recent-tail turns whose content is never rewritten (preserve set, §I5).
const MIN_KEEP = 8;

// --- token estimate (OBSERVABILITY ONLY, §3.2) ------------------------------
// Rough ~4-chars-per-token estimate. Drives x-miser-saved-tokens + an optional
// early-warning log ONLY. It is NEVER a gate: no primary path branches on it.
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function safeBlockText(b) {
  if (b == null) return '';
  if (typeof b === 'string') return b;
  if (typeof b.text === 'string') return b.text;
  try { return JSON.stringify(b); } catch (_) { return ''; } // e.g. circular refs
}

function messageTokens(msg) {
  const content = typeof msg.content === 'string'
    ? msg.content
    : Array.isArray(msg.content)
      ? msg.content.map(safeBlockText).join('')
      : ''; // non-string, non-array content contributes only turn overhead
  return estimateTokens(content) + 4; // 4-token overhead per message turn
}

// --- §3.1 normalize role:system → top-level system --------------------------

function messageSystemText(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map(b => (b && typeof b.text === 'string') ? b.text : '').filter(Boolean).join('\n');
  }
  return '';
}

// True iff a top-level `system` value is a block array that carries structured
// state we must NOT flatten to a string — specifically a client `cache_control`
// breakpoint (I5 / §3.4: "preserve any client cache_control breakpoints exactly;
// never remove"). Flattening such a system via systemToText() would strip the
// breakpoint, so when this is true we merge by APPENDING text blocks instead.
function systemHasStructuredBlocks(system) {
  return Array.isArray(system) && system.some(b => b && typeof b === 'object' && b.cache_control);
}

// Hoist role:system messages into top-level `system` and strip them from
// messages[]. Anthropic rejects system prompts inside messages[] — they must use
// the top-level field. Returns { body, messages } where body carries the merged
// top-level `system`. NEVER truncates, NEVER reorders the surviving messages.
//
// I5 / §3.4: a client `cache_control` breakpoint on a block-array top-level
// `system` is sacred — it must survive the hoist. So when the existing top-level
// `system` is a block array carrying cache_control, we PRESERVE it as blocks and
// APPEND the hoisted role:system text as additional text block(s), rather than
// flattening everything to a string (which would drop the breakpoint). The
// string-merge form is used only when there is no structured system state to lose.
function normalizeAnthropicBody(body, messages) {
  const out = { ...body };
  const systemMsgs = messages.filter(m => m && m.role === 'system');
  const cleanMessages = messages.filter(m => !m || m.role !== 'system');

  if (systemMsgs.length === 0) {
    return { body: out, messages: cleanMessages };
  }

  const hoistedTexts = [];
  for (const msg of systemMsgs) {
    const text = messageSystemText(msg);
    if (text) hoistedTexts.push(text);
  }

  if (systemHasStructuredBlocks(out.system)) {
    // Block-array system with a client cache_control breakpoint → preserve the
    // blocks (and their breakpoints) exactly; append each hoisted role:system
    // message as its own trailing text block. Never flatten to a string.
    const merged = out.system.map(b =>
      (b && typeof b === 'object') ? { ...b } : { type: 'text', text: String(b) });
    for (const text of hoistedTexts) merged.push({ type: 'text', text });
    out.system = merged;
    return { body: out, messages: cleanMessages };
  }

  // No structured system state to lose → safe string-merge form.
  let system = out.system;
  for (const text of hoistedTexts) {
    system = system ? `${systemToText(system)}\n${text}` : text;
  }
  if (system) {
    out.system = system;
  } else {
    delete out.system;
  }

  return { body: out, messages: cleanMessages };
}

// --- §3.3 lossless tool_result dedup ----------------------------------------

function cloneMsg(msg) {
  // Shallow clone; dedup replaces `.content` with a fresh array so the caller's
  // original message objects are never mutated.
  return { ...msg };
}

function contentBlocks(msg) {
  return Array.isArray(msg.content) ? msg.content : [];
}

// A tool_result is a dedup CANDIDATE only when replacing its `content` with a
// STRING stub is provably wire-legal + model-equivalent: content must be a
// string, or an array of ONLY text blocks. An array carrying any image/document
// (or unknown) block is OUT OF SCOPE (§3.3 / §7 Q1) — collapsing it to a string
// stub would change the block TYPE, so we treat such a result as unique.
function isStubbableToolResult(block) {
  if (typeof block.content === 'string') return true;
  if (Array.isArray(block.content)) {
    return block.content.every(c => c && c.type === 'text');
  }
  // null/undefined/object content: not a bulky text payload → leave as-is.
  return false;
}

// Recursively sort object keys so two semantically-equal values stringify to the
// SAME canonical string (block field order can differ between turns).
function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
    return out;
  }
  return v;
}

// Identity key for a `tool_result` block (I4). Combines PAIRED-TOOL identity
// (the answering tool_use's name + input, from the immediately-preceding
// assistant turn) with the block MINUS its `tool_use_id`.
//
// `tool_use_id` is only a pairing pointer and legitimately varies between two
// otherwise-identical results, so it is excluded. EVERY other semantic field
// (content, is_error, cache_control, …) participates: a differing field → a
// different key → both preserved. A false-distinct is safe; a false-identical is
// impossible. If the paired tool_use is un-locatable, the caller treats the block
// as unique and never calls this (fail-safe, §3.3).
function dedupKey(pairedName, pairedInput, block) {
  const { tool_use_id, ...semantic } = block; // exclude ONLY the pairing id
  return 'tr:' + JSON.stringify(canonicalize([pairedName, pairedInput, semantic]));
}

// Map every user-turn tool_result → the paired tool_use in the IMMEDIATELY
// PRECEDING assistant turn. Returns Map<msgIndex, Map<tool_use_id, {name,input}>>.
// A block whose pairing is un-locatable is simply absent → treated as unique.
function buildPairings(messages) {
  const pairings = new Map();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    const prev = messages[i - 1];
    const useById = new Map();
    if (prev && prev.role === 'assistant' && Array.isArray(prev.content)) {
      for (const b of prev.content) {
        if (b && b.type === 'tool_use') useById.set(b.id, { name: b.name, input: b.input });
      }
    }
    pairings.set(i, useById);
  }
  return pairings;
}

// Lossless middle dedup. Walks newest → oldest so the FIRST occurrence recorded
// for any key is the NEWEST copy (always authoritative + retained, never stubbed).
// Older identical copies get ONLY their bulky `content` replaced by a text stub
// `[miser: identical to turn N]`; `tool_use_id`, `is_error`, and every other
// semantic field are preserved so pairing/adjacency is untouched. The first
// non-system user turn (firstTaskIdx) and the recent tail (>= tailStart) are the
// preserve set and are never rewritten. Mutates the (cloned) `messages` in place.
function dedupMiddle(messages, firstTaskIdx, tailStart, pairings) {
  const seen = new Map(); // key -> index of newest occurrence

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const paired = pairings.get(i);

    // Tail: authoritative newest copies. Record keys, never rewrite.
    if (i >= tailStart) {
      if (paired) {
        for (const b of contentBlocks(m)) {
          if (b && b.type === 'tool_result' && isStubbableToolResult(b)) {
            const pair = paired.get(b.tool_use_id);
            if (!pair) continue; // un-locatable pairing → unique
            const k = dedupKey(pair.name, pair.input, b);
            if (!seen.has(k)) seen.set(k, i);
          }
        }
      }
      continue;
    }

    // First task/handoff turn is part of the preserve set — never touch it.
    if (i === firstTaskIdx) continue;
    if (!Array.isArray(m.content) || !paired) continue;

    m.content = m.content.map(b => {
      // Only tool_result blocks are dedup candidates. Text blocks (which may
      // carry unique user instructions or distinct assistant reasoning) and
      // image/document blocks (out of scope, §7 Q1) are NEVER collapsed.
      if (!b || b.type !== 'tool_result') return b;
      if (!isStubbableToolResult(b)) return b; // image/document content → out of scope (§3.3)
      const pair = paired.get(b.tool_use_id);
      if (!pair) return b; // un-locatable paired tool_use → treat as unique (fail-safe)
      const k = dedupKey(pair.name, pair.input, b);
      if (seen.has(k)) {
        // Preserve every semantic field (tool_use_id, is_error, …); replace ONLY
        // the bulky content with the stub marker pointing at the newest copy.
        return { ...b, content: `[miser: identical to turn ${seen.get(k)}]` };
      }
      seen.set(k, i);
      return b;
    });
  }
}

// --- §3.4 optional cache-hint (opt-in, default OFF) -------------------------
// Insert exactly ONE cache_control:{type:'ephemeral'} breakpoint on the LAST
// block of top-level `system`, converting a string system to a single-text-block
// array to carry the marker. Applied as the LAST pipeline step (after §3.5) so a
// dedup revert can never drop it. Billing-only; the system TEXT is byte-identical.
// Inserted IFF cache-hint is enabled AND there are zero client breakpoints AND
// there are > MIN_KEEP turns. If there is no `system`, SKIP (no tools/user-turn
// placement — those have wire-legal edge cases not worth the risk, §3.4).
function bodyHasCacheControl(body) {
  if (Array.isArray(body.system)) {
    if (body.system.some(b => b && b.cache_control)) return true;
  }
  for (const m of body.messages || []) {
    if (Array.isArray(m.content)) {
      if (m.content.some(b => b && b.cache_control)) return true;
    }
  }
  // Anthropic also lets a client place a cache_control breakpoint on a tools[]
  // entry (a common pattern: cache the tool definitions prefix). If ANY such
  // breakpoint exists, the client already manages caching and we must not insert
  // a second one ("insert iff zero client breakpoints", §3.4).
  if (Array.isArray(body.tools)) {
    if (body.tools.some(t => t && t.cache_control)) return true;
  }
  return false;
}

function applyCacheHint(body, turnCount) {
  if (body.system == null || body.system === '') return body; // no system → skip
  if (turnCount <= MIN_KEEP) return body;
  if (bodyHasCacheControl(body)) return body; // client already manages breakpoints

  const out = { ...body };
  if (typeof out.system === 'string') {
    out.system = [{ type: 'text', text: out.system, cache_control: { type: 'ephemeral' } }];
  } else if (Array.isArray(out.system) && out.system.length > 0) {
    const arr = out.system.map(b => ({ ...b }));
    const last = arr.length - 1;
    arr[last] = { ...arr[last], cache_control: { type: 'ephemeral' } };
    out.system = arr;
  } else {
    return body; // non-string, non-array (or empty array) system → skip
  }
  return out;
}

// --- §3.5 adjacency-correct integrity check ---------------------------------
// Anthropic requires each `tool_result` to be answered by a `tool_use` in the
// IMMEDIATELY PRECEDING assistant turn, and each `tool_use` to be answered by a
// `tool_result` in the IMMEDIATELY FOLLOWING user turn. "Id present somewhere"
// is NOT enough — a reordered/detached pair still 400s. We verify true adjacency
// in both directions. Used INTERNALLY by compress() to decide keep-or-revert of
// its OWN dedup — never as a client-facing rejection (§8.8).
function validateMessageIntegrity(messages) {
  // Every tool_result must be answered by the immediately-preceding assistant tool_use.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) continue;

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
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;

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

// ---------------------------------------------------------------------------
// §3.8 OpenAI-format dedup (`/v1/chat/completions`)
//
// OpenAI `role:'system'` is legal inside messages[] — skip Anthropic
// normalization and first-message rules. Dedup repeated results losslessly:
//   - role:'tool' identity = [fn.name, fn.arguments, content], fn.* from the
//     paired assistant.tool_calls[] matched by tool_call_id.
//   - legacy role:'function' identity = [name, paired assistant.function_call
//     .arguments, content].
// An un-locatable pair → treat as unique. Same reduced-body contract (I6).
// ---------------------------------------------------------------------------

// For a role:'tool'/role:'function' message, resolve the paired call signature
// [name, arguments] by scanning backwards for the answering assistant turn.
function openaiPairForToolMsg(messages, idx) {
  const msg = messages[idx];
  if (msg.role === 'tool') {
    const id = msg.tool_call_id;
    for (let j = idx - 1; j >= 0; j--) {
      const a = messages[j];
      if (!a || a.role !== 'assistant' || !Array.isArray(a.tool_calls)) continue;
      const call = a.tool_calls.find(c => c && c.id === id);
      if (call && call.function) return [call.function.name, call.function.arguments];
    }
    return null; // un-locatable
  }
  if (msg.role === 'function') {
    // Legacy: paired to the most recent assistant.function_call by name.
    const name = msg.name;
    for (let j = idx - 1; j >= 0; j--) {
      const a = messages[j];
      if (!a || a.role !== 'assistant' || !a.function_call) continue;
      if (a.function_call.name === name) return [name, a.function_call.arguments];
    }
    return null;
  }
  return null;
}

function dedupOpenAIMessages(messages, tailStart) {
  const work = messages.map(cloneMsg);
  const seen = new Map();
  for (let i = work.length - 1; i >= 0; i--) {
    const m = work[i];
    if (!m || (m.role !== 'tool' && m.role !== 'function')) continue;
    const pair = openaiPairForToolMsg(work, i);
    if (!pair) continue; // un-locatable pairing → unique
    const key = 'oai:' + JSON.stringify(canonicalize([pair[0], pair[1], m.content]));

    // Tail: authoritative newest copy — record key, never rewrite.
    if (i >= tailStart) {
      if (!seen.has(key)) seen.set(key, i);
      continue;
    }
    if (seen.has(key)) {
      work[i] = { ...m, content: `[miser: identical to turn ${seen.get(key)}]` };
    } else {
      seen.set(key, i);
    }
  }
  return work;
}

// ---------------------------------------------------------------------------
// compress() — the single entry point. Returns { body, messages, tokens, rawTokens }
// where `body` is the REDUCED body proxy.js forwards on EVERY leg (I6).
// `format` is 'anthropic' (default) or 'openai'. `opts.cacheHint` opts into §3.4.
// ---------------------------------------------------------------------------
function compress(body, opts = {}) {
  const format = opts.format || 'anthropic';
  const cacheHint = !!opts.cacheHint;
  const rawMessages = body.messages || [];

  if (format === 'openai') {
    // §3.8 — no anthropic normalization, no first-message rules.
    const rawTokens = rawMessages.reduce((sum, m) => sum + messageTokens(m), 0);
    const tailStart = Math.max(0, rawMessages.length - MIN_KEEP);
    const work = dedupOpenAIMessages(rawMessages, tailStart);
    const tokens = work.reduce((sum, m) => sum + messageTokens(m), 0);
    const outBody = { ...body, messages: work };
    return { body: outBody, messages: work, tokens, rawTokens };
  }

  // --- Anthropic path ------------------------------------------------------
  // §3.1 normalize role:system → top-level system.
  const { body: normBody, messages: normMessages } = normalizeAnthropicBody(body, rawMessages);

  const systemTokens = estimateTokens(systemToText(normBody.system));
  const rawTokens = systemTokens + normMessages.reduce((sum, m) => sum + messageTokens(m), 0);

  // §3.1a legality is by CONSTRUCTION: dedup never removes/reorders messages and
  // there is no truncation, so miser cannot move a block to position 0. Nothing
  // to do here — an already-illegal client opener forwards as-is.

  // §3.3 lossless tool_result dedup (on a clone; original messages untouched).
  const tailStart = Math.max(0, normMessages.length - MIN_KEEP);
  const firstTaskIdx = normMessages.findIndex(m => m && m.role === 'user'); // -1 if none
  const work = normMessages.map(cloneMsg);
  const pairings = buildPairings(work);
  // `opts._dedupImpl` is a TEST-ONLY seam (undefined in production) so a test can
  // inject a dedup that DOES break adjacency and prove the §3.5 revert below is
  // load-bearing. Production always uses the real lossless dedupMiddle.
  const dedupImpl = opts._dedupImpl || dedupMiddle;
  dedupImpl(work, firstTaskIdx, tailStart, pairings);

  // §3.5 adjacency re-validation. On failure, revert DEDUP ONLY — back to the
  // §3.1-normalized messages (system already hoisted; never the raw illegal
  // input). Normalization is always retained.
  let finalMessages = work;
  const integ = validateMessageIntegrity(work);
  if (!integ.valid) {
    console.warn(`[miser] compress: dedup rejected (${integ.error}); reverting dedup, forwarding normalized messages`);
    finalMessages = normMessages;
  }

  // §3.4 cache-hint LAST (on the final message set), opt-in + default OFF.
  let outBody = { ...normBody, messages: finalMessages };
  if (cacheHint) {
    outBody = applyCacheHint(outBody, finalMessages.length);
  }
  // Keep body.messages authoritative and in sync with the returned messages.
  outBody.messages = finalMessages;

  const tokens = estimateTokens(systemToText(outBody.system)) + finalMessages.reduce((sum, m) => sum + messageTokens(m), 0);

  return { body: outBody, messages: finalMessages, tokens, rawTokens };
}

module.exports = {
  compress,
  estimateTokens,
  messageTokens,
  validateMessageIntegrity,
  normalizeAnthropicBody,
  dedupMiddle,
  MIN_KEEP,
};
