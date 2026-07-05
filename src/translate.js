'use strict';

// Translate Anthropic Messages API request → Ollama /api/chat format.
function translateToOllama(messages, originalBody, model) {
  const ollamaMessages = [];

  if (originalBody.system) {
    const text = typeof originalBody.system === 'string'
      ? originalBody.system
      : originalBody.system.map(b => b.text || '').join('\n');
    ollamaMessages.push({ role: 'system', content: text });
  }

  for (const msg of messages) {
    const content = typeof msg.content === 'string'
      ? msg.content
      : msg.content.map(block => {
          if (block.type === 'text') return block.text;
          if (block.type === 'tool_result') return `[tool result: ${JSON.stringify(block.content)}]`;
          if (block.type === 'tool_use') return `[tool call: ${block.name}(${JSON.stringify(block.input)})]`;
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
function translateOllamaStream(ollamaStream, res, model) {
  const messageId = `msg_miser_${Date.now().toString(36)}`;
  let buffer = '';
  let started = false;

  function sse(event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  ollamaStream.setEncoding('utf8');

  ollamaStream.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }

      if (!started) {
        started = true;
        sse('message_start', {
          type: 'message_start',
          message: {
            id: messageId, type: 'message', role: 'assistant',
            model, content: [], stop_reason: null,
            usage: { input_tokens: parsed.prompt_eval_count || 0, output_tokens: 0 },
          },
        });
        sse('content_block_start', {
          type: 'content_block_start', index: 0,
          content_block: { type: 'text', text: '' },
        });
      }

      const text = parsed.message?.content || '';
      if (text) {
        sse('content_block_delta', {
          type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text },
        });
      }

      if (parsed.done) {
        sse('content_block_stop', { type: 'content_block_stop', index: 0 });
        sse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: parsed.eval_count || 0 },
        });
        sse('message_stop', { type: 'message_stop' });
        if (!res.writableEnded) res.end();
      }
    }
  });

  ollamaStream.on('end', () => {
    if (!res.writableEnded) res.end();
  });
}

module.exports = { translateToOllama, translateOllamaStream };
