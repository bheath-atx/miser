'use strict';

// Sprint B — router-level B6 context-bloat hook (§2.2): fires via the
// guardDeps.checkContextBloat seam in proxyAnthropicResponse immediately after
// recordAnthropicUsage, fire-and-forget, exception-isolated, never delays
// resolve(). No sockets: upstream is a bare EventEmitter, res is the harness
// fake.

const os = require('node:os');
const path = require('node:path');
process.env.MISER_STATS_FILE = path.join(os.tmpdir(), `miser-router-test-stats-${process.pid}-${Date.now()}.json`);

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { proxyAnthropicResponse, routeRequest } = require('../src/router.js');
const { makeRes, successTransport } = require('./_harness.js');

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeUpstream(status, contentType) {
  const up = new EventEmitter();
  up.statusCode = status;
  up.headers = { 'content-type': contentType };
  return up;
}

// Drives proxyAnthropicResponse with a single-chunk upstream body and returns
// { result, res } once the router resolves.
function run(upstreamBody, guardDeps, opts = {}) {
  const status = opts.status || 200;
  const contentType = opts.contentType || 'application/json';
  return new Promise((resolve, reject) => {
    const up = fakeUpstream(status, contentType);
    const res = makeRes();
    proxyAnthropicResponse(up, res, { model: 'claude-req' }, 'proj', 0,
      (result) => resolve({ result, res }), reject, guardDeps);
    if (opts.chunks) {
      for (const c of opts.chunks) up.emit('data', Buffer.from(c));
    } else if (upstreamBody != null) {
      up.emit('data', Buffer.from(JSON.stringify(upstreamBody)));
    }
    up.emit('end');
  });
}

test('bloat hook fires with parsed usage after a 2xx response resolves', async () => {
  const calls = [];
  const guardDeps = {
    checkContextBloat: (...args) => calls.push(args),
    ledger: { shouldSend: () => true, markSent: () => {} },
  };
  const { result, res } = await run({
    model: 'claude-real',
    usage: { input_tokens: 5, cache_read_input_tokens: 7 },
  }, guardDeps);
  assert.equal(result.statusCode, 200);
  assert.equal(res.ended, true);
  await tick(); // hook is fire-and-forget on the microtask queue
  assert.equal(calls.length, 1);
  const [project, model, usage, passedDeps] = calls[0];
  assert.equal(project, 'proj');
  assert.equal(model, 'claude-real'); // model from the parsed response, not the request
  assert.deepEqual(usage, { input_tokens: 5, cache_read_input_tokens: 7 });
  assert.equal(passedDeps, guardDeps); // same guardDeps object threaded through
});

test('AC6e: a throwing bloat check is exception-isolated — warn logged, response unaffected', async () => {
  const prevWarn = console.warn;
  const warns = [];
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    const guardDeps = {
      checkContextBloat: () => { throw new Error('kaboom'); },
    };
    const { result, res } = await run({ model: 'm', usage: { input_tokens: 1 } }, guardDeps);
    assert.equal(result.statusCode, 200); // resolve() fired normally
    assert.equal(res.ended, true);        // response completed
    await tick();
    await tick();
    assert.ok(warns.some(w => /bloat check error: kaboom/.test(w)));
  } finally {
    console.warn = prevWarn;
  }
});

test('no guardDeps at all (legacy callers) → no hook, no crash', async () => {
  const { result, res } = await run({ model: 'm', usage: { input_tokens: 1 } }, undefined);
  assert.equal(result.statusCode, 200);
  assert.equal(res.ended, true);
});

test('AC6d: G3-only guardDeps (no checkContextBloat key) → guard false, zero bloat calls', async () => {
  // Mirrors index.js wiring for MISER_BUDGETS-only: checkContextBloat absent.
  const guardDeps = {
    ledger: { shouldSend: () => true, markSent: () => {} },
    budgetsConfig: { proj: { dailyUSD: 5 } },
    budgetGraceConfig: [],
    nowFn: () => new Date(),
  };
  const { result } = await run({ model: 'm', usage: { input_tokens: 999999999 } }, guardDeps);
  assert.equal(result.statusCode, 200);
  await tick(); // nothing to observe — the hook guard `guardDeps.checkContextBloat` is false
  assert.equal('checkContextBloat' in guardDeps, false);
});

test('AC6b: no usage captured (JSON body without usage) → hook receives null usage', async () => {
  const calls = [];
  const guardDeps = { checkContextBloat: (p, m, usage) => calls.push(usage) };
  await run({ model: 'm', content: [{ type: 'text', text: 'hi' }] }, guardDeps);
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0], null); // parser.finish() → usage null → checkContextBloat returns immediately
});

test('aborted/incomplete SSE stream → hook receives null usage (no fabricated signal)', async () => {
  const calls = [];
  const guardDeps = { checkContextBloat: (p, m, usage) => calls.push(usage) };
  await run(null, guardDeps, {
    contentType: 'text/event-stream',
    // Incomplete SSE: event never terminated by a blank line, no usage seen.
    chunks: ['event: message_start\ndata: {"message":{"model":"claude-s'],
  });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0], null);
});

test('non-2xx upstream → no usage recording and no bloat hook', async () => {
  const calls = [];
  const guardDeps = { checkContextBloat: (...a) => calls.push(a) };
  const { result } = await run({ error: 'bad' }, guardDeps, { status: 400 });
  assert.equal(result.statusCode, 400);
  await tick();
  assert.equal(calls.length, 0); // hook lives inside the 2xx block only
});

test('routeRequest threads deps.guardDeps to the anthropic transport as the 7th arg', async () => {
  const calls = [];
  const guardDeps = { marker: 'sprint-b' };
  const res = makeRes();
  await routeRequest([], { model: 'm' }, {}, res, 'proj', 0, 'anthropic', {
    guardDeps,
    transports: {
      anthropic: (...args) => {
        calls.push(args);
        const r = args[3];
        r.writeHead(200, {});
        r.end();
        return Promise.resolve();
      },
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][6], guardDeps);
});

test('routeRequest without guardDeps stays backward-compatible (7th arg undefined)', async () => {
  const calls = [];
  const res = makeRes();
  await routeRequest([], { model: 'm' }, {}, res, 'proj', 0, 'anthropic', {
    transports: { anthropic: successTransport('anthropic', calls) },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[6], undefined);
});
