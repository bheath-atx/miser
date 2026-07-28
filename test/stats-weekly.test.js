'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');

const statsPath = require.resolve('../src/stats.js');

function tmpStatsFile(name) {
  return path.join(os.tmpdir(), `miser-test-weekly-stats-${process.pid}-${name}-${Date.now()}-${Math.random()}.json`);
}

function freshStats(file, seed) {
  delete require.cache[statsPath];
  process.env.MISER_STATS_FILE = file;
  if (seed) fs.writeFileSync(file, JSON.stringify(seed), 'utf8');
  return require('../src/stats.js');
}

function cleanup(file, prevEnv) {
  delete require.cache[statsPath];
  if (prevEnv === undefined) delete process.env.MISER_STATS_FILE;
  else process.env.MISER_STATS_FILE = prevEnv;
  try { fs.unlinkSync(file); } catch (_) {}
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

test('subscription week key straddles the Sunday 06:00 America/Chicago reset', () => {
  const file = tmpStatsFile('boundary');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file);
    const weekKey = stats.__test.subscriptionWeekKeyFromDate;

    assert.equal(
      weekKey(new Date('2026-07-26T10:59:59.000Z')),
      '2026-07-19T11:00:00.000Z',
    );
    assert.equal(
      weekKey(new Date('2026-07-26T11:00:00.000Z')),
      '2026-07-26T11:00:00.000Z',
    );
  } finally {
    cleanup(file, prevEnv);
  }
});

test('subscription week key handles CST boundary at Sunday 12:00 UTC', () => {
  const file = tmpStatsFile('dst');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file);
    const weekKey = stats.__test.subscriptionWeekKeyFromDate;

    assert.equal(
      weekKey(new Date('2026-01-04T11:59:59.000Z')),
      '2025-12-28T12:00:00.000Z',
    );
    assert.equal(
      weekKey(new Date('2026-01-04T12:00:00.000Z')),
      '2026-01-04T12:00:00.000Z',
    );
  } finally {
    cleanup(file, prevEnv);
  }
});

test('weekly buckets accumulate current week-to-date and prior complete weeks', () => {
  const file = tmpStatsFile('rollup');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file);
    const now = new Date();
    const currentWeekStart = stats.__test.subscriptionWeekStartDate(now);
    const priorWeekDate = new Date(currentWeekStart.getTime() - 60_000);
    const currentWeekKey = stats.__test.subscriptionWeekKeyFromDate(now);
    const priorWeekKey = stats.__test.subscriptionWeekKeyFromDate(priorWeekDate);

    stats.recordAnthropicUsage('alpha', 'anthropic', 'claude-sonnet-4', { input_tokens: 10 }, null, () => now);
    stats.recordStats('alpha', { inputTokensRemoved: 3, techniques: { dedup: true } }, () => now);
    stats.recordAnthropicUsage('alpha', 'anthropic', 'claude-sonnet-4', { output_tokens: 2 }, null, () => priorWeekDate);

    const result = stats.getStats('30');
    assert.equal(result.weekly.currentWeekStart, currentWeekKey);
    assert.equal(result.weekly.currentWeekToDate.weekStart, currentWeekKey);
    assert.equal(result.weekly.currentWeekToDate.usage.alpha.anthropic['claude-sonnet-4'].input, 10);
    assert.equal(result.weekly.currentWeekToDate.perProject.alpha.dedup.inputTokensRemoved, 3);

    const prior = result.weekly.priorCompleteWeeks.find(week => week.weekStart === priorWeekKey);
    assert.ok(prior, 'prior complete week should be exposed');
    assert.equal(prior.complete, true);
    assert.equal(prior.usage.alpha.anthropic['claude-sonnet-4'].output, 2);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('internal weekly buckets do not affect daily getStats windows', () => {
  const file = tmpStatsFile('daily-unchanged');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file, {
      '2026-07-27': {
        alpha: { usage: { anthropic: { model: { input: 1 } } } },
      },
      __weekly: {
        '2026-07-26T11:00:00.000Z': {
          alpha: { usage: { anthropic: { model: { input: 999 } } } },
        },
      },
    });
    const result = stats.getStats('9999');
    assert.equal(result.usage.alpha.anthropic.model.input, 1);
    assert.equal(result.weightedTokenEquivalents.total, 1);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('/api/miser/stats/trend ignores internal weekly buckets and keeps daily shape', async () => {
  const file = tmpStatsFile('trend');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    for (const key of Object.keys(require.cache)) {
      if (/\/src\/(proxy|router|routing|stats|pricing|config|context-management)\.js$/.test(key.replace(/\\/g, '/'))) {
        delete require.cache[key];
      }
    }
    process.env.MISER_STATS_FILE = file;
    fs.writeFileSync(file, JSON.stringify({
      '2026-07-27': {
        alpha: { usage: { anthropic: { model: { input: 1 } } } },
      },
      __weekly: {
        '2026-07-26T11:00:00.000Z': {
          alpha: { usage: { anthropic: { model: { input: 999 } } } },
        },
      },
    }), 'utf8');
    const { createProxy } = require('../src/proxy.js');
    const res = new FakeRes();
    createProxy()(fakeReq('/api/miser/stats/trend?days=9999'), res);
    await res.whenDone();

    const payload = JSON.parse(res.body());
    assert.equal(res.statusCode, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.entries.length, 1);
    assert.equal(payload.entries[0].date, '2026-07-27');
    assert.equal(payload.entries[0].input, 1);
    assert.ok(!('weekly' in payload));
  } finally {
    cleanup(file, prevEnv);
  }
});
