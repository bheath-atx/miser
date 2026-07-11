'use strict';

// Translate an Anthropic Messages API request → OpenAI/Codex **Responses API**
// request, and translate the Responses-API SSE stream back → Anthropic SSE.
//
// This is the failover target Brad chose: the ChatGPT subscription OAuth token
// authenticates against the Codex backend `https://chatgpt.com/backend-api/codex
// /responses`, which speaks the Responses API (NOT chat/completions). Its wire
// shape (confirmed from the codex CLI native binary):
//   POST .../responses
//   body: { model, instructions, input: [ {type:'message', role,
//           content:[{type:'input_text'|'output_text', text}]} ], stream, store }
//   response: SSE with events response.output_text.delta / response.completed /
//             response.failed etc.
//
// Because the Anthropic client (TermDeck/Claude Code) can ONLY parse Anthropic
// SSE, the Codex response stream must be re-emitted in Anthropic event shape —
// exactly the role translateOllamaStream plays for the local model.
//
// VERIFY-AT-CUTOVER: the exact Responses SSE event field names are inferred from
// the documented Responses API + codex binary strings. If a live capture shows a
// different delta/usage field, only the small maps in translateResponsesStream
// need updating — the request translation and failover logic are independent.

const { systemToText, contentToText } = require('./translate-openai.js');

function mapModel(originalBody) {
  return process.env.MISER_CODEX_MODEL || originalBody.codexModel || 'gpt-5.5';
}

// --- Request: Anthropic → Responses API ------------------------------------
function translateToResponses(messages, originalBody = {}) {
  const instructions = systemToText(originalBody.system); // Anthropic system → Responses `instructions`

  const input = [];
  for (const msg of messages || []) {
    if (!msg || !msg.role) continue;
    const role = msg.role === 'assistant' ? 'assistant'
      : msg.role === 'system' ? 'system'
      : 'user';
    const text = contentToText(msg.content); // flattens blocks, degrades tools to text
    if (!text) continue; // never emit an empty content part
    // Responses API distinguishes input_text (user/system) from output_text
    // (assistant). Using the right part type avoids validation rejects.
    const partType = role === 'assistant' ? 'output_text' : 'input_text';
    input.push({ type: 'message', role, content: [{ type: partType, text }] });
  }

  const req = {
    model: mapModel(originalBody),
    input,
    // ALWAYS stream. The Codex transport consumes the response as SSE and
    // re-emits Anthropic SSE to the client (same as the Ollama fallback leg,
    // which always streams regardless of the client's stream flag). A
    // non-streaming Codex JSON body would be silently dropped by the SSE
    // translator, so we never honor a client stream:false here.
    stream: true,
    store: false,
  };
  if (instructions) req.instructions = instructions;
  // NOTE: do NOT send max_output_tokens — the Codex backend rejects it with
  // "400 Unsupported parameter: max_output_tokens" (confirmed by live probe
  // 2026-07-11; the real codex request omits it too). The backend controls
  // output length itself. Likewise no temperature (codex omits it).
  return req;
}

// Structural validator + runtime pre-send guard. Proves the request obeys the
// Responses contract (no Anthropic-only keys, all content parts non-empty
// strings) so the failover leg can never ship a malformed body.
const ANTHROPIC_ONLY_KEYS = new Set(['system', 'messages', 'output_config', 'anthropic_version', 'anthropic_beta', 'tools', 'tool_choice', 'thinking', 'top_k']);

function validateResponsesRequest(req) {
  if (!req || !Array.isArray(req.input)) return { valid: false, error: 'missing input array' };
  if (req.input.length === 0) return { valid: false, error: 'empty input (no usable message content) — fail closed' };
  for (const k of Object.keys(req)) {
    if (ANTHROPIC_ONLY_KEYS.has(k)) return { valid: false, error: `anthropic-only key leaked into Responses request: ${k}` };
  }
  if ('instructions' in req && typeof req.instructions !== 'string') {
    return { valid: false, error: 'instructions must be a string' };
  }
  for (let i = 0; i < req.input.length; i++) {
    const item = req.input[i];
    if (!item || item.type !== 'message') return { valid: false, error: `input.${i}: not a message item` };
    if (!['system', 'user', 'assistant'].includes(item.role)) return { valid: false, error: `input.${i}: invalid role ${item.role}` };
    if (!Array.isArray(item.content) || item.content.length === 0) return { valid: false, error: `input.${i}: empty content` };
    for (let j = 0; j < item.content.length; j++) {
      const part = item.content[j];
      if (!part || !['input_text', 'output_text'].includes(part.type)) return { valid: false, error: `input.${i}.content.${j}: bad part type` };
      if (typeof part.text !== 'string' || part.text.length === 0) return { valid: false, error: `input.${i}.content.${j}: text must be a non-empty string` };
    }
  }
  return { valid: true };
}

// --- Response: Codex Responses-API SSE → Anthropic SSE ----------------------
// Mirrors translateOllamaStream: bridges the provider's event shape into the
// Anthropic events the client expects (message_start → content_block_delta* →
// message_stop). Robust to unknown events (ignored) and malformed data lines.
function translateResponsesStream(upstream, res, model) {
  const messageId = `msg_miser_codex_${Buffer.from(String(model)).toString('hex').slice(0, 8)}`;
  let buffer = '';
  let started = false;
  let inputTokens = 0;

  function sse(event, data) {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function start() {
    if (started) return;
    started = true;
    sse('message_start', {
      type: 'message_start',
      message: {
        id: messageId, type: 'message', role: 'assistant',
        model, content: [], stop_reason: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    });
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  }

  function finish(outputTokens, stopReason) {
    start();
    sse('content_block_stop', { type: 'content_block_stop', index: 0 });
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason || 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens || 0 },
    });
    sse('message_stop', { type: 'message_stop' });
    if (!res.writableEnded) res.end();
  }

  // Parse an SSE frame: collect `event:` and `data:` lines within one frame.
  function handleFrame(frame) {
    let eventName = 'message';
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    const dataRaw = dataLines.join('\n');
    if (dataRaw === '[DONE]') { finish(0); return; }
    let data;
    try { data = JSON.parse(dataRaw); } catch { return; }

    // Event routing. Responses API emits typed events; the type may live in the
    // SSE `event:` line and/or the payload's `.type`.
    const type = eventName !== 'message' ? eventName : (data.type || '');

    if (type === 'response.created' || type === 'response.in_progress') {
      inputTokens = data.response?.usage?.input_tokens || inputTokens;
      start();
      return;
    }
    if (type === 'response.output_text.delta') {
      start();
      const text = typeof data.delta === 'string' ? data.delta : (data.delta?.text || '');
      if (text) sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      return;
    }
    if (type === 'response.completed' || type === 'response.done') {
      const out = data.response?.usage?.output_tokens || 0;
      finish(out, 'end_turn');
      return;
    }
    if (type === 'response.failed' || type === 'response.error' || type === 'error') {
      // Surface as a clean end rather than a hung stream.
      finish(0, 'end_turn');
      return;
    }
    // Unknown event → ignore.
  }

  upstream.setEncoding('utf8');
  upstream.on('data', (chunk) => {
    // Strip ALL CR so CRLF-framed SSE (`\r\n\r\n`) normalizes to `\n\n` frames
    // and per-line `\r` never corrupts `event:`/`data:` prefixes. Safe: raw CR
    // has no meaning inside SSE JSON payloads (a real newline is escaped `\\r`).
    // Removing every CR also survives a CRLF split across chunk boundaries.
    buffer += chunk.split('\r').join('');
    // SSE frames are separated by a blank line.
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (frame.trim()) handleFrame(frame);
    }
  });
  upstream.on('end', () => {
    if (buffer.trim()) handleFrame(buffer);
    if (!res.writableEnded) finish(0);
  });
}

module.exports = { translateToResponses, validateResponsesRequest, translateResponsesStream };
