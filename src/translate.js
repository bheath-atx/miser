'use strict';

const { systemToText } = require('./translate-openai.js');

// JSON.stringify that never throws (e.g. on circular tool payloads).
function safeJson(v) {
  try { return JSON.stringify(v); } catch (_) { return '"[unserializable]"'; }
}

// Translate Anthropic Messages API request → Ollama /api/chat format.
function translateToOllama(messages, originalBody, model) {
  const ollamaMessages = [];

  // systemToText is robust to string / block-array / object `system` shapes and
  // never throws on a malformed value (previously `.map` TypeError'd on an
  // object-form system and bricked the Ollama fallback leg).
  const sysText = systemToText(originalBody.system);
  if (sysText) {
    ollamaMessages.push({ role: 'system', content: sysText });
  }

  for (const msg of messages) {
    const content = typeof msg.content === 'string'
      ? msg.content
      : !Array.isArray(msg.content)
        ? ''
      : msg.content.map(block => {
          if (!block || typeof block !== 'object') return '';
          if (block.type === 'text') return typeof block.text === 'string' ? block.text : '';
          if (block.type === 'tool_result') return `[tool result: ${safeJson(block.content)}]`;
          if (block.type === 'tool_use') return `[tool call: ${block.name}(${safeJson(block.input)})]`;
          return '';
        }).filter(Boolean).join('\n');

    if (content) ollamaMessages.push({ role: msg.role, content });
  }

  return {
    model,
    messages: ollamaMessages,
    stream: true,
    options: { num_predict: originalBody.max_tokens || 4096 },
  };
}

// Translate Ollama NDJSON stream → Anthropic SSE format.
// Claude Code expects the Anthropic event shape; this bridges the gap.
function translateOllamaStream(ollamaStream, res, model, opts = {}) {
  const messageId = `msg_miser_${Date.now().toString(36)}`;
  let buffer = '';
  let started = false;
  let stopped = false;
  let sawValidLine = false;
  let sawText = false;
  let sawError = false;
  let outputTokens = 0;
  const headers = opts.headers || {};
  const emptyText = opts.emptyText || 'miser: local fallback returned an empty response; stand down and retry after provider recovery.';

  function sse(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function ensureStarted() {
    if (started) return;
    started = true;
    if (!res.headersSent) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        ...headers,
      });
    }
    sse('message_start', {
      type: 'message_start',
      message: {
        id: messageId, type: 'message', role: 'assistant',
        model, content: [], stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    sse('content_block_start', {
      type: 'content_block_start', index: 0,
      content_block: { type: 'text', text: '' },
    });
  }

  function finish(textIfEmpty = '') {
    if (stopped) return;
    stopped = true;
    ensureStarted();
    if (!sawText && textIfEmpty) {
      sawText = true;
      sse('content_block_delta', {
        type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: textIfEmpty },
      });
    }
    sse('content_block_stop', { type: 'content_block_stop', index: 0 });
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens },
    });
    sse('message_stop', { type: 'message_stop' });
    if (!res.writableEnded) res.end();
  }

  ollamaStream.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    function handleParsed(parsed) {
      sawValidLine = true;
      if (parsed && parsed.error) {
        sawError = true;
        finish(`miser: local fallback error: ${String(parsed.error)}`);
        resolve({ ok: false, sawValidLine, sawText, sawError, outputTokens });
        return;
      }
      ensureStarted();

      const text = parsed && parsed.message && parsed.message.content ? parsed.message.content : '';
      if (text) {
        sawText = true;
        sse('content_block_delta', {
          type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text },
        });
      }

      if (parsed && parsed.done) {
        outputTokens = parsed.eval_count || 0;
        const hadText = sawText;
        finish(hadText ? '' : emptyText);
        resolve({ ok: !sawError && sawValidLine && hadText, sawValidLine, sawText: hadText, sawError, outputTokens });
      }
    }

    ollamaStream.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (stopped || !line.trim()) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }
        handleParsed(parsed);
      }
    });

    ollamaStream.on('end', () => {
      if (!stopped) {
        if (buffer.trim()) {
          try { handleParsed(JSON.parse(buffer)); } catch (_) {}
        }
      }
      if (!stopped) {
        finish(sawValidLine ? 'miser: local fallback stream ended before completion; stand down and retry after provider recovery.' : emptyText);
        resolve({ ok: false, sawValidLine, sawText, sawError, outputTokens });
      }
    });

    ollamaStream.on('error', (err) => {
      if (started) {
        finish(`miser: local fallback stream error: ${err.message}`);
        resolve({ ok: false, sawValidLine, sawText, sawError: true, outputTokens });
        return;
      }
      reject(err);
    });
  });
}

module.exports = { translateToOllama, translateOllamaStream };
