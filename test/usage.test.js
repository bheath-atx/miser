'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
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

test('v4 M1: proxyAnthropicResponse keeps piping when the usage parser throws mid-stream', async () => {
  const statsFile = path.join(os.tmpdir(), `miser-usage-proxy-${process.pid}-${Date.now()}.json`);
  const prevEnv = process.env.MISER_STATS_FILE;
  const prevWarn = console.warn;
  const originalObserve = AnthropicUsageParser.prototype.observeChunk;
  const routerPath = require.resolve('../src/router.js');
  const statsPath = require.resolve('../src/stats.js');
  const warnings = [];

  class CaptureRes extends Writable {
    constructor() {
      super();
      this.headersSent = false;
      this.statusCode = null;
      this.headers = {};
      this.chunks = [];
      this._done = new Promise(resolve => { this._resolveDone = resolve; });
      this.on('finish', () => this._resolveDone());
    }
    writeHead(code, headers) {
      this.headersSent = true;
      this.statusCode = code;
      this.headers = headers || {};
      return this;
    }
    _write(chunk, enc, cb) {
      this.chunks.push(chunk.toString());
      cb();
    }
    body() {
      return this.chunks.join('');
    }
    whenDone() {
      return this._done;
    }
  }

  try {
    process.env.MISER_STATS_FILE = statsFile;
    delete require.cache[routerPath];
    delete require.cache[statsPath];
    const { proxyAnthropicResponse } = require('../src/router.js');
    let observeCalls = 0;
    AnthropicUsageParser.prototype.observeChunk = function patchedObserve(chunk) {
      observeCalls += 1;
      if (observeCalls === 2) throw new Error('parser exploded');
      return originalObserve.call(this, chunk);
    };
    console.warn = (line) => warnings.push(String(line));

    const upstream = new PassThrough();
    upstream.statusCode = 200;
    upstream.headers = { 'content-type': 'text/event-stream' };
    const res = new CaptureRes();
    const done = new Promise((resolve, reject) => {
      proxyAnthropicResponse(upstream, res, { model: 'claude-sonnet-4' }, 'alpha', 0, resolve, reject);
    });

    const first = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n';
    const second = 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n';
    upstream.write(first);
    upstream.write(second);
    upstream.end();

    await done;
    await res.whenDone();
    assert.equal(res.statusCode, 200);
    assert.equal(res.body(), first + second);
    assert.match(warnings.join('\n'), /usage parser skipped: parser exploded/);
    assert.equal(fs.existsSync(statsFile), false);
  } finally {
    AnthropicUsageParser.prototype.observeChunk = originalObserve;
    console.warn = prevWarn;
    delete require.cache[routerPath];
    delete require.cache[statsPath];
    if (prevEnv === undefined) delete process.env.MISER_STATS_FILE;
    else process.env.MISER_STATS_FILE = prevEnv;
    try { fs.unlinkSync(statsFile); } catch (_) {}
  }
});
