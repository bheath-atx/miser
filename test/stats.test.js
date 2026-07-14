'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const statsPath = require.resolve('../src/stats.js');

function tmpStatsFile(name) {
  return path.join(os.tmpdir(), `miser-test-stats-${process.pid}-${name}-${Date.now()}.json`);
}

function freshStats(file) {
  delete require.cache[statsPath];
  process.env.MISER_STATS_FILE = file;
  return require('../src/stats.js');
}

function cleanup(file, prevEnv) {
  delete require.cache[statsPath];
  if (prevEnv === undefined) {
    delete process.env.MISER_STATS_FILE;
  } else {
    process.env.MISER_STATS_FILE = prevEnv;
  }
  try { fs.unlinkSync(file); } catch (_) {}
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (f.startsWith(path.basename(file) + '.tmp.')) {
      try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (_) {}
    }
  }
}

function dayKey(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

test('recordStats persists across a simulated restart', () => {
  const file = tmpStatsFile('persist');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    let stats = freshStats(file);
    stats.recordStats('alpha', { inputTokensRemoved: 12, techniques: { dedup: true } });

    const loaded = stats.loadStats();
    assert.equal(loaded[dayKey()].alpha.dedup.inputTokensRemoved, 12);

    stats = freshStats(file);
    const result = stats.getStats('1');
    assert.equal(result.perProject.alpha.dedup.inputTokensRemoved, 12);
    assert.equal(result.perProject.alpha.dedup.appliedCount, 1);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('getStats returns correct per-technique totals for N days', () => {
  const file = tmpStatsFile('days');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    fs.writeFileSync(file, JSON.stringify({
      [dayKey()]: {
        alpha: {
          dedup: { inputTokensRemoved: 10, cacheBillingDelta: 0, appliedCount: 1 },
          cacheHint: { inputTokensRemoved: 0, cacheBillingDelta: 3, appliedCount: 1 },
          toolPrune: { inputTokensRemoved: 2, cacheBillingDelta: 0, appliedCount: 1 },
        },
      },
      [dayKey(-1)]: {
        beta: {
          dedup: { inputTokensRemoved: 5, cacheBillingDelta: 0, appliedCount: 1 },
          cacheHint: { inputTokensRemoved: 0, cacheBillingDelta: 7, appliedCount: 1 },
          toolPrune: { inputTokensRemoved: 1, cacheBillingDelta: 0, appliedCount: 1 },
        },
      },
      [dayKey(-8)]: {
        old: {
          dedup: { inputTokensRemoved: 100, cacheBillingDelta: 0, appliedCount: 1 },
        },
      },
    }), 'utf8');
    const stats = freshStats(file);
    const result = stats.getStats('2');
    assert.equal(result.days, 2);
    assert.equal(result.perTechnique.dedup.inputTokensRemoved, 15);
    assert.equal(result.perTechnique.cacheHint.cacheBillingDelta, 10);
    assert.equal(result.perTechnique.toolPrune.inputTokensRemoved, 3);
    // toolPrune.inputTokensRemoved is legacy data from the seeded file; totals excludes it
    assert.equal(result.totals.inputTokensRemoved, 15);
    assert.equal(result.totals.cacheBillingDelta, 10);
    assert.ok(!result.perProject.old);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('getStats supports project filter', () => {
  const file = tmpStatsFile('project');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file);
    stats.recordStats('alpha', { inputTokensRemoved: 8, techniques: { dedup: true } });
    stats.recordStats('beta', { inputTokensRemoved: 4, techniques: { dedup: true } });
    const result = stats.getStats('1', 'beta');
    assert.deepEqual(Object.keys(result.perProject), ['beta']);
    assert.equal(result.perTechnique.dedup.inputTokensRemoved, 4);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('getStats with malformed days throws 400', () => {
  const file = tmpStatsFile('bad-days');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file);
    assert.throws(() => stats.getStats('abc'), { statusCode: 400 });
  } finally {
    cleanup(file, prevEnv);
  }
});

for (const bad of ['0', '-1']) {
  test(`getStats with days=${bad} throws 400`, () => {
    const file = tmpStatsFile(`bad-${bad.replace('-', 'neg')}`);
    const prevEnv = process.env.MISER_STATS_FILE;
    try {
      const stats = freshStats(file);
      assert.throws(() => stats.getStats(bad), { statusCode: 400 });
    } finally {
      cleanup(file, prevEnv);
    }
  });
}

test('recordStats dedup-only increments only the dedup bucket', () => {
  const file = tmpStatsFile('dedup-only');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file);
    stats.recordStats('alpha', { inputTokensRemoved: 9, techniques: { dedup: true } });
    const result = stats.getStats('1');
    assert.equal(result.perProject.alpha.dedup.inputTokensRemoved, 9);
    assert.equal(result.perProject.alpha.cacheHint.appliedCount, 0);
    assert.equal(result.perProject.alpha.toolPrune.appliedCount, 0);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('recordStats cacheHint-only increments only the cacheHint bucket', () => {
  const file = tmpStatsFile('cache-only');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file);
    stats.recordStats('alpha', { cacheBillingDelta: 6, techniques: { cacheHint: true } });
    const result = stats.getStats('1');
    assert.equal(result.perProject.alpha.cacheHint.cacheBillingDelta, 6);
    assert.equal(result.perProject.alpha.cacheHint.appliedCount, 1);
    assert.equal(result.perProject.alpha.dedup.appliedCount, 0);
    assert.equal(result.perProject.alpha.toolPrune.appliedCount, 0);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('recordStats toolPrune-only increments only the toolPrune bucket', () => {
  const file = tmpStatsFile('prune-only');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file);
    stats.recordStats('alpha', { toolsRemoved: 3, techniques: { toolPrune: true } });
    const result = stats.getStats('1');
    assert.equal(result.perProject.alpha.toolPrune.toolsRemovedCount, 3);
    assert.equal(result.perProject.alpha.toolPrune.inputTokensRemoved, 0);
    assert.equal(result.perProject.alpha.toolPrune.appliedCount, 1);
    assert.equal(result.perProject.alpha.dedup.appliedCount, 0);
    assert.equal(result.perProject.alpha.cacheHint.appliedCount, 0);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('stats keep byte-removed and cache-billing counters separate', () => {
  const file = tmpStatsFile('separate');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file);
    stats.recordStats('alpha', { inputTokensRemoved: 11, techniques: { dedup: true } });
    stats.recordStats('alpha', { cacheBillingDelta: 13, techniques: { cacheHint: true } });
    const result = stats.getStats('1');
    assert.equal(result.perProject.alpha.dedup.inputTokensRemoved, 11);
    assert.equal(result.perProject.alpha.dedup.cacheBillingDelta, 0);
    assert.equal(result.perProject.alpha.cacheHint.inputTokensRemoved, 0);
    assert.equal(result.perProject.alpha.cacheHint.cacheBillingDelta, 13);
  } finally {
    cleanup(file, prevEnv);
  }
});
