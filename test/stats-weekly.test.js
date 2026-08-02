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
  const current = require.cache[statsPath] && require.cache[statsPath].exports;
  if (current && current.__resetForTest) current.__resetForTest();
  delete require.cache[statsPath];
  if (prevEnv === undefined) delete process.env.MISER_STATS_FILE;
  else process.env.MISER_STATS_FILE = prevEnv;
  try { fs.unlinkSync(file); } catch (_) {}
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForPersistedJson(file, predicate, label) {
  const deadline = Date.now() + 2000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (predicate(last)) return last;
    } catch (_) {}
    await delay(10);
  }
  assert.fail(`${label}; last=${JSON.stringify(last)}`);
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

// A CHANGING injected clock whose second read has already crossed UTC
// midnight. Code that captures `now` once sees only instants[0]; code that
// re-reads the clock mid-answer sees the rollover and derives a different day
// for part of the result. `clock.reads` is the proof of single capture: a
// correct read path leaves it at length 1.
function rolloverClock(instants) {
  const reads = [];
  const clock = () => {
    const iso = instants[Math.min(reads.length, instants.length - 1)];
    reads.push(iso);
    return new Date(iso);
  };
  clock.reads = reads;
  return clock;
}

function sparseStatsWithRecordingStart(recordingStartedAt, entries = {}) {
  return {
    __meta: { recordingStartedAt },
    ...entries,
  };
}

function sparseStatsWithLegacyWatermark(watermark, entries = {}) {
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

test('usage before Sunday reset keeps the same subscription week after flush and reload', async () => {
  const cases = [
    {
      label: 'cdt',
      eventIso: '2026-07-26T01:00:00.000Z',
      utcDayKey: '2026-07-26',
      persistedDayKey: '2026-07-25',
      weekKey: '2026-07-19T11:00:00.000Z',
    },
    {
      label: 'cst',
      eventIso: '2026-01-04T07:00:00.000Z',
      utcDayKey: '2026-01-04',
      persistedDayKey: '2026-01-03',
      weekKey: '2025-12-28T12:00:00.000Z',
    },
  ];

  for (const fixture of cases) {
    const file = tmpStatsFile(`boundary-round-trip-${fixture.label}`);
    const prevEnv = process.env.MISER_STATS_FILE;
    let stats;
    try {
      const event = new Date(fixture.eventIso);
      stats = freshStats(file);
      stats.__test.setNowFnForTest(() => event);

      assert.equal(stats.__test.subscriptionWeekKeyFromDate(event), fixture.weekKey);
      stats.recordAnthropicUsage(
        'alpha',
        'anthropic',
        'claude-sonnet-4',
        { input_tokens: 10, output_tokens: 2 },
        null,
        () => event,
      );

      const live = stats.__test.getUnreconciledStatsSnapshotForTest();
      assert.equal(live[fixture.persistedDayKey].alpha.usage.anthropic['claude-sonnet-4'].input, 10);
      assert.equal(live[fixture.utcDayKey], undefined);
      assert.deepEqual(Object.keys(live.__weekly || {}).sort(), [fixture.weekKey]);
      assert.equal(live.__weekly[fixture.weekKey].alpha.usage.anthropic['claude-sonnet-4'].input, 10);

      await stats.flushNow();
      const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(persisted[fixture.persistedDayKey].alpha.usage.anthropic['claude-sonnet-4'].input, 10);
      assert.equal(persisted[fixture.utcDayKey], undefined);
      assert.deepEqual(Object.keys(persisted.__weekly || {}).sort(), [fixture.weekKey]);
      assert.equal(persisted.__weekly[fixture.weekKey].alpha.usage.anthropic['claude-sonnet-4'].input, 10);

      stats.__resetForTest();
      delete require.cache[statsPath];
      stats = freshStats(file);
      stats.__test.setNowFnForTest(() => event);
      const reconciled = stats.getRawStatsSnapshot();
      assert.deepEqual(Object.keys(reconciled.__weekly || {}).sort(), [fixture.weekKey]);
      assert.equal(reconciled.__weekly[fixture.weekKey].alpha.usage.anthropic['claude-sonnet-4'].input, 10);

      const result = stats.getStats('9999');
      assert.equal(result.weekly.currentWeekToDate.weekStart, fixture.weekKey);
      assert.equal(result.weekly.currentWeekToDate.usage.alpha.anthropic['claude-sonnet-4'].input, 10);
    } finally {
      if (stats && stats.__resetForTest) stats.__resetForTest();
      cleanup(file, prevEnv);
    }
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
    const priorWeekDate = new Date('2026-07-25T15:00:00.000Z');
    const currentWeekKey = '2026-07-26T11:00:00.000Z';
    const priorWeekKey = '2026-07-19T11:00:00.000Z';

    stats.recordAnthropicUsage('alpha', 'anthropic', 'claude-sonnet-4', { input_tokens: 10 }, null, () => now);
    stats.recordStats('alpha', { inputTokensRemoved: 3, techniques: { dedup: true } }, () => now);
    stats.recordAnthropicUsage('alpha', 'anthropic', 'claude-sonnet-4', { output_tokens: 2 }, null, () => priorWeekDate);

    stats.__test.setNowFnForTest(() => now);
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
      '2026-07-06': { alpha: { usage: { anthropic: { model: { input: 1 } } } } },
      '2026-07-13': { alpha: { usage: { anthropic: { model: { input: 2 } } } } },
      '2026-07-20': { alpha: { usage: { anthropic: { model: { input: 3 } } } } },
      '2026-07-27': { alpha: { usage: { anthropic: { model: { input: 4 } } } } },
      __weekly: {
        '2026-07-05T11:00:00.000Z': { alpha: { usage: { anthropic: { model: { input: 1 } } } } },
        '2026-07-12T11:00:00.000Z': { alpha: { usage: { anthropic: { model: { input: 2 } } } } },
        '2026-07-19T11:00:00.000Z': { alpha: { usage: { anthropic: { model: { input: 3 } } } } },
        '2026-07-26T11:00:00.000Z': { alpha: { usage: { anthropic: { model: { input: 4 } } } } },
      },
    }, { MISER_WEEKLY_STATS_MAX_WEEKS: '2' });

    stats.__test.setNowFnForTest(() => new Date('2026-07-28T15:00:00.000Z'));
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

test('daily stats with no meta derive recordingStartedAt and backfill weekly buckets from observed keys', async () => {
  const file = tmpStatsFile('migration');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file, {
      '2026-07-19': {
        alpha: {
          usage: { anthropic: { model: { cacheRead: 2, requests: 1 } } },
        },
      },
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
    const snapshot = stats.getRawStatsSnapshot();
    assert.equal(snapshot.__meta.recordingStartedAt, '2026-07-19');
    await stats.flushNow();
    const weekly = stats.getStats('9999').weekly.priorCompleteWeeks
      .find(week => week.weekStart === '2026-07-19T11:00:00.000Z');
    assert.ok(weekly, 'backfilled prior week should be exposed');
    assert.equal(weekly.usage.alpha.anthropic.model.cacheRead, 2);
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
    assert.equal(weekly.nonAuthoritativeReason, 'missing_daily_observation');
    assert.deepEqual(weekly.coverage.presentDays, ['2026-07-19', '2026-07-20', '2026-07-21']);
    assert.deepEqual(weekly.coverage.missingDays, ['2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25']);

    const persisted = await waitForPersistedJson(
      file,
      data => data && data.__meta && data.__meta.recordingStartedAt === '2026-07-19',
      'derived recordingStartedAt should persist without explicit flushNow',
    );
    assert.equal(persisted.__meta.recordingStartedAt, '2026-07-19');
  } finally {
    cleanup(file, prevEnv);
  }
});

test('existing empty, partial, array, and stale weekly buckets are reconciled from daily stats', () => {
  const prevEnv = process.env.MISER_STATS_FILE;
  const weekKey = '2026-07-19T11:00:00.000Z';
  const daily = sparseStatsWithRecordingStart('2026-07-19', {
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
    const stats = freshStats(file, sparseStatsWithRecordingStart('2026-07-19', {
      '2026-07-19': {},
      '2026-07-20': {
        alpha: {
          usage: { anthropic: { model: { input: 5, output: 3, requests: 1 } } },
          dedup: { estRemovedTokens: 7, inputTokensRemoved: 7, cacheBillingDelta: 0, appliedCount: 1 },
          likelyPollCount: 1,
          budget: { blockedCount: 2, firstBlockedAt: '2026-07-20T14:00:00.000Z' },
          policy: { modelDriftCount: 1, contextBloatCount: 1 },
        },
      },
      '2026-07-21': {},
      '2026-07-22': {},
      '2026-07-23': {},
      '2026-07-24': {},
      '2026-07-25': {},
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

test('partial daily coverage drops stored weekly value and marks it non-authoritative', () => {
  const file = tmpStatsFile('migration-partial-coverage');
  const prevEnv = process.env.MISER_STATS_FILE;
  const weekKey = '2026-07-19T11:00:00.000Z';
  try {
    const stats = freshStats(file, sparseStatsWithRecordingStart('2026-07-20', {
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
    assert.equal(rawWeek.__meta.authoritative, false);
    assert.equal(rawWeek.__meta.reason, 'missing_daily_observation');
    assert.deepEqual(rawWeek.__meta.coverage.presentDays, ['2026-07-20', '2026-07-21']);
    assert.deepEqual(rawWeek.__meta.coverage.missingDays, [
      '2026-07-19',
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
    ]);
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
    assert.equal(exposed.nonAuthoritativeReason, 'missing_daily_observation');
    assert.equal(exposed.usage.alpha.anthropic.model.input, 30);
    assert.deepEqual(exposed.coverage.presentDays, ['2026-07-20', '2026-07-21']);
    assert.deepEqual(exposed.coverage.missingDays, [
      '2026-07-19',
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
    ]);
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
    const stats = freshStats(file, sparseStatsWithRecordingStart('2026-07-20', {
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
    assert.equal(rawWeek.__meta.reason, 'missing_daily_observation');
    assert.deepEqual(rawWeek.__meta.coverage.presentDays, ['2026-07-20', '2026-07-21']);
    assert.deepEqual(rawWeek.__meta.coverage.missingDays, [
      '2026-07-19',
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
    ]);

    const exposed = stats.getStats('9999').weekly.priorCompleteWeeks
      .find(week => week.weekStart === weekKey);
    assert.equal(exposed.authoritative, false);
    assert.equal(exposed.degraded, true);
    assert.equal(exposed.nonAuthoritativeReason, 'missing_daily_observation');
    assert.deepEqual(exposed.coverage.missingDays, [
      '2026-07-19',
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

test('missing completed week after recording start is exposed non-authoritative', () => {
  const file = tmpStatsFile('missing-complete-week');
  const prevEnv = process.env.MISER_STATS_FILE;
  const missingWeekKey = '2026-07-19T11:00:00.000Z';
  try {
    const stats = freshStats(file, sparseStatsWithRecordingStart('2026-07-12', {
      '2026-07-12': {},
      '2026-07-13': {},
      '2026-07-14': {},
      '2026-07-15': {},
      '2026-07-16': {},
      '2026-07-17': {},
      '2026-07-18': {},
      '2026-07-26': {},
      '2026-07-27': {},
      '2026-07-28': {},
    }));
    stats.__test.setNowFnForTest(() => new Date('2026-07-28T15:00:00.000Z'));

    const result = stats.getStats('9999');
    const missing = result.weekly.priorCompleteWeeks.find(week => week.weekStart === missingWeekKey);
    assert.ok(missing, 'missing completed week should be exposed');
    assert.equal(missing.authoritative, false);
    assert.equal(missing.nonAuthoritativeReason, 'missing_daily_observation');
    assert.deepEqual(missing.coverage.presentDays, []);
    assert.deepEqual(missing.coverage.missingDays, [
      '2026-07-19',
      '2026-07-20',
      '2026-07-21',
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
    ]);
    assert.equal(result.nonAuthoritativeWeekCount, 1);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('retained weeks after the recording-start cap are exposed non-authoritative', () => {
  const file = tmpStatsFile('missing-complete-week-after-cap');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file, sparseStatsWithRecordingStart('2025-01-05'));
    stats.__test.setNowFnForTest(() => new Date('2027-03-16T15:00:00.000Z'));
    const missingWeekKey = stats.__test.subscriptionWeekKeyFromDate(new Date('2027-03-07T15:00:00.000Z'));

    const result = stats.getStats('9999');
    const missing = result.weekly.priorCompleteWeeks.find(week => week.weekStart === missingWeekKey);
    assert.ok(missing, 'missing retained week after the old iteration cap should be exposed');
    assert.equal(result.weekly.priorCompleteWeeks.length, stats.__test.WEEKLY_MAX_WEEKS);
    assert.equal(missing.authoritative, false);
    assert.equal(missing.degraded, true);
    assert.equal(missing.nonAuthoritativeReason, 'missing_daily_observation');
    assert.deepEqual(missing.coverage.presentDays, []);
    assert.deepEqual(missing.coverage.missingDays, [
      '2027-03-07',
      '2027-03-08',
      '2027-03-09',
      '2027-03-10',
      '2027-03-11',
      '2027-03-12',
      '2027-03-13',
    ]);
    assert.equal(result.weekly.currentWeekToDate.authoritative, false);
    assert.equal(result.weekly.currentWeekToDate.nonAuthoritativeReason, 'missing_daily_observation');
    assert.equal(result.nonAuthoritativeWeekCount, stats.__test.WEEKLY_MAX_WEEKS + 1);
    assert.deepEqual(result.nonAuthoritativeReasons, ['missing_daily_observation']);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('legacy-only daily retention watermark is deleted without using it as recording boundary', async () => {
  const file = tmpStatsFile('legacy-recording-start-migration');
  const prevEnv = process.env.MISER_STATS_FILE;
  const weekKey = '2026-07-19T11:00:00.000Z';
  const sealedDay = '2026-07-28';
  try {
    const stats = freshStats(file, sparseStatsWithLegacyWatermark('2026-07-20', {
      '2026-07-20': {
        alpha: { usage: { anthropic: { model: { input: 10, requests: 1 } } } },
      },
    }));
    stats.__test.setNowFnForTest(() => new Date(`${sealedDay}T15:00:00.000Z`));

    const snapshot = stats.getRawStatsSnapshot();
    assert.equal(snapshot.__meta.recordingStartedAt, undefined);
    assert.equal(snapshot.__meta.dailyRetentionWatermark, undefined);
    assert.equal(stats.__test.getRecordingStartedAt(snapshot), null);
    await stats.flushNow();

    const exposed = stats.getStats('9999').weekly.priorCompleteWeeks
      .find(week => week.weekStart === weekKey);
    assert.equal(exposed.authoritative, false);
    assert.equal(exposed.degraded, true);
    assert.equal(exposed.nonAuthoritativeReason, 'missing_daily_observation');

    const persisted = await waitForPersistedJson(
      file,
      data => data && data.__meta && data.__meta.dailyRetentionWatermark === undefined,
      'stale legacy boundary deletion should persist without explicit flushNow',
    );
    assert.equal(persisted.__meta.recordingStartedAt, sealedDay);
    assert.equal(persisted.__meta.dailyRetentionWatermark, undefined);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('clean successful load seals today and persists without explicit flushNow', async () => {
  const file = tmpStatsFile('clean-load-no-write');
  const prevEnv = process.env.MISER_STATS_FILE;
  const fsp = require('node:fs/promises');
  const originalWriteFile = fsp.writeFile;
  const sealedDay = '2026-07-28';
  const seed = {
    __meta: { recordingStartedAt: '2026-07-20' },
    '2026-07-20': {
      alpha: { usage: { anthropic: { model: { input: 10, requests: 1 } } } },
    },
  };
  const originalBytes = JSON.stringify(seed);
  let writeCalls = 0;
  try {
    fs.writeFileSync(file, originalBytes, 'utf8');
    fsp.writeFile = async (...args) => {
      writeCalls += 1;
      return originalWriteFile.apply(fsp, args);
    };
    const stats = freshStats(file);
    stats.__test.setNowFnForTest(() => new Date(`${sealedDay}T15:00:00.000Z`));
    const persisted = await waitForPersistedJson(
      file,
      data => data && data[sealedDay] && data.__meta.recordingStartedAt === '2026-07-20',
      'startup seal should persist today without explicit flushNow',
    );
    assert.ok(writeCalls >= 1);
    assert.deepEqual(persisted[sealedDay], {});
  } finally {
    fsp.writeFile = originalWriteFile;
    cleanup(file, prevEnv);
  }
});

test('empty install startup seal writes the pinned simulated day and becomes durable', async () => {
  const file = tmpStatsFile('startup-seal-empty');
  const prevEnv = process.env.MISER_STATS_FILE;
  const sealedDay = '2026-07-28';
  try {
    const stats = freshStats(file, {});
    stats.__test.setNowFnForTest(() => new Date(`${sealedDay}T15:00:00.000Z`));
    const persisted = await waitForPersistedJson(
      file,
      data => data && data[sealedDay] && data.__meta && data.__meta.recordingStartedAt === sealedDay,
      'empty startup seal should persist today without explicit flushNow',
    );
    assert.deepEqual(persisted[sealedDay], {});

    assert.equal(stats.getPersistenceStatus().healthy, true);
    assert.equal(stats.getPersistenceStatus().durable, true);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('observation seal writes the simulated day, not the real wall-clock day', () => {
  const file = tmpStatsFile('seal-simulated-not-real');
  const prevEnv = process.env.MISER_STATS_FILE;
  const realDay = new Date().toISOString().slice(0, 10);
  const simulatedDay = '2000-02-03';
  assert.notEqual(simulatedDay, realDay, 'test requires simulated day to differ from the wall clock');
  try {
    const stats = freshStats(file, {});
    stats.__test.setNowFnForTest(() => new Date(`${simulatedDay}T15:00:00.000Z`));
    stats.__test.sealTodayObserved();

    const snapshot = stats.getRawStatsSnapshot();
    assert.deepEqual(snapshot[simulatedDay], {});
    assert.equal(snapshot[realDay], undefined);
    assert.equal(snapshot.__meta.recordingStartedAt, simulatedDay);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('observation seal interval is unrefd', () => {
  const file = tmpStatsFile('seal-unref');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file, {});
    const timer = stats.__test._observationSeal.intervalTimer;
    assert.ok(timer, 'seal interval should be installed');
    if (typeof timer.hasRef === 'function') assert.equal(timer.hasRef(), false);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('fully observed week with degraded persistence is non-authoritative', () => {
  const file = tmpStatsFile('weekly-persistence-degraded');
  const prevEnv = process.env.MISER_STATS_FILE;
  const weekKey = '2026-07-19T11:00:00.000Z';
  try {
    const stats = freshStats(file, sparseStatsWithRecordingStart('2026-07-19', {
      '2026-07-19': {},
      '2026-07-20': { alpha: { usage: { anthropic: { model: { input: 3, requests: 1 } } } } },
      '2026-07-21': {},
      '2026-07-22': {},
      '2026-07-23': {},
      '2026-07-24': {},
      '2026-07-25': {},
    }));

    stats.scheduleFlush(false, 60000);
    const result = stats.getStats('9999');
    const week = result.weekly.priorCompleteWeeks.find(item => item.weekStart === weekKey);
    assert.equal(week.authoritative, false);
    assert.equal(week.nonAuthoritativeReason, 'persistence_degraded');
    assert.equal(result.weeklyAuthoritative, false);
    assert.deepEqual(result.nonAuthoritativeReasons, ['persistence_degraded']);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('failed load does not write even after a retained mutation and flush attempt', async () => {
  const file = tmpStatsFile('failed-load-no-write');
  const prevEnv = process.env.MISER_STATS_FILE;
  const fsp = require('node:fs/promises');
  const originalWriteFile = fsp.writeFile;
  const originalBytes = '{not json';
  let writeCalls = 0;
  const originalWarn = console.warn;
  const originalError = console.error;
  try {
    fs.writeFileSync(file, originalBytes, 'utf8');
    fsp.writeFile = async (...args) => {
      writeCalls += 1;
      return originalWriteFile.apply(fsp, args);
    };
    console.warn = () => {};
    console.error = () => {};
    const stats = freshStats(file);
    stats.recordStats('alpha', { inputTokensRemoved: 1, techniques: { dedup: true } });
    const result = await stats.flushNow();
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'LOAD_ERROR');
    assert.equal(writeCalls, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), originalBytes);
    assert.equal(stats.getPersistenceStatus().lastLoadErrored, true);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    fsp.writeFile = originalWriteFile;
    cleanup(file, prevEnv);
  }
});

test('derived recordingStartedAt is not lowered by a later older-day record', () => {
  const file = tmpStatsFile('derived-recording-start-monotonic');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file, {
      '2026-07-20': {
        alpha: { usage: { anthropic: { model: { input: 10, requests: 1 } } } },
      },
    });
    assert.equal(stats.getRawStatsSnapshot().__meta.recordingStartedAt, '2026-07-20');

    stats.recordAnthropicUsage(
      'alpha',
      'anthropic',
      'claude-sonnet-4',
      { output_tokens: 7 },
      null,
      () => new Date('2026-07-19T15:00:00.000Z'),
    );

    const snapshot = stats.getRawStatsSnapshot();
    assert.equal(snapshot.__meta.recordingStartedAt, '2026-07-20');
    assert.equal(snapshot['2026-07-19'].alpha.usage.anthropic['claude-sonnet-4'].output, 7);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('empty daily stats have missing daily observation coverage until a day is observed', () => {
  const file = tmpStatsFile('empty-no-boundary');
  const prevEnv = process.env.MISER_STATS_FILE;
  const weekKey = '2026-07-19T11:00:00.000Z';
  try {
    const stats = freshStats(file, {});
    const snapshot = stats.getRawStatsSnapshot();
    assert.equal(snapshot.__meta, undefined);
    assert.equal(stats.__test.getRecordingStartedAt(snapshot), null);

    // Explicit instant, not the ambient clock: the expected-day set below is
    // only correct for an observer standing at the end of that week.
    const coverage = stats.__test.dailyCoverageForWeek(snapshot, weekKey, new Date('2026-07-25T23:00:00.000Z'));
    assert.equal(coverage.complete, false);
    assert.deepEqual(coverage.presentDays, []);
    assert.deepEqual(coverage.missingDays, [
      '2026-07-19',
      '2026-07-20',
      '2026-07-21',
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
    ]);
    assert.deepEqual(coverage.expectedDays, [
      '2026-07-19',
      '2026-07-20',
      '2026-07-21',
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
    ]);
  } finally {
    cleanup(file, prevEnv);
  }
});

for (const fixture of [
  { label: 'empty state', seed: {} },
  { label: 'recordingStartedAt null', seed: { __meta: { recordingStartedAt: null } } },
  {
    label: 'recordingStartedAt invalid',
    seed: sparseStatsWithRecordingStart('not-a-day', {
      '2026-07-19': {},
      '2026-07-20': {},
      '2026-07-21': {},
      '2026-07-22': {},
      '2026-07-23': {},
      '2026-07-24': {},
      '2026-07-25': {},
    }),
  },
]) {
  test(`getStats marks current week non-authoritative for ${fixture.label}`, () => {
    const file = tmpStatsFile(`current-week-no-boundary-${fixture.label.replace(/[^a-z0-9]/gi, '-')}`);
    const prevEnv = process.env.MISER_STATS_FILE;
    try {
      const stats = freshStats(file, fixture.seed);
      stats.__test.setNowFnForTest(() => new Date('2026-07-28T15:00:00.000Z'));

      const result = stats.getStats('9999');
      assert.equal(result.weeklyAuthoritative, false);
      assert.equal(result.weekly.authoritative, false);
      assert.equal(result.weekly.currentWeekToDate.weekStart, '2026-07-26T11:00:00.000Z');
      assert.equal(result.weekly.currentWeekToDate.authoritative, false);
      assert.equal(result.weekly.currentWeekToDate.degraded, true);
      assert.equal(result.weekly.currentWeekToDate.nonAuthoritativeReason, 'missing_daily_observation');
      assert.deepEqual(result.weekly.currentWeekToDate.coverage.presentDays, []);
      assert.deepEqual(result.weekly.currentWeekToDate.coverage.missingDays, [
        '2026-07-26',
        '2026-07-27',
        '2026-07-28',
      ]);
    } finally {
      cleanup(file, prevEnv);
    }
  });
}

test('fresh install first mid-week write marks earlier current-week days not observed, from a single captured clock', async () => {
  const file = tmpStatsFile('runtime-first-mid-week');
  const prevEnv = process.env.MISER_STATS_FILE;
  const weekKey = '2026-07-26T11:00:00.000Z';
  const now = () => new Date('2026-07-28T23:59:59.900Z');
  try {
    const stats = freshStats(file);
    stats.__test.setNowFnForTest(now);
    stats.recordAnthropicUsage(
      'alpha',
      'anthropic',
      'claude-sonnet-4',
      { input_tokens: 12 },
      null,
      now,
    );
    await stats.flushNow();

    // Swap in a clock that rolls into 2026-07-29 on its SECOND read. The read
    // below must answer entirely from the first instant: if any part of the
    // weekly path re-reads the clock, 2026-07-29 appears as an expected-but-
    // missing day and the coverage assertions change.
    const clock = rolloverClock(['2026-07-28T23:59:59.999Z', '2026-07-29T00:00:00.001Z']);
    stats.__test.setNowFnForTest(clock);

    const result = stats.getStats('9999');
    assert.equal(
      clock.reads.length,
      1,
      `getStats() must capture the clock exactly once; reads=${JSON.stringify(clock.reads)}`,
    );
    const current = result.weekly.currentWeekToDate;
    assert.equal(current.weekStart, weekKey);
    assert.equal(current.authoritative, false);
    assert.equal(current.degraded, true);
    assert.equal(current.nonAuthoritativeReason, 'missing_daily_observation');
    assert.deepEqual(current.coverage.presentDays, ['2026-07-28']);
    // 2026-07-29 must NOT appear here: it is only "expected" to an observer
    // that re-read the clock after the rollover.
    assert.deepEqual(current.coverage.missingDays, ['2026-07-26', '2026-07-27']);
    assert.equal(current.usage.alpha.anthropic['claude-sonnet-4'].input, 12);
    assert.equal(result.weekly.authoritative, false);

    const snapshot = stats.getRawStatsSnapshot();
    assert.equal(snapshot.__weekly[weekKey].__meta.authoritative, false);
    assert.equal(snapshot.__weekly[weekKey].__meta.reason, 'missing_daily_observation');
  } finally {
    cleanup(file, prevEnv);
  }
});

test('recordingStartedAt is write-once and older records do not cover intervening missing days', async () => {
  const file = tmpStatsFile('recording-start-monotonic');
  const prevEnv = process.env.MISER_STATS_FILE;
  const weekKey = '2026-07-19T11:00:00.000Z';
  try {
    const stats = freshStats(file);
    stats.__test.setNowFnForTest(() => new Date('2026-07-28T15:00:00.000Z'));
    stats.recordAnthropicUsage(
      'alpha',
      'anthropic',
      'claude-sonnet-4',
      { input_tokens: 22 },
      null,
      () => new Date('2026-07-22T15:00:00.000Z'),
    );

    const before = stats.getRawStatsSnapshot();
    assert.equal(before.__meta.recordingStartedAt, '2026-07-22');

    stats.recordAnthropicUsage(
      'alpha',
      'anthropic',
      'claude-sonnet-4',
      { input_tokens: 19 },
      null,
      () => new Date('2026-07-19T15:00:00.000Z'),
    );
    await stats.flushNow();

    const after = stats.getRawStatsSnapshot();
    assert.equal(after.__meta.recordingStartedAt, '2026-07-22');
    assert.equal(after['2026-07-19'].alpha.usage.anthropic['claude-sonnet-4'].input, 19);
    assert.equal(after['2026-07-22'].alpha.usage.anthropic['claude-sonnet-4'].input, 22);
    assert.equal(after.__weekly[weekKey].alpha.usage.anthropic['claude-sonnet-4'].input, 41);
    assert.equal(after.__weekly[weekKey].__meta.authoritative, false);
    assert.equal(after.__weekly[weekKey].__meta.reason, 'missing_daily_observation');
    assert.deepEqual(after.__weekly[weekKey].__meta.coverage.presentDays, ['2026-07-19', '2026-07-22']);
    assert.deepEqual(after.__weekly[weekKey].__meta.coverage.missingDays, [
      '2026-07-20',
      '2026-07-21',
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
    ]);

    const result = stats.getStats('9999');
    const exposed = result.weekly.priorCompleteWeeks.find(week => week.weekStart === weekKey);
    assert.equal(exposed.authoritative, false);
    assert.equal(exposed.nonAuthoritativeReason, 'missing_daily_observation');
    assert.deepEqual(exposed.coverage.missingDays, [
      '2026-07-20',
      '2026-07-21',
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
    ]);
    assert.equal(result.weeklyAuthoritative, false);
    assert.equal(result.nonAuthoritativeWeekCount, 2);
    assert.deepEqual(result.nonAuthoritativeReasons, ['missing_daily_observation']);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('sparse quiet-day gaps replace stored weekly value and stay non-authoritative', () => {
  const file = tmpStatsFile('migration-complete-coverage');
  const prevEnv = process.env.MISER_STATS_FILE;
  const weekKey = '2026-07-19T11:00:00.000Z';
  try {
    const stats = freshStats(file, sparseStatsWithRecordingStart('2026-07-19', {
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
    assert.equal(rawWeek.__meta.authoritative, false);
    assert.equal(rawWeek.__meta.reason, 'missing_daily_observation');
    assert.deepEqual(rawWeek.__meta.coverage.presentDays, ['2026-07-20', '2026-07-21']);
    assert.deepEqual(rawWeek.__meta.coverage.missingDays, [
      '2026-07-19',
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
    ]);

    const exposed = stats.getStats('9999').weekly.priorCompleteWeeks
      .find(week => week.weekStart === weekKey);
    assert.equal(exposed.authoritative, false);
    assert.equal(exposed.degraded, true);
    assert.equal(exposed.nonAuthoritativeReason, 'missing_daily_observation');
    assert.deepEqual(exposed.coverage.missingDays, [
      '2026-07-19',
      '2026-07-22',
      '2026-07-23',
      '2026-07-24',
      '2026-07-25',
    ]);
    assert.equal(exposed.usage.alpha.anthropic.model.input, 30);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('current partially elapsed week stays authoritative across a UTC-midnight rollover mid-read', () => {
  const file = tmpStatsFile('migration-current-week');
  const prevEnv = process.env.MISER_STATS_FILE;
  const weekKey = '2026-07-26T11:00:00.000Z';
  try {
    const stats = freshStats(file, sparseStatsWithRecordingStart('2026-07-26', {
      '2026-07-26': {},
      '2026-07-27': {
        alpha: { usage: { anthropic: { model: { input: 4, requests: 1 } } } },
      },
      '2026-07-28': {},
      __weekly: {
        [weekKey]: {
          alpha: { usage: { anthropic: { model: { input: 99, requests: 9 } } } },
        },
      },
    }));
    // Every elapsed day of the week is observed as of 2026-07-28T23:59:59.999Z,
    // so the week is authoritative. One instant later it is 2026-07-29, a day
    // with no observation yet. A request that reads the clock twice straddles
    // that line and reports the week as degraded on the strength of a day that
    // had not begun when the request started.
    const clock = rolloverClock(['2026-07-28T23:59:59.999Z', '2026-07-29T00:00:00.001Z']);
    stats.__test.setNowFnForTest(clock);

    const result = stats.getStats('9999');
    assert.equal(
      clock.reads.length,
      1,
      `getStats() must capture the clock exactly once; reads=${JSON.stringify(clock.reads)}`,
    );
    const current = result.weekly.currentWeekToDate;
    assert.equal(current.weekStart, weekKey);
    assert.equal(current.authoritative, true);
    assert.equal(current.degraded, false);
    assert.equal(current.nonAuthoritativeReason, undefined);
    assert.equal(current.coverage, undefined);
    assert.equal(current.usage.alpha.anthropic.model.input, 4);
    assert.equal(current.usage.alpha.anthropic.model.requests, 1);
    assert.equal(result.weekly.authoritative, true);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('real-file-shape migration treats existing 2026-07-14 through 2026-07-28 keys as observed', async () => {
  const file = tmpStatsFile('real-shape-migration');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const seed = {};
    for (let day = 14; day <= 28; day++) {
      const key = `2026-07-${String(day).padStart(2, '0')}`;
      seed[key] = {};
    }
    seed['2026-07-20'] = {
      optimizer: { dedup: { inputTokensRemoved: 3, estRemovedTokens: 3, cacheBillingDelta: 0, appliedCount: 1 } },
    };
    seed['2026-07-23'] = {
      usage: { usage: { anthropic: { model: { input: 5, requests: 1 } } } },
    };

    const stats = freshStats(file, seed);
    // Pin the clock: the seed observes days through 2026-07-28, so "the current
    // week is fully covered" is only true to an observer standing on
    // 2026-07-28. Left on the ambient clock this test asserted a fact about the
    // real calendar and went red on 2026-07-29.
    stats.__test.setNowFnForTest(() => new Date('2026-07-28T15:00:00.000Z'));
    const snapshot = stats.getRawStatsSnapshot();
    assert.equal(snapshot.__meta.recordingStartedAt, '2026-07-14');
    assert.deepEqual(
      Object.keys(snapshot).filter(key => stats.__test.isValidDailyKey(key)).sort(),
      [
        '2026-07-14',
        '2026-07-15',
        '2026-07-16',
        '2026-07-17',
        '2026-07-18',
        '2026-07-19',
        '2026-07-20',
        '2026-07-21',
        '2026-07-22',
        '2026-07-23',
        '2026-07-24',
        '2026-07-25',
        '2026-07-26',
        '2026-07-27',
        '2026-07-28',
      ],
    );
    await stats.flushNow();

    const result = stats.getStats('9999');
    const straddling = result.weekly.priorCompleteWeeks
      .find(week => week.weekStart === '2026-07-12T11:00:00.000Z');
    const complete = result.weekly.priorCompleteWeeks
      .find(week => week.weekStart === '2026-07-19T11:00:00.000Z');
    assert.equal(straddling.authoritative, false);
    assert.equal(straddling.nonAuthoritativeReason, 'missing_daily_observation');
    assert.deepEqual(straddling.coverage.missingDays, ['2026-07-12', '2026-07-13']);
    assert.equal(complete.authoritative, true);
    assert.equal(complete.nonAuthoritativeReason, undefined);
    assert.equal(result.weekly.currentWeekToDate.authoritative, true);
    assert.equal(result.weekly.currentWeekToDate.nonAuthoritativeReason, undefined);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('weekly reconciliation removes surplus stored projects and models from authoritative weeks', () => {
  const file = tmpStatsFile('migration-surplus');
  const prevEnv = process.env.MISER_STATS_FILE;
  const weekKey = '2026-07-19T11:00:00.000Z';
  try {
    const stats = freshStats(file, sparseStatsWithRecordingStart('2026-07-19', {
      '2026-07-19': {},
      '2026-07-20': {
        alpha: {
          usage: { anthropic: { model: { input: 5, requests: 1 } } },
        },
      },
      '2026-07-21': {},
      '2026-07-22': {},
      '2026-07-23': {},
      '2026-07-24': {},
      '2026-07-25': {},
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

test('valid stored weekly week with no daily backing is dropped on reconcile', () => {
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
    const snapshot = stats.getRawStatsSnapshot();
    assert.equal(snapshot.__weekly, undefined);

    const exposed = stats.getStats('9999').weekly.priorCompleteWeeks
      .find(week => week.weekStart === weekKey);
    assert.equal(exposed, undefined);
    assert.equal(stats.getStats('9999').weekly.priorCompleteWeeks.length, 0);
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
    stats.__test.setNowFnForTest(now);
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
      __meta: { recordingStartedAt: '2026-07-27' },
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
      __meta: { recordingStartedAt: '2026-07-27' },
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
