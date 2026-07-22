'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AnthropicUsageParser } = require('../src/usage.js');

function sseData(obj) {
  return `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
}

test('v4 M1: SSE parser handles one JSON object split across chunks', () => {
  const parser = new AnthropicUsageParser({ isSSE: true, model: 'fallback' });
  const event = sseData({
    type: 'message_start',
    message: {
      model: 'claude-sonnet-4',
      usage: {
        input_tokens: 11,
        cache_read_input_tokens: 22,
        cache_creation: { ephemeral_1h_input_tokens: 33 },
      },
    },
  });
  parser.observeChunk(event.slice(0, 41));
  parser.observeChunk(event.slice(41));
  const result = parser.finish();
  assert.equal(result.model, 'claude-sonnet-4');
  assert.equal(result.usage.input_tokens, 11);
  assert.equal(result.usage.cache_read_input_tokens, 22);
  assert.equal(result.usage.cache_creation.ephemeral_1h_input_tokens, 33);
});

test('v4 M1: SSE parser handles multiple events in one chunk', () => {
  const parser = new AnthropicUsageParser({ isSSE: true });
  parser.observeChunk(
    sseData({ type: 'message_start', message: { usage: { input_tokens: 5 } } })
    + sseData({ type: 'message_delta', usage: { output_tokens: 7 } }),
  );
  const result = parser.finish();
  assert.equal(result.usage.input_tokens, 5);
  assert.equal(result.usage.output_tokens, 7);
});

test('v4 M1: SSE parser handles multi-line data fields', () => {
  const parser = new AnthropicUsageParser({ isSSE: true });
  parser.observeChunk('event: message_delta\n');
  parser.observeChunk('data: {"type":"message_delta",\n');
  parser.observeChunk('data: "usage":{"output_tokens":13}}\n\n');
  const result = parser.finish();
  assert.equal(result.usage.output_tokens, 13);
});

test('v4 M1: aborted incomplete SSE stream records no missing axes and does not throw', () => {
  const parser = new AnthropicUsageParser({ isSSE: true });
  assert.doesNotThrow(() => parser.observeChunk('event: message_start\ndata: {"type":"message_start"'));
  const result = parser.finish();
  assert.equal(result.usage, null);
  assert.equal(result.appliedEdits, null);
});

test('v4 M1/C1: non-stream JSON usage and applied_edits are parsed', () => {
  const parser = new AnthropicUsageParser({ isSSE: false, model: 'body-model' });
  parser.observeChunk(JSON.stringify({
    model: 'claude-opus-4',
    usage: { input_tokens: 3, output_tokens: 4 },
    context_management: {
      applied_edits: [{ cleared_tool_uses: 2, cleared_input_tokens: 9000 }],
    },
  }));
  const result = parser.finish();
  assert.equal(result.model, 'claude-opus-4');
  assert.equal(result.usage.input_tokens, 3);
  assert.equal(result.usage.output_tokens, 4);
  assert.deepEqual(result.appliedEdits, [{ cleared_tool_uses: 2, cleared_input_tokens: 9000 }]);
});
