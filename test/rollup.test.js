'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildRollupText,
  emitDailyRollup,
  shouldEmitNow,
} = require('../src/daily-rollup.js');

const rollupPath = require.resolve('../src/daily-rollup.js');

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function offsetDay(base, offset) {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + offset);
  return dayKey(d);
}

function usage(model, fields) {
  return { usage: { anthropic: { [model]: fields } } };
}

function tmpFile(name) {
  return path.join(os.tmpdir(), `miser-rollup-${process.pid}-${name}-${Date.now()}-${Math.random()}`);
}

function restoreEnv(prev) {
  if (prev.endpoint === undefined) delete process.env.MISER_PKACHU_ENDPOINT;
  else process.env.MISER_PKACHU_ENDPOINT = prev.endpoint;
  if (prev.token === undefined) delete process.env.MISER_PKACHU_TOKEN;
  else process.env.MISER_PKACHU_TOKEN = prev.token;
}

function freshRollupWithDedupEnv(file) {
  delete require.cache[rollupPath];
  process.env.MISER_ROLLUP_DEDUP_FILE = file;
  return require('../src/daily-rollup.js');
}

test('rollup baseline excludes today and fires anomaly above two times trailing average', () => {
  const now = new Date('2026-07-23T00:00:30Z');
  const stats = {
    [dayKey(now)]: {
      alpha: usage('claude-sonnet-4-6', { input: 3_000_000 }),
    },
  };
  for (let i = -7; i <= -1; i++) {
    stats[offsetDay(now, i)] = { alpha: usage('claude-sonnet-4-6', { input: 1_000_000 }) };
  }
  const text = buildRollupText(stats, now);
  assert.match(text, /week to date: 0 weighted tokens across miser-routed traffic/);
  assert.match(text, /fleet pace: NOT ALERTED/);
  assert.match(text, /alpha: 3\.00M weighted tokens .* \$9\.00 est/);
  assert.match(text, /alpha 2× baseline/);
});

test('rollup suppresses anomaly with fewer than three history days', () => {
  const now = new Date('2026-07-23T00:00:30Z');
  const stats = {
    [dayKey(now)]: {
      alpha: usage('claude-sonnet-4-6', { input: 10_000_000 }),
    },
    [offsetDay(now, -1)]: { alpha: usage('claude-sonnet-4-6', { input: 1 }) },
    [offsetDay(now, -2)]: { alpha: usage('claude-sonnet-4-6', { input: 1 }) },
  };
  const text = buildRollupText(stats, now);
  assert.doesNotMatch(text, /baseline/);
});

test('rollup sparse missing days count as zero in the seven-day denominator', () => {
  const now = new Date('2026-07-23T00:00:30Z');
  const stats = {
    [dayKey(now)]: {
      alpha: usage('claude-sonnet-4-6', { input: 1_000_000 }),
    },
    [offsetDay(now, -1)]: { alpha: usage('claude-sonnet-4-6', { input: 1_000_000 }) },
    [offsetDay(now, -3)]: { alpha: usage('claude-sonnet-4-6', { input: 1_000_000 }) },
    [offsetDay(now, -7)]: { alpha: usage('claude-sonnet-4-6', { input: 1_000_000 }) },
  };
  assert.match(buildRollupText(stats, now), /alpha 2× baseline/);
});

// ---------------------------------------------------------------------------
// Sprint B — guardrail rollup lines (sparse, appended after existing fields)
// ---------------------------------------------------------------------------

test('Sprint B: guardrail fields append to a usage line only when nonzero', () => {
  const now = new Date('2026-07-23T00:00:30Z');
  const stats = {
    [dayKey(now)]: {
      alpha: {
        ...usage('claude-sonnet-4-6', { input: 1_000_000 }),
        budget: { blockedCount: 1, firstBlockedAt: '2026-07-23T00:00:01.000Z' },
        policy: { modelDriftCount: 3, contextBloatCount: 0 },
      },
      beta: usage('claude-sonnet-4-6', { input: 1_000_000 }),
    },
  };
  const text = buildRollupText(stats, now);
  // Existing token fields preserved; blocked/drift appended; bloat omitted (zero).
  assert.match(text, /alpha: 1\.00M weighted tokens \(1000k input \/ 0k output \/ 0k cacheRead tokens; \$3\.00 est\) blocked:1 drift:3$/m);
  assert.doesNotMatch(text, /alpha.*bloat:/);
  // Untouched projects keep the exact legacy line shape.
  assert.match(text, /beta: 1\.00M weighted tokens \(1000k input \/ 0k output \/ 0k cacheRead tokens; \$3\.00 est\)$/m);
});

test('Sprint B: anomaly marker and guardrail fields coexist in order', () => {
  const now = new Date('2026-07-23T00:00:30Z');
  const stats = {
    [dayKey(now)]: {
      alpha: {
        ...usage('claude-sonnet-4-6', { input: 3_000_000 }),
        policy: { modelDriftCount: 0, contextBloatCount: 2 },
      },
    },
  };
  for (let i = -7; i <= -1; i++) {
    stats[offsetDay(now, i)] = { alpha: usage('claude-sonnet-4-6', { input: 1_000_000 }) };
  }
  const text = buildRollupText(stats, now);
  assert.match(text, /alpha: 3\.00M weighted tokens .* \$9\.00 est\) ⚠️ alpha 2× baseline bloat:2$/m);
});

test('Sprint B: guardrail-only project emits a $0.00 line with no token fields', () => {
  const now = new Date('2026-07-23T00:00:30Z');
  const stats = {
    [dayKey(now)]: {
      blockedproj: { budget: { blockedCount: 2, firstBlockedAt: '2026-07-23T00:00:01.000Z' } },
      driftproj: { policy: { modelDriftCount: 5, contextBloatCount: 1 } },
      quiet: {}, // no usage, no guardrail activity → NO line
    },
  };
  const text = buildRollupText(stats, now);
  assert.match(text, /^blockedproj: \$0\.00 blocked:2$/m);
  assert.match(text, /^driftproj: \$0\.00 drift:5 bloat:1$/m);
  assert.doesNotMatch(text, /quiet/);
  assert.doesNotMatch(text, /blockedproj.*tokens/); // no token fields without usage
});

test('Sprint B: zeroed guardrail nodes produce no rollup line for usage-less projects', () => {
  const now = new Date('2026-07-23T00:00:30Z');
  const stats = {
    [dayKey(now)]: {
      ghost: { policy: { modelDriftCount: 0, contextBloatCount: 0 } },
    },
  };
  assert.match(buildRollupText(stats, now), /fleet pace: NOT ALERTED/);
});

test('Fact B: rollup renders a scoped miser-routed cap fraction only when supplied', () => {
  const text = buildRollupText({}, new Date('2026-07-23T00:00:30Z'), {
    pace: { weightedRoutedConsumed: 250, routedConsumedFrac: 0.25 },
  });
  assert.match(text, /miser-routed 25\.0% of cap/);
  assert.doesNotMatch(text, /(^|[^-])% weekly/);
});

test('emitDailyRollup no-env no-ops and HTTP failure does not throw', async () => {
  const prev = { endpoint: process.env.MISER_PKACHU_ENDPOINT, token: process.env.MISER_PKACHU_TOKEN };
  const dedupFile = tmpFile('dedup');
  try {
    delete process.env.MISER_PKACHU_ENDPOINT;
    delete process.env.MISER_PKACHU_TOKEN;
    const stats = {
      '2026-07-23': {
        alpha: usage('claude-sonnet-4-6', { input: 1_000_000 }),
      },
    };
    const noEnv = await emitDailyRollup(stats, async () => { throw new Error('must not call'); }, {
      now: new Date('2026-07-23T00:00:30Z'),
      dedupFile,
    });
    assert.deepEqual(noEnv, { emitted: false, reason: 'no_env' });

    const tokenFile = tmpFile('token');
    fs.writeFileSync(tokenFile, 'tok', 'utf8');
    process.env.MISER_PKACHU_ENDPOINT = 'http://127.0.0.1:1/hook';
    process.env.MISER_PKACHU_TOKEN = tokenFile;
    const failed = await emitDailyRollup(stats, async () => { throw new Error('boom'); }, {
      now: new Date('2026-07-23T00:00:30Z'),
      dedupFile,
    });
    assert.equal(failed.emitted, false);
    assert.equal(failed.reason, 'post_failed');
    assert.equal(fs.existsSync(dedupFile), false);
    try { fs.unlinkSync(tokenFile); } catch (_) {}
  } finally {
    restoreEnv(prev);
    try { fs.unlinkSync(dedupFile); } catch (_) {}
  }
});

test('emitDailyRollup writes dedup marker after successful post and skips same UTC date', async () => {
  const prev = { endpoint: process.env.MISER_PKACHU_ENDPOINT, token: process.env.MISER_PKACHU_TOKEN };
  const dedupFile = tmpFile('dedup-success');
  const tokenFile = tmpFile('token-success');
  const calls = [];
  try {
    fs.writeFileSync(tokenFile, 'tok', 'utf8');
    process.env.MISER_PKACHU_ENDPOINT = 'http://127.0.0.1:1/hook';
    process.env.MISER_PKACHU_TOKEN = tokenFile;
    const stats = {
      '2026-07-23': {
        alpha: usage('claude-sonnet-4-6', { input: 1_000_000 }),
      },
    };
    const first = await emitDailyRollup(stats, async (endpoint, token, text) => {
      calls.push({ endpoint, token, text });
    }, { now: new Date('2026-07-23T00:00:30Z'), dedupFile });
    const second = await emitDailyRollup(stats, async () => {
      throw new Error('must not call');
    }, { now: new Date('2026-07-23T00:01:30Z'), dedupFile });
    assert.equal(first.emitted, true);
    assert.equal(second.reason, 'dedup');
    assert.equal(calls.length, 1);
    assert.equal(fs.readFileSync(dedupFile, 'utf8'), '2026-07-23');
  } finally {
    restoreEnv(prev);
    try { fs.unlinkSync(dedupFile); } catch (_) {}
    try { fs.unlinkSync(tokenFile); } catch (_) {}
  }
});

test('Fact B: unpriced-model rollup tick sends fleet-scoped alert', async () => {
  const prev = { endpoint: process.env.MISER_PKACHU_ENDPOINT, token: process.env.MISER_PKACHU_TOKEN };
  const dedupFile = tmpFile('dedup-unpriced');
  const tokenFile = tmpFile('token-unpriced');
  const alerts = [];
  try {
    fs.writeFileSync(tokenFile, 'tok', 'utf8');
    process.env.MISER_PKACHU_ENDPOINT = 'http://127.0.0.1:1/hook';
    process.env.MISER_PKACHU_TOKEN = tokenFile;
    const result = await emitDailyRollup({}, async () => {}, {
      now: new Date('2026-07-23T00:00:30Z'),
      dedupFile,
      pace: { degradedReasons: ['unpriced-models'], weightedRoutedConsumed: 0 },
      sendAlert: (text, opts) => alerts.push({ text, opts }),
    });
    assert.equal(result.emitted, true);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].opts.scope, 'fleet');
    assert.equal(alerts[0].opts.kind, 'unpriced-models');
  } finally {
    restoreEnv(prev);
    try { fs.unlinkSync(dedupFile); } catch (_) {}
    try { fs.unlinkSync(tokenFile); } catch (_) {}
  }
});

test('emitDailyRollup default dedup marker is isolated by MISER_ROLLUP_DEDUP_FILE', async () => {
  const prev = {
    endpoint: process.env.MISER_PKACHU_ENDPOINT,
    token: process.env.MISER_PKACHU_TOKEN,
    rollup: process.env.MISER_ROLLUP_DEDUP_FILE,
  };
  const dedupFile = tmpFile('dedup-env');
  const tokenFile = tmpFile('token-env');
  try {
    const rollup = freshRollupWithDedupEnv(dedupFile);
    fs.writeFileSync(tokenFile, 'tok', 'utf8');
    process.env.MISER_PKACHU_ENDPOINT = 'http://127.0.0.1:1/hook';
    process.env.MISER_PKACHU_TOKEN = tokenFile;
    const result = await rollup.emitDailyRollup({
      '2026-07-23': {
        alpha: usage('claude-sonnet-4-6', { input: 1_000_000 }),
      },
    }, async () => {}, { now: new Date('2026-07-23T00:00:30Z') });
    assert.equal(result.emitted, true);
    assert.equal(fs.readFileSync(dedupFile, 'utf8'), '2026-07-23');
    assert.equal(rollup.DEFAULT_DEDUP_FILE, dedupFile);
  } finally {
    if (prev.rollup === undefined) delete process.env.MISER_ROLLUP_DEDUP_FILE;
    else process.env.MISER_ROLLUP_DEDUP_FILE = prev.rollup;
    restoreEnv(prev);
    delete require.cache[rollupPath];
    require('../src/daily-rollup.js');
    try { fs.unlinkSync(dedupFile); } catch (_) {}
    try { fs.unlinkSync(tokenFile); } catch (_) {}
  }
});

test('rollup interval window is the first two UTC minutes after midnight', () => {
  assert.equal(shouldEmitNow(new Date('2026-07-23T00:01:59Z')), true);
  assert.equal(shouldEmitNow(new Date('2026-07-23T00:02:00Z')), false);
  assert.equal(shouldEmitNow(new Date('2026-07-23T23:59:00Z')), false);
});
