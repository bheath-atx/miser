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

// Turn-truncation: drop oldest messages when context exceeds threshold.
// Always preserves the last MIN_KEEP messages so the immediate context is intact.
function compress(body, threshold) {
  const messages = body.messages || [];
  const systemTokens = body.system
    ? estimateTokens(typeof body.system === 'string'
        ? body.system
        : body.system.map(b => b.text || '').join(''))
    : 0;

  const rawTokens = systemTokens + messages.reduce((sum, m) => sum + messageTokens(m), 0);

  if (rawTokens <= threshold) {
    return { messages, tokens: rawTokens, rawTokens };
  }

  const MIN_KEEP = Math.min(4, messages.length);
  const truncated = [...messages];
  let tokens = rawTokens;

  while (tokens > threshold && truncated.length > MIN_KEEP) {
    tokens -= messageTokens(truncated.shift());
  }

  return { messages: truncated, tokens, rawTokens };
}

module.exports = { compress, estimateTokens, messageTokens };
