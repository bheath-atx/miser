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

function freshStatsWithEnv(file, seed, env = {}) {
  delete require.cache[statsPath];
  process.env.MISER_STATS_FILE = file;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
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

function sparseStatsWithWatermark(watermark, entries = {}) {
  return {
    __meta: { dailyRetentionWatermark: watermark },
    ...entries,
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

test('subscription week key handles DST transition Sundays with hard-coded UTC instants', () => {
  const file = tmpStatsFile('dst-transitions');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file);
    const weekKey = stats.__test.subscriptionWeekKeyFromDate;

    assert.equal(weekKey(new Date('2026-03-08T10:59:59.000Z')), '2026-03-01T12:00:00.000Z');
    assert.equal(weekKey(new Date('2026-03-08T11:00:00.000Z')), '2026-03-08T11:00:00.000Z');
    assert.equal(weekKey(new Date('2026-11-01T11:59:59.000Z')), '2026-10-25T11:00:00.000Z');
    assert.equal(weekKey(new Date('2026-11-01T12:00:00.000Z')), '2026-11-01T12:00:00.000Z');
  } finally {
    cleanup(file, prevEnv);
  }
});

test('subscription week key logs and uses explicit fallback when zone data is unavailable', () => {
  const file = tmpStatsFile('fallback');
  const prevStatsEnv = process.env.MISER_STATS_FILE;
  const prevForceEnv = process.env.MISER_FORCE_SUBSCRIPTION_TZ_FALLBACK;
  const warnings = [];
  const originalWarn = console.warn;
  try {
    console.warn = (...args) => warnings.push(args.join(' '));
    const stats = freshStatsWithEnv(file, null, { MISER_FORCE_SUBSCRIPTION_TZ_FALLBACK: '1' });
    assert.equal(
      stats.__test.subscriptionWeekKeyFromDate(new Date('2026-07-26T11:59:59.000Z')),
      '2026-07-19T12:00:00.000Z',
    );
    assert.equal(
      stats.__test.subscriptionWeekKeyFromDate(new Date('2026-07-26T12:00:00.000Z')),
      '2026-07-26T12:00:00.000Z',
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /timezone data unavailable/);
    assert.match(warnings[0], /Sunday 12:00 UTC/);
  } finally {
    console.warn = originalWarn;
    if (prevForceEnv === undefined) delete process.env.MISER_FORCE_SUBSCRIPTION_TZ_FALLBACK;
    else process.env.MISER_FORCE_SUBSCRIPTION_TZ_FALLBACK = prevForceEnv;
    cleanup(file, prevStatsEnv);
  }
});

test('subscription timezone probe recovers after a transient unsupported result', () => {
  const file = tmpStatsFile('fallback-recover');
  const prevStatsEnv = process.env.MISER_STATS_FILE;
  const originalDateTimeFormat = Intl.DateTimeFormat;
  let calls = 0;
  try {
    Intl.DateTimeFormat = function DateTimeFormat(locale, options) {
      if (options && options.timeZone === 'America/Chicago' && calls === 0) {
        calls += 1;
        throw new RangeError('transient missing timezone data');
      }
      calls += 1;
      return new originalDateTimeFormat(locale, options);
    };
    const stats = freshStats(file);
    const weekKey = stats.__test.subscriptionWeekKeyFromDate;

    assert.equal(
      weekKey(new Date('2026-07-26T12:00:00.000Z')),
      '2026-07-26T12:00:00.000Z',
    );
    assert.equal(
      weekKey(new Date('2026-07-26T12:00:00.000Z')),
      '2026-07-26T11:00:00.000Z',
    );
  } finally {
    Intl.DateTimeFormat = originalDateTimeFormat;
    cleanup(file, prevStatsEnv);
  }
});

test('subscription timezone probe backs off after permanent unsupported results', () => {
  const file = tmpStatsFile('fallback-backoff');
  const prevStatsEnv = process.env.MISER_STATS_FILE;
  const originalDateTimeFormat = Intl.DateTimeFormat;
  let calls = 0;
  try {
    Intl.DateTimeFormat = function DateTimeFormat(locale, options) {
      if (options && options.timeZone === 'America/Chicago') {
        calls += 1;
        throw new RangeError('permanent missing timezone data');
      }
      return new originalDateTimeFormat(locale, options);
    };
    const stats = freshStats(file);
    const weekKey = stats.__test.subscriptionWeekKeyFromDate;

    for (let i = 0; i < 10; i++) {
      assert.equal(
        weekKey(new Date('2026-07-26T12:00:00.000Z')),
        '2026-07-26T12:00:00.000Z',
      );
    }
    assert.equal(calls, 2);
  } finally {
    Intl.DateTimeFormat = originalDateTimeFormat;
    cleanup(file, prevStatsEnv);
  }
});

test('weekly buckets accumulate current week-to-date and prior complete weeks', () => {
  const file = tmpStatsFile('rollup');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file);
    const now = new Date('2026-07-28T04:00:00.000Z');
    const priorWeekDate = new Date('2026-07-26T10:59:00.000Z');
    const currentWeekKey = '2026-07-26T11:00:00.000Z';
    const priorWeekKey = '2026-07-19T11:00:00.000Z';

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

test('weekly retention caps prior complete weeks and prunes persisted snapshots', async () => {
  const file = tmpStatsFile('retention');
  const prevStatsEnv = process.env.MISER_STATS_FILE;
  const prevMaxEnv = process.env.MISER_WEEKLY_STATS_MAX_WEEKS;
  try {
    const stats = freshStatsWithEnv(file, {
      __weekly: {
        '2026-07-05T11:00:00.000Z': { alpha: { usage: { anthropic: { model: { input: 1 } } } } },
        '2026-07-12T11:00:00.000Z': { alpha: { usage: { anthropic: { model: { input: 2 } } } } },
        '2026-07-19T11:00:00.000Z': { alpha: { usage: { anthropic: { model: { input: 3 } } } } },
        '2026-07-26T11:00:00.000Z': { alpha: { usage: { anthropic: { model: { input: 4 } } } } },
      },
    }, { MISER_WEEKLY_STATS_MAX_WEEKS: '2' });

    const result = stats.getStats('30');
    assert.deepEqual(result.weekly.priorCompleteWeeks.map(w => w.weekStart), [
      '2026-07-19T11:00:00.000Z',
      '2026-07-12T11:00:00.000Z',
    ]);
    await stats.flushNow();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(raw.__weekly).sort(), [
      '2026-07-12T11:00:00.000Z',
      '2026-07-19T11:00:00.000Z',
      '2026-07-26T11:00:00.000Z',
    ]);
  } finally {
    if (prevMaxEnv === undefined) delete process.env.MISER_WEEKLY_STATS_MAX_WEEKS;
    else process.env.MISER_WEEKLY_STATS_MAX_WEEKS = prevMaxEnv;
    cleanup(file, prevStatsEnv);
  }
});

test('legacy daily stats are backfilled into weekly buckets on first load', () => {
  const file = tmpStatsFile('migration');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file, {
      '2026-07-20': {
        alpha: {
          usage: { anthropic: { model: { input: 5, requests: 1 } } },
          budget: { blockedCount: 2, firstBlockedAt: '2026-07-20T14:00:00.000Z' },
        },
      },
      '2026-07-21': {
        alpha: {
          usage: { anthropic: { model: { output: 3, requests: 1 } } },
          policy: { modelDriftCount: 1, contextBloatCount: 2 },
        },
      },
    });
    const weekly = stats.getStats('9999').weekly.priorCompleteWeeks
      .find(week => week.weekStart === '2026-07-19T11:00:00.000Z');
    assert.ok(weekly, 'backfilled prior week should be exposed');
    assert.equal(weekly.usage.alpha.anthropic.model.input, 5);
    assert.equal(weekly.usage.alpha.anthropic.model.output, 3);
    assert.deepEqual(weekly.perProject.alpha.budget, {
      blockedCount: 2,
      firstBlockedAt: '2026-07-20T14:00:00.000Z',
    });
    assert.deepEqual(weekly.perProject.alpha.policy, {
      modelDriftCount: 1,
      contextBloatCount: 2,
    });
    assert.equal(weekly.authoritative, false);
    assert.equal(weekly.nonAuthoritativeReason, 'coverage_unknown');
  } finally {
    cleanup(file, prevEnv);
  }
});

test('existing empty, partial, array, and stale weekly buckets are reconciled from daily stats', () => {
  const prevEnv = process.env.MISER_STATS_FILE;
  const weekKey = '2026-07-19T11:00:00.000Z';
  const daily = sparseStatsWithWatermark('2026-07-19', {
    '2026-07-20': {
      alpha: {
        usage: { anthropic: { model: { input: 5, requests: 1 } } },
        budget: { blockedCount: 2, firstBlockedAt: '2026-07-20T14:00:00.000Z' },
      },
    },
    '2026-07-21': {
      alpha: {
        usage: { anthropic: { model: { output: 3, requests: 1 } } },
        policy: { modelDriftCount: 1, contextBloatCount: 2 },
      },
    },
  });
  const cases = [
    ['empty', {}],
    ['partial', {
      [weekKey]: { alpha: { usage: { anthropic: { model: { input: 5, requests: 1 } } } } },
    }],
    ['array', []],
    ['stale', {
      [weekKey]: {
        alpha: {
          usage: { anthropic: { model: { input: 1, requests: 1 } } },
          budget: { blockedCount: 1, firstBlockedAt: '2026-07-21T14:00:00.000Z' },
        },
      },
    }],
  ];

  for (const [name, weeklySeed] of cases) {
    const file = tmpStatsFile(`migration-${name}`);
    try {
      const stats = freshStats(file, { ...daily, __weekly: weeklySeed });
      const weekly = stats.getRawStatsSnapshot().__weekly[weekKey].alpha;
      assert.equal(weekly.usage.anthropic.model.input, 5, name);
      assert.equal(weekly.usage.anthropic.model.output, 3, name);
      assert.equal(weekly.usage.anthropic.model.requests, 2, name);
      assert.deepEqual(weekly.budget, {
        blockedCount: 2,
        firstBlockedAt: '2026-07-20T14:00:00.000Z',
      }, name);
      assert.deepEqual(weekly.policy, {
        modelDriftCount: 1,
        contextBloatCount: 2,
      }, name);
    } finally {
      cleanup(file, prevEnv);
    }
  }
});

test('weekly reconciliation uses daily-derived counters when stored weekly is higher', () => {
  const file = tmpStatsFile('migration-inflated');
  const prevEnv = process.env.MISER_STATS_FILE;
  const weekKey = '2026-07-19T11:00:00.000Z';
  try {
    const stats = freshStats(file, sparseStatsWithWatermark('2026-07-19', {
      '2026-07-20': {
        alpha: {
          usage: { anthropic: { model: { input: 5, output: 3, requests: 1 } } },
          dedup: { estRemovedTokens: 7, inputTokensRemoved: 7, cacheBillingDelta: 0, appliedCount: 1 },
          likelyPollCount: 1,
          budget: { blockedCount: 2, firstBlockedAt: '2026-07-20T14:00:00.000Z' },
          policy: { modelDriftCount: 1, contextBloatCount: 1 },
        },
      },
      __weekly: {
        [weekKey]: {
          alpha: {
            usage: { anthropic: { model: { input: 999, output: 999, requests: 99 } } },
            dedup: { estRemovedTokens: 999, inputTokensRemoved: 999, cacheBillingDelta: 0, appliedCount: 99 },
            likelyPollCount: 99,
            budget: { blockedCount: 99, firstBlockedAt: '2026-07-21T14:00:00.000Z' },
            policy: { modelDriftCount: 99, contextBloatCount: 99 },
          },
        },
      },
    }));
    const weekly = stats.getRawStatsSnapshot().__weekly[weekKey].alpha;
    assert.equal(weekly.usage.anthropic.model.input, 5);
    assert.equal(weekly.usage.anthropic.model.output, 3);
    assert.equal(weekly.usage.anthropic.model.requests, 1);
    assert.equal(weekly.dedup.inputTokensRemoved, 7);
    assert.equal(weekly.dedup.appliedCount, 1);
    assert.equal(weekly.likelyPollCount, 1);
    assert.deepEqual(weekly.budget, {
      blockedCount: 2,
      firstBlockedAt: '2026-07-20T14:00:00.000Z',
    });
    assert.deepEqual(weekly.policy, {
      modelDriftCount: 1,
      contextBloatCount: 1,
    });
    const exposed = stats.getStats('9999').weekly.priorCompleteWeeks
      .find(week => week.weekStart === weekKey);
    assert.equal(exposed.authoritative, true);
    assert.equal(exposed.degraded, false);
    assert.equal(exposed.usage.alpha.anthropic.model.input, 5);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('partial daily coverage retains stored weekly value and marks it non-authoritative', () => {
  const file = tmpStatsFile('migration-partial-coverage');
  const prevEnv = process.env.MISER_STATS_FILE;
  const weekKey = '2026-07-19T11:00:00.000Z';
  try {
    const stats = freshStats(file, sparseStatsWithWatermark('2026-07-20', {
      '2026-07-20': {
        alpha: { usage: { anthropic: { model: { input: 10, requests: 1 } } } },
      },
      '2026-07-21': {
        alpha: { usage: { anthropic: { model: { input: 20, requests: 1 } } } },
      },
      __weekly: {
        [weekKey]: {
          alpha: { usage: { anthropic: { model: { input: 70, requests: 7 } } } },
        },
      },
    }));

    const rawWeek = stats.getRawStatsSnapshot().__weekly[weekKey];
    assert.equal(rawWeek.alpha.usage.anthropic.model.input, 70);
    assert.equal(rawWeek.alpha.usage.anthropic.model.requests, 7);
    assert.equal(rawWeek.__meta.authoritative, false);
    assert.equal(rawWeek.__meta.reason, 'pre_recording_daily_gap');
    assert.deepEqual(rawWeek.__meta.coverage.presentDays, ['2026-07-20', '2026-07-21']);
    assert.deepEqual(rawWeek.__meta.coverage.missingDays, ['2026-07-19']);
    assert.deepEqual(rawWeek.__meta.coverage.coveredQuietDays, [
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
    ]);
    assert.equal(rawWeek.__meta.coverage.retainedDailyWatermark, '2026-07-20');
    assert.deepEqual(rawWeek.__meta.coverage.expectedDays, [
      '2026-07-19',
      '2026-07-20',
      '2026-07-21',
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
    ]);
    assert.equal(rawWeek.__meta.coverage.presentCount, 2);
    assert.equal(rawWeek.__meta.coverage.expectedCount, 7);

    const exposed = stats.getStats('9999').weekly.priorCompleteWeeks
      .find(week => week.weekStart === weekKey);
    assert.equal(exposed.authoritative, false);
    assert.equal(exposed.degraded, true);
    assert.equal(exposed.nonAuthoritativeReason, 'pre_recording_daily_gap');
    assert.equal(exposed.usage.alpha.anthropic.model.input, 70);
    assert.deepEqual(exposed.coverage.presentDays, ['2026-07-20', '2026-07-21']);
    assert.deepEqual(exposed.coverage.missingDays, ['2026-07-19']);
    assert.deepEqual(exposed.coverage.expectedDays, [
      '2026-07-19',
      '2026-07-20',
      '2026-07-21',
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
    ]);
    assert.equal(stats.getStats('9999').weekly.authoritative, false);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('known-incomplete coverage with no stored weekly bucket is non-authoritative', () => {
  const file = tmpStatsFile('migration-partial-no-stored-weekly');
  const prevEnv = process.env.MISER_STATS_FILE;
  const weekKey = '2026-07-19T11:00:00.000Z';
  try {
    const stats = freshStats(file, sparseStatsWithWatermark('2026-07-20', {
      '2026-07-20': {
        alpha: { usage: { anthropic: { model: { input: 10, requests: 1 } } } },
      },
      '2026-07-21': {
        alpha: { usage: { anthropic: { model: { output: 4, requests: 1 } } } },
      },
    }));

    const rawWeek = stats.getRawStatsSnapshot().__weekly[weekKey];
    assert.equal(rawWeek.alpha.usage.anthropic.model.input, 10);
    assert.equal(rawWeek.alpha.usage.anthropic.model.output, 4);
    assert.equal(rawWeek.alpha.usage.anthropic.model.requests, 2);
    assert.equal(rawWeek.__meta.authoritative, false);
    assert.equal(rawWeek.__meta.reason, 'pre_recording_daily_gap');
    assert.deepEqual(rawWeek.__meta.coverage.presentDays, ['2026-07-20', '2026-07-21']);
    assert.deepEqual(rawWeek.__meta.coverage.missingDays, ['2026-07-19']);
    assert.deepEqual(rawWeek.__meta.coverage.coveredQuietDays, [
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
    ]);
    assert.equal(rawWeek.__meta.coverage.retainedDailyWatermark, '2026-07-20');

    const exposed = stats.getStats('9999').weekly.priorCompleteWeeks
      .find(week => week.weekStart === weekKey);
    assert.equal(exposed.authoritative, false);
    assert.equal(exposed.degraded, true);
    assert.equal(exposed.nonAuthoritativeReason, 'pre_recording_daily_gap');
    assert.deepEqual(exposed.coverage.missingDays, ['2026-07-19']);
    assert.equal(stats.getStats('9999').weekly.authoritative, false);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('fresh install first mid-week write marks earlier current-week days not covered', () => {
  const file = tmpStatsFile('runtime-first-mid-week');
  const prevEnv = process.env.MISER_STATS_FILE;
  const weekKey = '2026-07-26T11:00:00.000Z';
  try {
    const stats = freshStats(file);
    stats.recordAnthropicUsage(
      'alpha',
      'anthropic',
      'claude-sonnet-4',
      { input_tokens: 12 },
      null,
      () => new Date('2026-07-28T15:00:00.000Z'),
    );

    const current = stats.getStats('9999').weekly.currentWeekToDate;
    assert.equal(current.weekStart, weekKey);
    assert.equal(current.authoritative, false);
    assert.equal(current.degraded, true);
    assert.equal(current.nonAuthoritativeReason, 'pre_recording_daily_gap');
    assert.deepEqual(current.coverage.presentDays, ['2026-07-28']);
    assert.deepEqual(current.coverage.missingDays, ['2026-07-26', '2026-07-27']);
    assert.equal(current.coverage.retainedDailyWatermark, '2026-07-28');
    assert.equal(current.usage.alpha.anthropic['claude-sonnet-4'].input, 12);
    assert.equal(stats.getStats('9999').weekly.authoritative, false);

    const snapshot = stats.getRawStatsSnapshot();
    assert.equal(snapshot.__weekly[weekKey].__meta.authoritative, false);
    assert.equal(snapshot.__weekly[weekKey].__meta.reason, 'pre_recording_daily_gap');
  } finally {
    cleanup(file, prevEnv);
  }
});

test('sparse quiet-day coverage replaces stored weekly value and stays authoritative', () => {
  const file = tmpStatsFile('migration-complete-coverage');
  const prevEnv = process.env.MISER_STATS_FILE;
  const weekKey = '2026-07-19T11:00:00.000Z';
  try {
    const stats = freshStats(file, sparseStatsWithWatermark('2026-07-19', {
      '2026-07-20': {
        alpha: { usage: { anthropic: { model: { input: 10, requests: 1 } } } },
      },
      '2026-07-21': {
        alpha: { usage: { anthropic: { model: { input: 20, requests: 1 } } } },
      },
      __weekly: {
        [weekKey]: {
          alpha: { usage: { anthropic: { model: { input: 70, requests: 7 } } } },
        },
      },
    }));

    const rawWeek = stats.getRawStatsSnapshot().__weekly[weekKey];
    assert.equal(rawWeek.alpha.usage.anthropic.model.input, 30);
    assert.equal(rawWeek.alpha.usage.anthropic.model.requests, 2);
    assert.equal(rawWeek.__meta, undefined);

    const exposed = stats.getStats('9999').weekly.priorCompleteWeeks
      .find(week => week.weekStart === weekKey);
    assert.equal(exposed.authoritative, true);
    assert.equal(exposed.degraded, false);
    assert.equal(exposed.nonAuthoritativeReason, undefined);
    assert.equal(exposed.coverage, undefined);
    assert.equal(exposed.usage.alpha.anthropic.model.input, 30);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('current partially elapsed week ignores future days and stays authoritative', () => {
  const file = tmpStatsFile('migration-current-week');
  const prevEnv = process.env.MISER_STATS_FILE;
  const weekKey = '2026-07-26T11:00:00.000Z';
  try {
    const stats = freshStats(file, sparseStatsWithWatermark('2026-07-19', {
      '2026-07-27': {
        alpha: { usage: { anthropic: { model: { input: 4, requests: 1 } } } },
      },
      __weekly: {
        [weekKey]: {
          alpha: { usage: { anthropic: { model: { input: 99, requests: 9 } } } },
        },
      },
    }));

    const current = stats.getStats('9999').weekly.currentWeekToDate;
    assert.equal(current.weekStart, weekKey);
    assert.equal(current.authoritative, true);
    assert.equal(current.degraded, false);
    assert.equal(current.nonAuthoritativeReason, undefined);
    assert.equal(current.coverage, undefined);
    assert.equal(current.usage.alpha.anthropic.model.input, 4);
    assert.equal(current.usage.alpha.anthropic.model.requests, 1);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('weekly reconciliation removes surplus stored projects and models from authoritative weeks', () => {
  const file = tmpStatsFile('migration-surplus');
  const prevEnv = process.env.MISER_STATS_FILE;
  const weekKey = '2026-07-19T11:00:00.000Z';
  try {
    const stats = freshStats(file, sparseStatsWithWatermark('2026-07-19', {
      '2026-07-20': {
        alpha: {
          usage: { anthropic: { model: { input: 5, requests: 1 } } },
        },
      },
      __weekly: {
        [weekKey]: {
          alpha: {
            usage: {
              anthropic: {
                model: { input: 999, requests: 99 },
                surplusModel: { input: 88, requests: 8 },
              },
            },
          },
          surplusProject: {
            usage: { anthropic: { model: { input: 77, requests: 7 } } },
          },
        },
      },
    }));
    const rawWeek = stats.getRawStatsSnapshot().__weekly[weekKey];
    assert.deepEqual(Object.keys(rawWeek).sort(), ['alpha']);
    assert.deepEqual(Object.keys(rawWeek.alpha.usage.anthropic), ['model']);
    assert.equal(rawWeek.alpha.usage.anthropic.model.input, 5);
    assert.equal(rawWeek.alpha.usage.anthropic.model.requests, 1);

    const exposed = stats.getStats('9999').weekly.priorCompleteWeeks
      .find(week => week.weekStart === weekKey);
    assert.equal(exposed.authoritative, true);
    assert.equal(exposed.usage.alpha.anthropic.model.input, 5);
    assert.equal(exposed.usage.alpha.anthropic.surplusModel, undefined);
    assert.equal(exposed.usage.surplusProject, undefined);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('valid stored weekly week with no daily backing is exposed as non-authoritative', () => {
  const file = tmpStatsFile('migration-stored-only');
  const prevEnv = process.env.MISER_STATS_FILE;
  const weekKey = '2026-07-12T11:00:00.000Z';
  try {
    const stats = freshStats(file, {
      __weekly: {
        [weekKey]: {
          alpha: { usage: { anthropic: { model: { input: 11, requests: 1 } } } },
        },
      },
    });
    const rawWeek = stats.getRawStatsSnapshot().__weekly[weekKey];
    assert.deepEqual(rawWeek.__meta, {
      authoritative: false,
      reason: 'no_daily_backing',
    });

    const exposed = stats.getStats('9999').weekly.priorCompleteWeeks
      .find(week => week.weekStart === weekKey);
    assert.ok(exposed, 'stored-only week should still be visible');
    assert.equal(exposed.authoritative, false);
    assert.equal(exposed.degraded, true);
    assert.equal(exposed.nonAuthoritativeReason, 'no_daily_backing');
    assert.equal(exposed.usage.alpha.anthropic.model.input, 11);
    assert.equal(stats.getStats('9999').weekly.authoritative, false);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('loadStats migration failure marks preserved weekly data non-authoritative', () => {
  const file = tmpStatsFile('migration-failure-nonauthoritative');
  const prevEnv = process.env.MISER_STATS_FILE;
  const originalDateTimeFormat = Intl.DateTimeFormat;
  const weekKey = '2026-07-19T11:00:00.000Z';
  try {
    Intl.DateTimeFormat = function DateTimeFormat(locale, options) {
      if (options && options.timeZone === 'America/Chicago') {
        throw new TypeError('timezone probe failed unexpectedly');
      }
      return new originalDateTimeFormat(locale, options);
    };
    const stats = freshStats(file, {
      '2026-07-20': {
        alpha: { usage: { anthropic: { model: { input: 5, requests: 1 } } } },
      },
      __weekly: {
        [weekKey]: {
          alpha: { usage: { anthropic: { model: { input: 99, requests: 9 } } } },
        },
      },
    });
    Intl.DateTimeFormat = originalDateTimeFormat;

    const snapshot = stats.getRawStatsSnapshot();
    assert.equal(snapshot['2026-07-20'].alpha.usage.anthropic.model.input, 5);
    assert.deepEqual(snapshot.__weekly[weekKey].__meta, {
      authoritative: false,
      reason: 'migration_retention_failed',
    });
    const exposed = stats.getStats('9999').weekly.priorCompleteWeeks
      .find(week => week.weekStart === weekKey);
    assert.equal(exposed.authoritative, false);
    assert.equal(exposed.nonAuthoritativeReason, 'migration_retention_failed');
  } finally {
    Intl.DateTimeFormat = originalDateTimeFormat;
    cleanup(file, prevEnv);
  }
});

test('clock-skewed record timestamps are rejected, counted, and logged once', () => {
  const file = tmpStatsFile('clock-skew');
  const prevEnv = process.env.MISER_STATS_FILE;
  const warnings = [];
  const originalWarn = console.warn;
  try {
    console.warn = (...args) => warnings.push(args.join(' '));
    const stats = freshStats(file);
    stats.recordAnthropicUsage('alpha', 'anthropic', 'model', { input_tokens: 1 }, null, () => new Date('2030-01-01T00:00:00.000Z'));
    stats.recordBudgetBlock('alpha', () => new Date('2020-01-01T00:00:00.000Z'));
    stats.recordPolicyEvent('alpha', { drift: true }, () => new Date('2030-01-01T00:00:00.000Z'));
    stats.recordStats('alpha', { inputTokensRemoved: 1, techniques: { dedup: true } }, () => new Date('2020-01-01T00:00:00.000Z'));
    assert.deepEqual(stats.getRawStatsSnapshot(), {});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /further rejection logs suppressed/);
    const rejections = stats.getStats('30').recordRejections;
    assert.equal(rejections.total, 4);
    assert.equal(rejections.outOfBoundsTimestamp, 4);
    assert.deepEqual(rejections.byLabel, {
      usage: 1,
      budget: 1,
      policy: 1,
      optimizer: 1,
    });
  } finally {
    console.warn = originalWarn;
    cleanup(file, prevEnv);
  }
});

test('budget and policy events are written to weekly buckets', () => {
  const file = tmpStatsFile('guardrails-weekly');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file);
    const now = () => new Date('2026-07-27T12:00:00.000Z');
    stats.recordBudgetBlock('alpha', now);
    stats.recordBudgetBlock('alpha', now);
    stats.recordPolicyEvent('alpha', { drift: true, bloat: true }, now);
    const week = stats.getStats('30').weekly.currentWeekToDate.perProject.alpha;
    assert.deepEqual(week.budget, {
      blockedCount: 2,
      firstBlockedAt: '2026-07-27T12:00:00.000Z',
    });
    assert.deepEqual(week.policy, {
      modelDriftCount: 1,
      contextBloatCount: 1,
    });
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

test('/api/miser/stats/trend intentionally ignores legacy malformed daily keys', async () => {
  const file = tmpStatsFile('trend-malformed');
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
      '2026-07-99': {
        alpha: { usage: { anthropic: { model: { input: 999 } } } },
      },
      'not-a-date': {
        alpha: { usage: { anthropic: { model: { input: 999 } } } },
      },
    }), 'utf8');
    const { createProxy } = require('../src/proxy.js');
    const res = new FakeRes();
    createProxy()(fakeReq('/api/miser/stats/trend?days=9999'), res);
    await res.whenDone();

    const payload = JSON.parse(res.body());
    assert.equal(res.statusCode, 200);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.entries.map(entry => entry.date), ['2026-07-27']);
    assert.equal(payload.entries[0].input, 1);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('stats clamps abusive weekly and clock env vars', () => {
  const file = tmpStatsFile('clamp-env');
  const prevStatsEnv = process.env.MISER_STATS_FILE;
  const prevWeeklyEnv = process.env.MISER_WEEKLY_STATS_MAX_WEEKS;
  const prevPastEnv = process.env.MISER_STATS_CLOCK_PAST_DAYS;
  const prevFutureEnv = process.env.MISER_STATS_CLOCK_FUTURE_DAYS;
  try {
    const stats = freshStatsWithEnv(file, null, {
      MISER_WEEKLY_STATS_MAX_WEEKS: '9007199254740991',
      MISER_STATS_CLOCK_PAST_DAYS: '9007199254740991',
      MISER_STATS_CLOCK_FUTURE_DAYS: '9007199254740991',
    });
    assert.equal(stats.__test.WEEKLY_MAX_WEEKS, 260);
    assert.equal(stats.__test.CLOCK_PAST_MS, 730 * 24 * 60 * 60 * 1000);
    assert.equal(stats.__test.CLOCK_FUTURE_MS, 30 * 24 * 60 * 60 * 1000);
  } finally {
    if (prevWeeklyEnv === undefined) delete process.env.MISER_WEEKLY_STATS_MAX_WEEKS;
    else process.env.MISER_WEEKLY_STATS_MAX_WEEKS = prevWeeklyEnv;
    if (prevPastEnv === undefined) delete process.env.MISER_STATS_CLOCK_PAST_DAYS;
    else process.env.MISER_STATS_CLOCK_PAST_DAYS = prevPastEnv;
    if (prevFutureEnv === undefined) delete process.env.MISER_STATS_CLOCK_FUTURE_DAYS;
    else process.env.MISER_STATS_CLOCK_FUTURE_DAYS = prevFutureEnv;
    cleanup(file, prevStatsEnv);
  }
});
