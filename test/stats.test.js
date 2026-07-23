'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const statsPath = require.resolve('../src/stats.js');
const preV4FixturePath = path.join(__dirname, 'fixtures-pre-v4-stats-snapshot.json');

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

test('recordStats persists across a simulated restart', async () => {
  const file = tmpStatsFile('persist');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    let stats = freshStats(file);
    stats.recordStats('alpha', { inputTokensRemoved: 12, techniques: { dedup: true } });
    await stats.flushNow();

    const loaded = stats.loadStats();
    assert.equal(loaded[dayKey()].alpha.dedup.inputTokensRemoved, 12);

    stats = freshStats(file);
    const result = stats.getStats('1');
    assert.equal(result.perProject.alpha.dedup.inputTokensRemoved, 12);
    assert.equal(result.perProject.alpha.dedup.estRemovedTokens, 12);
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

test('v4 M2: recordAnthropicUsage writes sparse provider/model usage and weighted equivalents', () => {
  const file = tmpStatsFile('usage');
  const prevEnv = process.env.MISER_STATS_FILE;
  const prevWarn = console.warn;
  const warns = [];
  console.warn = (line) => warns.push(String(line));
  try {
    const stats = freshStats(file);
    stats.recordAnthropicUsage('alpha', 'anthropic', 'claude-sonnet-4', {
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 30,
      cache_creation: {
        ephemeral_5m_input_tokens: 4,
        ephemeral_1h_input_tokens: 5,
      },
    });
    const result = stats.getStats('1');
    const bucket = result.usage.alpha.anthropic['claude-sonnet-4'];
    assert.deepEqual(bucket, {
      requests: 1,
      input: 10,
      output: 2,
      cacheRead: 30,
      cacheWrite5m: 4,
      cacheWrite1h: 5,
    });
    assert.equal(result.weightedTokenEquivalents.total, 38);
    assert.match(warns.join('\n'), /cacheWrite5m observed/);
  } finally {
    console.warn = prevWarn;
    cleanup(file, prevEnv);
  }
});

test('v4 M2: usage tree omits absent measurements instead of zero-filling', () => {
  const file = tmpStatsFile('sparse');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file);
    stats.recordAnthropicUsage('alpha', 'anthropic', 'unknown', { output_tokens: 9 });
    const bucket = stats.getStats('1').usage.alpha.anthropic.unknown;
    assert.deepEqual(bucket, { requests: 1, output: 9 });
    assert.ok(!('input' in bucket));
    assert.ok(!('cacheRead' in bucket));
  } finally {
    cleanup(file, prevEnv);
  }
});

test('v4 M2: legacy total cache_creation_input_tokens records as cacheWrite1h when nested TTLs are absent', () => {
  const file = tmpStatsFile('legacy-cache-creation');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file);
    stats.recordAnthropicUsage('alpha', 'anthropic', 'claude-legacy', {
      input_tokens: 8,
      cache_creation_input_tokens: 21,
    });
    const bucket = stats.getStats('1').usage.alpha.anthropic['claude-legacy'];
    assert.deepEqual(bucket, { requests: 1, input: 8, cacheWrite1h: 21 });
  } finally {
    cleanup(file, prevEnv);
  }
});

test('v4 M2: pure usage writes do not persist legacy technique zero buckets', async () => {
  const file = tmpStatsFile('usage-no-legacy');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file);
    stats.recordAnthropicUsage('alpha', 'anthropic', 'claude-sonnet-4', { output_tokens: 9 });
    await stats.flushNow();
    const raw = stats.loadStats();
    const rawProject = raw[dayKey()].alpha;
    assert.deepEqual(rawProject, {
      usage: {
        anthropic: {
          'claude-sonnet-4': { requests: 1, output: 9 },
        },
      },
    });
    assert.ok(!('dedup' in rawProject));
    assert.ok(!('cacheHint' in rawProject));
    assert.ok(!('toolPrune' in rawProject));
    assert.ok(!('likelyPollCount' in rawProject));
    assert.ok(!('workTurnCount' in rawProject));
  } finally {
    cleanup(file, prevEnv);
  }
});

test('v4 M2: context_management.applied_edits aggregate per project', () => {
  const file = tmpStatsFile('edits');
  const prevEnv = process.env.MISER_STATS_FILE;
  try {
    const stats = freshStats(file);
    stats.recordAnthropicUsage('alpha', 'anthropic', 'claude', {}, [
      { cleared_tool_uses: 2, cleared_input_tokens: 1000 },
      { cleared_tool_use_count: 1, cleared_input_tokens: 2000 },
    ]);
    const result = stats.getStats('1');
    assert.deepEqual(result.perProject.alpha.contextManagement, {
      clearedToolUses: 3,
      clearedInputTokens: 3000,
      editCount: 2,
    });
    assert.deepEqual(result.usage, {});
  } finally {
    cleanup(file, prevEnv);
  }
});

test('v4 M2: real pre-v4 stats fixture loads byte-compatible and usage stays absent', () => {
  const file = tmpStatsFile('legacy');
  const prevEnv = process.env.MISER_STATS_FILE;
  const fixtureRaw = fs.readFileSync(preV4FixturePath, 'utf8');
  const fixture = JSON.parse(fixtureRaw);
  try {
    fs.writeFileSync(file, fixtureRaw, 'utf8');
    const stats = freshStats(file);
    assert.deepEqual(stats.loadStats(), fixture);
    const result = stats.getStats('9999');
    assert.equal(result.perProject.default.dedup.inputTokensRemoved, 4149);
    assert.equal(result.perProject.default.dedup.appliedCount, 294);
    assert.equal(result.perProject.default.pollClass.likely, 5864);
    assert.equal(result.perProject.default.pollClass.work, 6400);
    assert.deepEqual(result.usage, {});
    assert.ok(!('usage' in result.perProject.default));
  } finally {
    cleanup(file, prevEnv);
  }
});
