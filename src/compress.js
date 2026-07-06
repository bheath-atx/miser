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

function hasToolUse(msg) {
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some(b => b.type === 'tool_use');
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
    const candidate = truncated[0];

    if (hasToolUse(candidate)) {
      // The next turn holds the paired tool_result blocks. We must drop both
      // together — dropping the tool_use alone leaves an orphaned tool_result
      // that causes a 400 from the Anthropic API.
      const hasPair = truncated.length > 1 && truncated[1].role === 'user';
      if (hasPair && truncated.length <= MIN_KEEP + 1) {
        // Dropping both would fall below MIN_KEEP — stop here.
        break;
      }
      truncated.shift();
      tokens -= messageTokens(candidate);
      if (hasPair) {
        tokens -= messageTokens(truncated.shift());
      }
    } else {
      truncated.shift();
      tokens -= messageTokens(candidate);
    }
  }

  return { messages: truncated, tokens, rawTokens };
}

// Returns { valid: true } or { valid: false, error: string }.
// Catches orphaned tool_result blocks that would cause upstream 400s.
function validateMessageIntegrity(messages) {
  const toolUseIds = new Set();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') toolUseIds.add(block.id);
      }
    }
  }
  for (const msg of messages) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result' && !toolUseIds.has(block.tool_use_id)) {
          return { valid: false, error: `orphaned tool_result: tool_use_id ${block.tool_use_id} has no corresponding tool_use block` };
        }
      }
    }
  }
  return { valid: true };
}

module.exports = { compress, estimateTokens, messageTokens, validateMessageIntegrity };
