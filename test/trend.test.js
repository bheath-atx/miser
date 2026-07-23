'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');

function dayKey(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function tmpStatsFile(name) {
  return path.join(os.tmpdir(), `miser-trend-${process.pid}-${name}-${Date.now()}-${Math.random()}.json`);
}

function freshStats(file, seed) {
  if (seed) fs.writeFileSync(file, JSON.stringify(seed), 'utf8');
  for (const key of Object.keys(require.cache)) {
    if (/\/src\/(stats|pricing)\.js$/.test(key.replace(/\\/g, '/'))) delete require.cache[key];
  }
  process.env.MISER_STATS_FILE = file;
  return require('../src/stats.js');
}

class FakeRes extends Writable {
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
  _write(chunk, enc, cb) { this.chunks.push(chunk.toString()); cb(); }
  body() { return this.chunks.join(''); }
  whenDone() { return this._done; }
}

function fakeReq(url) {
  return {
    method: 'GET',
    url,
    headers: {},
    on() { return this; },
  };
}

async function driveTrend(file, seed, url) {
  for (const key of Object.keys(require.cache)) {
    if (/\/src\/(proxy|router|routing|stats|pricing|config|context-management)\.js$/.test(key.replace(/\\/g, '/'))) {
      delete require.cache[key];
    }
  }
  fs.writeFileSync(file, JSON.stringify(seed), 'utf8');
  process.env.MISER_STATS_FILE = file;
  const { createProxy } = require('../src/proxy.js');
  const res = new FakeRes();
  const handler = createProxy();
  handler(fakeReq(url), res);
  await res.whenDone();
  return { statusCode: res.statusCode, payload: JSON.parse(res.body()) };
}

test('getDailyTrend returns sparse date/project measured traffic entries', () => {
  const file = tmpStatsFile('sparse');
  const prev = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file, {
      [dayKey(-2)]: {
        alpha: { usage: { anthropic: { 'claude-sonnet-4-6': { input: 1_000_000, output: 1000 } } } },
        beta: { dedup: { inputTokensRemoved: 50, appliedCount: 1 } },
      },
      [dayKey(-1)]: {
        alpha: { usage: { anthropic: { 'claude-sonnet-4-6': { cacheRead: 2000 } } } },
        beta: { usage: { anthropic: { 'claude-haiku-4-5': { output: 1_000_000 } } } },
      },
      [dayKey()]: {
        beta: { usage: { anthropic: { 'claude-opus-4-8': { input: 1_000_000 } } } },
      },
    });
    const trend = stats.getDailyTrend('7');
    assert.deepEqual(trend.entries.map(e => `${e.date}:${e.project}`), [
      `${dayKey(-2)}:alpha`,
      `${dayKey(-1)}:alpha`,
      `${dayKey(-1)}:beta`,
      `${dayKey()}:beta`,
    ]);
    assert.equal(trend.entries[0].input, 1_000_000);
    assert.equal(trend.entries[0].anthropicEstCostUSD, 3.015);
    assert.ok(!trend.entries.some(e => e.project === 'beta' && e.date === dayKey(-2)));
  } finally {
    if (prev === undefined) delete process.env.MISER_STATS_FILE;
    else process.env.MISER_STATS_FILE = prev;
    try { fs.unlinkSync(file); } catch (_) {}
  }
});

test('trend project filter, days cap, and today-only behavior', () => {
  const file = tmpStatsFile('filter');
  const prev = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file, {
      [dayKey(-91)]: {
        alpha: { usage: { anthropic: { 'claude-sonnet-4-6': { input: 1 } } } },
      },
      [dayKey()]: {
        beta: { usage: { anthropic: { 'claude-sonnet-4-6': { output: 1 } } } },
      },
    });
    const capped = stats.getDailyTrend('999');
    assert.equal(capped.days, 90);
    assert.deepEqual(capped.entries.map(e => e.project), ['beta']);
    const filtered = stats.getDailyTrend('90', 'alpha');
    assert.deepEqual(filtered.entries, []);
    const todayOnly = stats.getDailyTrend('1');
    assert.equal(todayOnly.entries.length, 1);
    assert.equal(todayOnly.entries[0].date, dayKey());
  } finally {
    if (prev === undefined) delete process.env.MISER_STATS_FILE;
    else process.env.MISER_STATS_FILE = prev;
    try { fs.unlinkSync(file); } catch (_) {}
  }
});

test('/api/miser/stats/trend returns ok envelope and exact project filter', async () => {
  const file = tmpStatsFile('proxy');
  const prev = process.env.MISER_STATS_FILE;
  try {
    const result = await driveTrend(file, {
      [dayKey()]: {
        alpha: { usage: { anthropic: { 'claude-sonnet-4-6': { input: 10 } } } },
        beta: { usage: { anthropic: { 'claude-sonnet-4-6': { input: 20 } } } },
      },
    }, '/api/miser/stats/trend?days=7&project=beta');
    assert.equal(result.statusCode, 200);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.days, 7);
    assert.equal(result.payload.entries.length, 1);
    assert.equal(result.payload.entries[0].project, 'beta');
    assert.equal(result.payload.entries[0].anthropicEstCostUSD, 0.00006);
  } finally {
    if (prev === undefined) delete process.env.MISER_STATS_FILE;
    else process.env.MISER_STATS_FILE = prev;
    try { fs.unlinkSync(file); } catch (_) {}
  }
});
