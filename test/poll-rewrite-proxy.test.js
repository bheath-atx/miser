'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');

const { createProxy } = require('../src/proxy.js');
const {
  createPollRewriteBreaker,
  wirePollRewrite,
  shouldRewrite,
  applyPollRewrite,
  formatRewriteHeader,
} = require('../src/poll-rewrite.js');
const { recordPollRewriteStats } = require('../src/stats.js');

function fakeReq(method, url, bodyObj, headers = {}) {
  const raw = bodyObj == null ? '' : JSON.stringify(bodyObj);
  const listeners = {};
  const req = {
    method, url, headers,
    on(evt, cb) { listeners[evt] = cb; return req; },
  };
  process.nextTick(() => {
    if (listeners.data && raw) listeners.data(Buffer.from(raw));
    if (listeners.end) listeners.end();
  });
  return req;
}

class FakeRes extends Writable {
  constructor() {
    super();
    this.headersSent = false;
    this.statusCode = null;
    this.headers = {};
    this.chunks = [];
    this._doneResolvers = [];
    this.on('finish', () => this._doneResolvers.forEach(r => r()));
  }
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; }
  removeHeader(k) { delete this.headers[k.toLowerCase()]; }
  writeHead(code, headers) {
    if (this.headersSent) throw new Error('writeHead twice');
    this.headersSent = true;
    this.statusCode = code;
    this.headers = { ...this.headers, ...(headers || {}) };
    return this;
  }
  _write(chunk, _enc, cb) { this.chunks.push(chunk.toString()); cb(); }
  body() { return this.chunks.join(''); }
  whenDone() { return new Promise(resolve => this._doneResolvers.push(resolve)); }
}

function fakeRes() { return new FakeRes(); }

async function drive(deps, reqBody, url = '/p/pkachu--canary/v1/messages', headers = {}) {
  const res = fakeRes();
  const done = res.whenDone();
  createProxy(deps)(fakeReq('POST', url, reqBody, headers), res);
  await done;
  return res;
}

function okTransport(calls, status = 200) {
  return (_messages, body, headers, res, project, panel) => {
    calls.push({ body, headers, project, panel });
    res.writeHead(status, { 'content-type': 'application/json', 'x-miser-provider': 'anthropic' });
    res.end(JSON.stringify({ ok: true }));
    return Promise.resolve();
  };
}

function failingTransport(calls, statusCode = 500) {
  return (_messages, body, _headers, _res, project, panel) => {
    calls.push({ body, project, panel });
    const err = new Error(`anthropic ${statusCode}`);
    err.statusCode = statusCode;
    return Promise.reject(err);
  };
}

function baseBody(overrides = {}) {
  return {
    model: 'claude-opus-4-8',
    max_tokens: 8000,
    messages: [{ role: 'user', content: 'poll?' }],
    ...overrides,
  };
}

function makePollRewrite(overrides = {}) {
  return {
    projects: { pkachu: { panels: ['canary'], maxTokens: 1024 } },
    breaker: createPollRewriteBreaker({ windowMs: 300000, threshold: 3, resetMs: 1800000 }, overrides.alertDeps || {}),
    shouldRewrite,
    applyPollRewrite,
    formatRewriteHeader,
    recordPollRewriteStats: () => {},
    nowFn: () => new Date('2026-07-20T12:00:00.000Z'),
    ...overrides,
  };
}

test('AC27-AC29: proxy rewrites eligible poll request and passes through non-poll/panel mismatch', async () => {
  const calls = [];
  const deps = { transports: { anthropic: okTransport(calls) }, pollRewrite: makePollRewrite() };
  const res = await drive(deps, baseBody());
  assert.equal(calls[0].body.max_tokens, 1024);
  assert.equal(res.headers['x-miser-poll-rewrite'], 'maxTokens=1024');
  assert.equal(res.headers['x-miser-poll-class'], 'likely');

  calls.length = 0;
  const longRes = await drive(deps, baseBody({ messages: [{ role: 'user', content: 'x'.repeat(600) }] }));
  assert.equal(calls[0].body.max_tokens, 8000);
  assert.equal(longRes.headers['x-miser-poll-rewrite'], undefined);

  calls.length = 0;
  const mismatch = await drive(deps, baseBody(), '/p/pkachu--other/v1/messages');
  assert.equal(calls[0].body.max_tokens, 8000);
  assert.equal(mismatch.headers['x-miser-poll-rewrite'], undefined);
});

test('AC30: zero-config branch never enters poll seams and golden forward fixture is pinned', async () => {
  const calls = [];
  let spyCount = 0;
  const spies = {
    projects: {},
    breaker: { isDisabled: () => { spyCount++; return false; }, recordOutcome: () => { spyCount++; } },
    shouldRewrite: () => { spyCount++; return true; },
    applyPollRewrite: () => { spyCount++; },
    formatRewriteHeader: () => { spyCount++; },
    recordPollRewriteStats: () => { spyCount++; },
    nowFn: () => new Date('2026-07-20T12:00:00.000Z'),
  };
  let res = await drive({ transports: { anthropic: okTransport(calls) }, pollRewrite: spies }, baseBody());
  assert.equal(spyCount, 0);
  assert.equal(res.headers['x-miser-poll-rewrite'], undefined);

  calls.length = 0;
  res = await drive({ transports: { anthropic: okTransport(calls) }, pollRewrite: null }, baseBody());
  assert.equal(calls[0].body.max_tokens, 8000);
  assert.equal(res.headers['x-miser-poll-rewrite'], undefined);

  const fixturePath = path.join(__dirname, 'fixtures-e-golden-forward.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  calls.length = 0;
  res = await drive({ transports: { anthropic: okTransport(calls) }, pollRewrite: null }, fixture.inputBody);
  assert.equal(JSON.stringify(calls[0].body), JSON.stringify(fixture.forwardBody));
  for (const [name, value] of Object.entries(fixture.compactHeaders)) {
    assert.equal(res.headers[name], value, name);
  }
  assert.equal(res.headers['x-miser-poll-rewrite'], undefined);
});

test('AC31/AC32: breaker trip event is composed and error responses suppress rewrite header', async () => {
  const calls = [];
  const alerts = [];
  const sent = new Set();
  const events = [];
  const pollRewrite = makePollRewrite({
    breaker: createPollRewriteBreaker({ windowMs: 300000, threshold: 3, resetMs: 1800000 }, {
      ledger: { shouldSend: k => !sent.has(k), markSent: k => sent.add(k) },
      sendAlert: msg => { alerts.push(msg); },
    }),
    recordPollRewriteStats: (_project, event) => events.push(event),
  });
  const deps = { transports: { anthropic: failingTransport(calls, 500) }, pollRewrite, retryOpts: { maxAttempts: 1 } };
  for (let i = 0; i < 3; i++) {
    const res = await drive(deps, baseBody({ messages: [{ role: 'user', content: `poll ${i}` }] }));
    assert.equal(res.statusCode, 500);
    assert.equal(res.headers['x-miser-poll-rewrite'], undefined);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(alerts.length, 1);
  assert.equal(events.filter(e => e.breakerTrip).length, 1);
  assert.deepEqual(events.at(-1), { levers: ['maxTokens'], breakerTrip: true });

  calls.length = 0;
  await drive(deps, baseBody({ messages: [{ role: 'user', content: 'poll 4' }] }));
  assert.equal(calls.at(-1).body.max_tokens, 8000);

  const statsFile = path.join(os.tmpdir(), `miser-pr-real-${process.pid}-${Date.now()}.json`);
  const prev = process.env.MISER_STATS_FILE;
  delete require.cache[require.resolve('../src/stats.js')];
  process.env.MISER_STATS_FILE = statsFile;
  const realStats = require('../src/stats.js');
  const realBreaker = createPollRewriteBreaker({ windowMs: 300000, threshold: 3, resetMs: 1800000 }, {});
  const realDeps = {
    transports: { anthropic: failingTransport([], 500) },
    pollRewrite: makePollRewrite({ breaker: realBreaker, recordPollRewriteStats: realStats.recordPollRewriteStats }),
    retryOpts: { maxAttempts: 1 },
  };
  for (let i = 0; i < 3; i++) await drive(realDeps, baseBody({ messages: [{ role: 'user', content: `real ${i}` }] }));
  const persisted = realStats.getStats('30').perProject.pkachu.pollRewrite;
  assert.equal(persisted.appliedCount, 3);
  assert.equal(persisted.leverCounts.maxTokens, 3);
  assert.equal(persisted.breakerTrips, 1);
  if (prev === undefined) delete process.env.MISER_STATS_FILE; else process.env.MISER_STATS_FILE = prev;
  try { fs.unlinkSync(statsFile); } catch (_) {}
});

test('AC33/AC37-AC40: each sabotaged poll rewrite seam fails closed without introduced 5xx', async () => {
  for (const [name, override, expectRewritten] of [
    ['apply', { applyPollRewrite: () => { throw new Error('sabotage'); } }, false],
    ['isDisabled', { breaker: { isDisabled: () => { throw new Error('sabotage'); }, recordOutcome: () => {}, getState: () => ({}) } }, false],
    ['recordOutcome', { breaker: { isDisabled: () => false, recordOutcome: () => { throw new Error('sabotage'); }, getState: () => ({}) } }, true],
    ['recordStats', { recordPollRewriteStats: () => { throw new Error('sabotage'); } }, true],
    ['format', { formatRewriteHeader: () => { throw new Error('sabotage'); } }, false],
  ]) {
    const calls = [];
    const warns = [];
    const prevWarn = console.warn;
    console.warn = (...args) => warns.push(args.join(' '));
    try {
      const res = await drive({ transports: { anthropic: okTransport(calls) }, pollRewrite: makePollRewrite(override) }, baseBody());
      assert.equal(res.statusCode, 200, name);
      assert.equal(calls[0].body.max_tokens, expectRewritten ? 1024 : 8000, name);
      assert.equal(warns.length, 1, name);
    } finally {
      console.warn = prevWarn;
    }
  }
});

test('AC42: wirePollRewrite returns null when off and self-provisions alert-capable breaker when on', async () => {
  assert.equal(wirePollRewrite({ pollRewriteProjects: {}, pollRewriteBreaker: { windowMs: 1, threshold: 1, resetMs: 1 } }, {}), null);
  assert.equal(wirePollRewrite({ pollRewriteProjects: { pkachu: { panels: ['canary'], maxTokens: 1024 } }, pollRewriteBreaker: null }, {}), null);
  const config = {
    pollRewriteProjects: { pkachu: { panels: ['canary'], maxTokens: 1024 } },
    pollRewriteBreaker: { windowMs: 300000, threshold: 3, resetMs: 1800000 },
  };
  const alerts = [];
  const sent = new Set();
  const wired = wirePollRewrite(config, {}, {
    createLedger: () => ({ shouldSend: k => !sent.has(k), markSent: k => sent.add(k) }),
    sendAlert: msg => { alerts.push(msg); },
    recordPollRewriteStats: () => {},
  });
  assert.deepEqual(Object.keys(wired).sort(), ['applyPollRewrite', 'breaker', 'formatRewriteHeader', 'nowFn', 'projects', 'recordPollRewriteStats', 'shouldRewrite'].sort());
  assert.equal(wired.shouldRewrite, shouldRewrite);
  assert.equal(wired.applyPollRewrite, applyPollRewrite);
  assert.equal(wired.formatRewriteHeader, formatRewriteHeader);
  wired.breaker.recordOutcome('pkachu', false, 0);
  wired.breaker.recordOutcome('pkachu', false, 1);
  wired.breaker.recordOutcome('pkachu', false, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(alerts.length, 1);

  wired.breaker.recordOutcome('pkachu', false, 1800002);
  wired.breaker.recordOutcome('pkachu', false, 1800003);
  wired.breaker.recordOutcome('pkachu', false, 1800004);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(alerts.length, 1);

  const warns = [];
  const prevWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    const throwing = wirePollRewrite(config, {}, {
      createLedger: () => ({ shouldSend: () => true, markSent: () => {} }),
      sendAlert: () => { throw new Error('alert down'); },
      recordPollRewriteStats: () => {},
    });
    assert.doesNotThrow(() => {
      throwing.breaker.recordOutcome('pkachu', false, 0);
      throwing.breaker.recordOutcome('pkachu', false, 1);
      throwing.breaker.recordOutcome('pkachu', false, 2);
    });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(warns.some(w => /poll-rewrite alert error/.test(w)));
    assert.equal(throwing.breaker.getState('pkachu').trips, 1);
  } finally {
    console.warn = prevWarn;
  }

  const prevLedgerEnv = process.env.MISER_ALERT_LEDGER_FILE;
  const ledgerFile = path.join(os.tmpdir(), `miser-pr-control-ledger-${process.pid}-${Date.now()}.json`);
  try {
    process.env.MISER_ALERT_LEDGER_FILE = ledgerFile;
    const control = wirePollRewrite(config, {});
    assert.equal(typeof control.breaker.recordOutcome, 'function');
    assert.doesNotThrow(() => {
      control.breaker.recordOutcome('pkachu', false, 0);
      control.breaker.recordOutcome('pkachu', false, 1);
      control.breaker.recordOutcome('pkachu', false, 2);
    });
    assert.equal(control.breaker.getState('pkachu').trips, 1);
  } finally {
    process.env.MISER_ALERT_LEDGER_FILE = prevLedgerEnv;
    try { fs.unlinkSync(ledgerFile); } catch (_) {}
  }
});

test('AC44: consistency abandon forwards original, records skipped stats, and never records breaker outcome', async () => {
  const calls = [];
  const events = [];
  let outcomeCalls = 0;
  const breaker = createPollRewriteBreaker({ windowMs: 300000, threshold: 3, resetMs: 1800000 }, {});
  const pollRewrite = makePollRewrite({
    projects: { pkachu: { panels: ['canary'], maxTokens: 1500, thinking: 2048 } },
    breaker: {
      isDisabled: breaker.isDisabled,
      recordOutcome: (...args) => { outcomeCalls += 1; return breaker.recordOutcome(...args); },
      getState: breaker.getState,
    },
    recordPollRewriteStats: (_project, event) => events.push(event),
  });
  const body = baseBody({ thinking: { type: 'enabled', budget_tokens: 4000 } });
  const res = await drive({ transports: { anthropic: okTransport(calls) }, pollRewrite }, body);
  assert.deepEqual(calls[0].body, body);
  assert.equal(calls[0].body.max_tokens, 8000);
  assert.equal(res.headers['x-miser-poll-rewrite'], undefined);
  assert.deepEqual(events, [{ skipped: true }]);
  assert.equal(outcomeCalls, 0);
  assert.deepEqual(breaker.getState('pkachu'), { disabledUntil: 0, windowCount: 0, trips: 0 });

  await drive({ transports: { anthropic: failingTransport([], 500) }, pollRewrite, retryOpts: { maxAttempts: 1 } }, body);
  assert.equal(outcomeCalls, 0);
  assert.deepEqual(breaker.getState('pkachu'), { disabledUntil: 0, windowCount: 0, trips: 0 });
});

test('AC47: OpenAI passthrough route is excluded before rewrite bookkeeping seams', async () => {
  const calls = [];
  let seamCalls = 0;
  const pollRewrite = makePollRewrite({
    projects: { pkachu: { panels: '*', maxTokens: 1024 } },
    breaker: { isDisabled: () => { seamCalls++; return false; }, recordOutcome: () => { seamCalls++; } },
    applyPollRewrite: () => { seamCalls++; },
    formatRewriteHeader: () => { seamCalls++; },
    recordPollRewriteStats: () => { seamCalls++; },
  });
  const res = await drive({
    transports: {
      openaiPassthrough: (_messages, body, _headers, r) => {
        calls.push(body);
        r.writeHead(200, {});
        r.end();
        return Promise.resolve();
      },
    },
    pollRewrite,
  }, baseBody(), '/v1/chat/completions', { 'x-termdeck-project': 'pkachu' });
  assert.equal(calls[0].max_tokens, 8000);
  assert.equal(res.headers['x-miser-poll-rewrite'], undefined);
  assert.equal(seamCalls, 0);
});

test('AC48/AC49: eligible no-op fires nothing; proxy clock passes numeric breaker ms and Date stats nowFn', async () => {
  const calls = [];
  const statsEvents = [];
  const outcomeArgs = [];
  let fixedIso = '2026-07-20T12:00:00.000Z';
  const realBreaker = createPollRewriteBreaker({ windowMs: 300000, threshold: 3, resetMs: 1800000 }, {});
  const breaker = {
    isDisabled: (project, nowMs) => realBreaker.isDisabled(project, nowMs),
    recordOutcome: (project, ok, nowMs) => {
      outcomeArgs.push(nowMs);
      return realBreaker.recordOutcome(project, ok, nowMs);
    },
    getState: realBreaker.getState,
  };
  const pollRewrite = makePollRewrite({
    projects: { pkachu: { panels: '*', maxTokens: 1024, modelMap: { 'claude-opus-4-8': 'x' } } },
    breaker,
    recordPollRewriteStats: (_project, event, nowFn) => statsEvents.push({ event, now: nowFn() }),
    nowFn: () => new Date(fixedIso),
  });
  const noop = await drive({ transports: { anthropic: okTransport(calls) }, pollRewrite }, baseBody({
    max_tokens: 512,
    model: 'claude-sonnet-4-6',
  }));
  assert.equal(calls[0].body.max_tokens, 512);
  assert.equal(noop.headers['x-miser-poll-rewrite'], undefined);
  assert.deepEqual(statsEvents, []);
  assert.deepEqual(realBreaker.getState('pkachu'), { disabledUntil: 0, windowCount: 0, trips: 0 });

  calls.length = 0;
  await drive({ transports: { anthropic: failingTransport(calls, 500) }, pollRewrite, retryOpts: { maxAttempts: 1 } }, baseBody());
  await drive({ transports: { anthropic: failingTransport(calls, 500) }, pollRewrite, retryOpts: { maxAttempts: 1 } }, baseBody({ messages: [{ role: 'user', content: 'two' }] }));
  await drive({ transports: { anthropic: failingTransport(calls, 500) }, pollRewrite, retryOpts: { maxAttempts: 1 } }, baseBody({ messages: [{ role: 'user', content: 'three' }] }));
  const fixedMs = new Date('2026-07-20T12:00:00.000Z').getTime();
  assert.ok(outcomeArgs.every(v => typeof v === 'number' && v === fixedMs));
  assert.equal(realBreaker.getState('pkachu').disabledUntil, fixedMs + 1800000);
  assert.ok(statsEvents.every(e => e.now instanceof Date && e.now.toISOString().slice(0, 10) === '2026-07-20'));
  calls.length = 0;
  await drive({ transports: { anthropic: okTransport(calls) }, pollRewrite }, baseBody({ messages: [{ role: 'user', content: 'four' }] }));
  assert.equal(calls[0].body.max_tokens, 8000);
  fixedIso = '2026-07-20T12:30:00.000Z';
  calls.length = 0;
  await drive({ transports: { anthropic: okTransport(calls) }, pollRewrite }, baseBody({ messages: [{ role: 'user', content: 'five' }] }));
  assert.equal(calls[0].body.max_tokens, 1024);
});
