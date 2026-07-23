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
  assert.match(text, /alpha: \$9\.00/);
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

test('rollup interval window is the first two UTC minutes after midnight', () => {
  assert.equal(shouldEmitNow(new Date('2026-07-23T00:01:59Z')), true);
  assert.equal(shouldEmitNow(new Date('2026-07-23T00:02:00Z')), false);
  assert.equal(shouldEmitNow(new Date('2026-07-23T23:59:00Z')), false);
});
