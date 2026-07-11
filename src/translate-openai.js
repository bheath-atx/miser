'use strict';

// Translate an Anthropic Messages API request → OpenAI/Codex Chat Completions
// format. This exists to stop the failover brick we recovered:
//
//   400 messages.0: use the top-level 'system' parameter for the initial system
//   prompt; the directive-only form (content: [] with output_config) is accepted
//   at any position
//
// Root cause: an Anthropic-only system/directive block was left sitting at
// messages[0] when a request was reshaped during failover. OpenAI/Codex has a
// completely different contract (system lives IN the messages array as a plain
// {role:'system'} turn, there is no top-level `system`, no `output_config`, and
// no empty `content: []` directive form). This translator guarantees the emitted
// request obeys that contract, so the prior messages.0 error can never recur.
//
// Guarantees enforced (see assertNoAnthropicLeak / validateOpenAIRequest):
//   - top-level Anthropic `system` becomes a single leading {role:'system'} msg
//   - every message.content is a NON-EMPTY string (no content:[] directive form)
//   - no Anthropic-only keys (output_config, anthropic_version, system, …) leak
//   - original text ordering is preserved block-by-block, message-by-message
//   - tool_use / tool_result blocks are degraded to inline text (never emitted
//     as structured tool calls the downstream may reject)

// Anthropic-only body keys that must never reach an OpenAI/Codex endpoint.
const ANTHROPIC_ONLY_KEYS = new Set([
  'system',
  'anthropic_version',
  'anthropic_beta',
  'output_config',
  'tools',
  'tool_choice',
  'metadata',
  'container',
  'mcp_servers',
  'thinking',
  'top_k',
]);

function systemToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map(b => (typeof b === 'string' ? b : (b && typeof b.text === 'string') ? b.text : '')).filter(Boolean).join('\n');
  }
  // Object form: ONLY accept a string `.text`. A non-string (e.g. nested object)
  // must never become message content — that would reintroduce a non-string
  // content the downstream rejects. Return '' so the system turn is dropped.
  if (typeof system === 'object' && typeof system.text === 'string') return system.text;
  return '';
}

// Flatten one Anthropic message's content into a single ordered plain-text
// string. Tool blocks are degraded to readable inline markers so nothing
// structured (and nothing Anthropic-only) survives into the OpenAI request.
function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text':
        if (block.text) parts.push(block.text);
        break;
      case 'tool_use':
        // degrade, don't emit a structured tool call
        parts.push(`[tool call: ${block.name}(${safeJson(block.input)})]`);
        break;
      case 'tool_result': {
        const inner = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map(c => (c && c.text) || '').filter(Boolean).join('\n')
            : safeJson(block.content);
        parts.push(`[tool result: ${inner}]`);
        break;
      }
      case 'image':
        // Codex/chat-completions text path can't carry Anthropic image blocks;
        // degrade to a placeholder rather than leak the structured block.
        parts.push('[image omitted]');
        break;
      default:
        // Unknown/Anthropic-only block type — degrade to text, never pass through.
        if (block.text) parts.push(block.text);
        break;
    }
  }
  return parts.join('\n');
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch (_) { return '"[unserializable]"'; }
}

// Map an Anthropic model id to something an OpenAI/Codex endpoint accepts.
// Kept deliberately dumb: prefer an explicit override, else pass through.
function mapModel(originalBody) {
  return process.env.MISER_CODEX_MODEL || originalBody.codexModel || 'gpt-5.5';
}

function translateToOpenAI(messages, originalBody = {}) {
  const out = [];

  // 1. Top-level Anthropic system → single leading OpenAI system turn.
  const sysText = systemToText(originalBody.system);
  if (sysText) out.push({ role: 'system', content: sysText });

  // 2. Each Anthropic message → OpenAI turn with flattened text content,
  //    preserving order. Empty-content turns are dropped (no content:[] form).
  for (const msg of messages || []) {
    if (!msg || !msg.role) continue;
    // OpenAI roles: system|user|assistant|tool. Anthropic only emits user/
    // assistant here; anything else is coerced to user to stay in-contract.
    const role = msg.role === 'assistant' ? 'assistant'
      : msg.role === 'system' ? 'system'
      : 'user';
    const text = contentToText(msg.content);
    if (!text) continue; // never emit an empty/directive-only message
    out.push({ role, content: text });
  }

  const req = {
    model: mapModel(originalBody),
    messages: out,
    max_tokens: originalBody.max_tokens || 4096,
    stream: originalBody.stream != null ? originalBody.stream : false,
  };
  if (typeof originalBody.temperature === 'number') req.temperature = originalBody.temperature;

  // Defensive: guarantee no Anthropic-only key survived onto the request object.
  for (const k of Object.keys(req)) {
    if (ANTHROPIC_ONLY_KEYS.has(k)) delete req[k];
  }
  return req;
}

// Structural validator used by tests AND as a runtime pre-send guard: proves the
// translated request cannot trigger the recovered messages.0 error.
function validateOpenAIRequest(req) {
  if (!req || !Array.isArray(req.messages)) {
    return { valid: false, error: 'missing messages array' };
  }
  for (const k of Object.keys(req)) {
    if (ANTHROPIC_ONLY_KEYS.has(k)) {
      return { valid: false, error: `anthropic-only key leaked into OpenAI request: ${k}` };
    }
  }
  for (let i = 0; i < req.messages.length; i++) {
    const m = req.messages[i];
    if (!m || typeof m !== 'object') {
      return { valid: false, error: `messages.${i}: not an object` };
    }
    if (typeof m.content !== 'string') {
      // A non-string content is exactly the Anthropic block/directive form
      // (incl. content: []) that produced the messages.0 brick.
      return { valid: false, error: `messages.${i}: content must be a string, got ${Array.isArray(m.content) ? 'array (Anthropic block/directive form)' : typeof m.content}` };
    }
    if (m.content.length === 0) {
      return { valid: false, error: `messages.${i}: empty content (directive-only form not allowed for OpenAI/Codex)` };
    }
    if (!['system', 'user', 'assistant', 'tool'].includes(m.role)) {
      return { valid: false, error: `messages.${i}: invalid role ${m.role}` };
    }
    if ('output_config' in m) {
      return { valid: false, error: `messages.${i}: Anthropic output_config present` };
    }
  }
  return { valid: true };
}

module.exports = { translateToOpenAI, validateOpenAIRequest, systemToText, contentToText };
