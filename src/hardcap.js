'use strict';

const { estimateTokens } = require('./compress.js');
const config = require('./config.js');

// Hard-cap for the Ollama fallback leg of the failover chain.
//
// compress.js v2 does NO truncation and enforces NO size ceiling on the primary
// path — it only losslessly dedups byte-identical tool_result content and hoists
// role:system. So the body handed to the Ollama leg can be arbitrarily large
// (e.g. a single huge recent message, or a large zero-duplicate transcript that
// dedup cannot shrink). That is exactly how the double-fallback path could ship a
// >32k payload at Ollama.
//
// This module is the last line of defence before Ollama: it operates on the
// already-translated Ollama chat body ({model, messages:[{role,content}], …})
// and GUARANTEES the estimated total is <= cap, trimming INSIDE oversized
// messages when whole-message drops aren't enough. Truncation preserves the
// newest tail of the conversation (most relevant context) and trims oldest
// content first.

const PER_MSG_OVERHEAD_TOKENS = 4; // matches compress.messageTokens overhead

function bodyTokens(msgs) {
  return msgs.reduce((sum, m) => sum + estimateTokens(m.content) + PER_MSG_OVERHEAD_TOKENS, 0);
}

function hardCapOllamaBody(body, cap) {
  const capTokens = Math.max(1, cap | 0);

  // Clamp requested generation tokens. A passed-through Anthropic max_tokens can
  // be huge; the local model's context is shared between prompt and output, so
  // an uncapped num_predict blows past the local window even with tiny input.
  const maxPredict = config.ollamaMaxPredict;
  const options = { ...(body.options || {}) };
  if (typeof options.num_predict === 'number') {
    // Ollama treats <=0 (esp. -1) as UNBOUNDED generation — clamp that to the
    // default budget, and cap anything above the max. Result is always a sane
    // positive bound in [1, maxPredict].
    if (!Number.isFinite(options.num_predict) || options.num_predict <= 0 || options.num_predict > maxPredict) {
      options.num_predict = maxPredict;
    }
  }
  body = { ...body, options };

  let msgs = (body.messages || []).map(m => ({ ...m }));
  if (msgs.length === 0) return { ...body, messages: msgs };

  // Phase 1: drop oldest NON-system whole messages while over cap, but always
  // keep the final (newest) turn so the model still has the live request.
  while (bodyTokens(msgs) > capTokens) {
    let dropped = false;
    const nonSystemIdx = msgs
      .map((m, i) => ({ m, i }))
      .filter(x => x.m.role !== 'system')
      .map(x => x.i);
    if (nonSystemIdx.length > 1) {
      msgs.splice(nonSystemIdx[0], 1); // drop oldest non-system
      dropped = true;
    }
    if (!dropped) break;
  }

  if (bodyTokens(msgs) <= capTokens) return { ...body, messages: msgs };

  // Phase 2: character-level trim. If even empty messages exceed the cap via
  // per-message overhead, collapse to system(if any)+last first.
  let budgetTokens = capTokens - PER_MSG_OVERHEAD_TOKENS * msgs.length;
  if (budgetTokens < 0) {
    const last = msgs[msgs.length - 1];
    const sys = msgs.find(m => m.role === 'system');
    msgs = sys && sys !== last ? [sys, last] : [last];
    budgetTokens = capTokens - PER_MSG_OVERHEAD_TOKENS * msgs.length;
  }

  // Allocate the char budget newest→oldest so the most recent context (incl. an
  // oversized final message) keeps its TAIL; older messages give up content
  // first. ~4 chars/token (matches estimateTokens).
  let remainingChars = Math.max(0, budgetTokens) * 4;
  const keep = new Array(msgs.length).fill(0);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const take = Math.min(msgs[i].content.length, remainingChars);
    keep[i] = take;
    remainingChars -= take;
  }

  msgs = msgs
    .map((m, i) => {
      if (keep[i] >= m.content.length) return m;
      return { ...m, content: m.content.slice(m.content.length - keep[i]) };
    })
    .filter(m => m.content.length > 0);

  // Final safety correction: per-message ceil() rounding in estimateTokens can
  // leave the total a token or two over. Shave the head off the LONGEST message
  // (preserving its tail = most recent context) until strictly within cap. This
  // makes the <=cap guarantee exact regardless of rounding.
  let guard = 0;
  while (bodyTokens(msgs) > capTokens && guard++ < 1e5) {
    let li = -1, longest = -1;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].content.length > longest) { longest = msgs[i].content.length; li = i; }
    }
    if (li < 0 || longest === 0) break;
    const over = bodyTokens(msgs) - capTokens;
    const cut = Math.min(msgs[li].content.length, Math.max(4, over * 4));
    msgs[li] = { ...msgs[li], content: msgs[li].content.slice(cut) };
    if (msgs[li].content.length === 0) msgs.splice(li, 1);
  }

  return { ...body, messages: msgs };
}

module.exports = { hardCapOllamaBody, bodyTokens };
