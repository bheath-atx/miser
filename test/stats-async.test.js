'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const statsPath = require.resolve('../src/stats.js');

function tmpStatsFile(name) {
  return path.join(os.tmpdir(), `miser-stats-async-${process.pid}-${name}-${Date.now()}-${Math.random()}.json`);
}

function freshStats(file) {
  delete require.cache[statsPath];
  process.env.MISER_STATS_FILE = file;
  return require('../src/stats.js');
}

function cleanup(file, prevEnv, stats) {
  if (stats && stats.__resetForTest) stats.__resetForTest();
  delete require.cache[statsPath];
  if (prevEnv === undefined) delete process.env.MISER_STATS_FILE;
  else process.env.MISER_STATS_FILE = prevEnv;
  try { fs.unlinkSync(file); } catch (_) {}
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (f.startsWith(path.basename(file) + '.tmp.')) {
      try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (_) {}
    }
  }
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function currentFlush(stats) {
  const p = stats.__test._pendingFlush.currentPromise;
  if (p) await p;
}

test('200 rapid mutations trigger immediate flush at queue-depth threshold', async () => {
  const file = tmpStatsFile('threshold');
  const prevEnv = process.env.MISER_STATS_FILE;
  const originalRename = fsp.rename;
  let renameCount = 0;
  fsp.rename = async function countedRename(...args) {
    renameCount += 1;
    return originalRename.apply(this, args);
  };
  let stats;
  try {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    stats = freshStats(file);
    for (let i = 0; i < 200; i++) {
      stats.recordStats('alpha', { inputTokensRemoved: 1, techniques: { dedup: true } });
    }
    await currentFlush(stats);
    assert.equal(renameCount, 1);
    assert.equal(stats.getPendingWriteCount(), 0);
  } finally {
    mock.timers.reset();
    fsp.rename = originalRename;
    cleanup(file, prevEnv, stats);
  }
});

test('100 rapid mutations debounce to exactly one flush after five seconds', async () => {
  const file = tmpStatsFile('debounce');
  const prevEnv = process.env.MISER_STATS_FILE;
  const originalRename = fsp.rename;
  let renameCount = 0;
  fsp.rename = async function countedRename(...args) {
    renameCount += 1;
    return originalRename.apply(this, args);
  };
  let stats;
  try {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    stats = freshStats(file);
    for (let i = 0; i < 100; i++) {
      stats.recordStats('alpha', { inputTokensRemoved: 1, techniques: { dedup: true } });
    }
    assert.equal(renameCount, 0);
    mock.timers.tick(5000);
    await currentFlush(stats);
    assert.equal(renameCount, 1);
    assert.equal(stats.getPendingWriteCount(), 0);
  } finally {
    mock.timers.reset();
    fsp.rename = originalRename;
    cleanup(file, prevEnv, stats);
  }
});

test('flushNow writes all pending records before simulated shutdown', async () => {
  const file = tmpStatsFile('shutdown');
  const prevEnv = process.env.MISER_STATS_FILE;
  let stats;
  try {
    stats = freshStats(file);
    stats.recordStats('alpha', { inputTokensRemoved: 2, techniques: { dedup: true } });
    stats.recordAnthropicUsage('alpha', 'anthropic', 'claude-sonnet-4-6', { input_tokens: 1_000_000 });
    await stats.flushNow();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw[dayKey()].alpha.dedup.inputTokensRemoved, 2);
    assert.equal(raw[dayKey()].alpha.usage.anthropic['claude-sonnet-4-6'].input, 1_000_000);
  } finally {
    cleanup(file, prevEnv, stats);
  }
});

// Shutdown race regression: mutation arrives AFTER an initial flushNow() quiesces
// (simulating an accepted in-flight request that records stats during server.close()).
// The final flushNow() called after server.close() must capture it.
test('mutation after initial flushNow quiescence is captured by a second flushNow', async () => {
  const file = tmpStatsFile('shutdown-race');
  const prevEnv = process.env.MISER_STATS_FILE;
  let stats;
  try {
    stats = freshStats(file);
    // First batch: record and flush (simulates pre-server.close state)
    stats.recordStats('alpha', { inputTokensRemoved: 1, techniques: { dedup: true } });
    await stats.flushNow();
    // Mutation arrives after quiescence (simulates accepted request completing during server.close)
    stats.recordAnthropicUsage('beta', 'anthropic', 'claude-sonnet-4-6', { input_tokens: 500_000 });
    // Final flushNow (called after server.close in shutdown sequence) must capture it
    await stats.flushNow();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw[dayKey()].alpha.dedup.inputTokensRemoved, 1);
    assert.equal(raw[dayKey()].beta.usage.anthropic['claude-sonnet-4-6'].input, 500_000);
  } finally {
    cleanup(file, prevEnv, stats);
  }
});

test('concurrent flushNow calls resolve without interleaved writes', async () => {
  const file = tmpStatsFile('concurrent');
  const prevEnv = process.env.MISER_STATS_FILE;
  const originalRename = fsp.rename;
  let renameCount = 0;
  fsp.rename = async function countedRename(...args) {
    renameCount += 1;
    return originalRename.apply(this, args);
  };
  let stats;
  try {
    stats = freshStats(file);
    stats.recordStats('alpha', { inputTokensRemoved: 1, techniques: { dedup: true } });
    await Promise.all([stats.flushNow(), stats.flushNow()]);
    assert.equal(renameCount, 1);
  } finally {
    fsp.rename = originalRename;
    cleanup(file, prevEnv, stats);
  }
});

test('flush failure restores dirty and retry persists same data on second attempt', async () => {
  const file = tmpStatsFile('retry');
  const prevEnv = process.env.MISER_STATS_FILE;
  const originalRename = fsp.rename;
  let renameCount = 0;
  fsp.rename = async function flakyRename(...args) {
    renameCount += 1;
    if (renameCount === 1) throw new Error('rename once');
    return originalRename.apply(this, args);
  };
  let stats;
  try {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    stats = freshStats(file);
    stats.recordStats('alpha', { inputTokensRemoved: 7, techniques: { dedup: true } });
    await stats.flushNow();
    assert.equal(stats.__test._pendingFlush.dirty, true);
    assert.equal(stats.__test._pendingFlush.writeFailures, 1);
    mock.timers.tick(5000);
    await currentFlush(stats);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw[dayKey()].alpha.dedup.inputTokensRemoved, 7);
    assert.equal(stats.__test._pendingFlush.writeFailures, 0);
  } finally {
    mock.timers.reset();
    fsp.rename = originalRename;
    cleanup(file, prevEnv, stats);
  }
});

test('six consecutive failures log critical and stop retrying', async () => {
  const file = tmpStatsFile('critical');
  const prevEnv = process.env.MISER_STATS_FILE;
  const originalRename = fsp.rename;
  const prevError = console.error;
  const errors = [];
  fsp.rename = async () => { throw new Error('disk down'); };
  console.error = (line) => errors.push(String(line));
  let stats;
  try {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    stats = freshStats(file);
    stats.recordStats('alpha', { inputTokensRemoved: 1, techniques: { dedup: true } });
    await stats.flushNow();
    for (const delay of [5000, 10000, 20000, 40000, 60000]) {
      mock.timers.tick(delay);
      await currentFlush(stats);
    }
    assert.equal(stats.__test._pendingFlush.writeFailures, 6);
    assert.equal(stats.__test._pendingFlush.retryTimer, null);
    assert.match(errors.join('\n'), /CRITICAL stats flush failed 6 consecutive times/);
  } finally {
    mock.timers.reset();
    fsp.rename = originalRename;
    console.error = prevError;
    cleanup(file, prevEnv, stats);
  }
});

test('successful write resets writeFailures to zero', async () => {
  const file = tmpStatsFile('reset-failures');
  const prevEnv = process.env.MISER_STATS_FILE;
  const originalRename = fsp.rename;
  let renameCount = 0;
  fsp.rename = async function flakyRename(...args) {
    renameCount += 1;
    if (renameCount === 1) throw new Error('first fail');
    return originalRename.apply(this, args);
  };
  let stats;
  try {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    stats = freshStats(file);
    stats.recordStats('alpha', { inputTokensRemoved: 1, techniques: { dedup: true } });
    await stats.flushNow();
    assert.equal(stats.__test._pendingFlush.writeFailures, 1);
    mock.timers.tick(5000);
    await currentFlush(stats);
    assert.equal(stats.__test._pendingFlush.writeFailures, 0);
  } finally {
    mock.timers.reset();
    fsp.rename = originalRename;
    cleanup(file, prevEnv, stats);
  }
});

test('flushNow drains mutation that arrives during in-flight write', async () => {
  const file = tmpStatsFile('inflight');
  const prevEnv = process.env.MISER_STATS_FILE;
  const originalRename = fsp.rename;
  const originalWriteFile = fsp.writeFile;
  const snapshots = [];
  let releaseFirstRename;
  let firstRenameEntered;
  let stats;

  fsp.writeFile = async function captureWrite(filePath, data, ...rest) {
    snapshots.push(JSON.parse(String(data)));
    return originalWriteFile.call(this, filePath, data, ...rest);
  };

  fsp.rename = async function delayedRename(...args) {
    if (!firstRenameEntered) {
      firstRenameEntered = true;
      await new Promise(resolve => {
        releaseFirstRename = resolve;
      });
    }
    return originalRename.apply(this, args);
  };

  try {
    stats = freshStats(file);
    stats.recordStats('alpha', { inputTokensRemoved: 1, techniques: { dedup: true } });
    const firstFlush = stats.flushNow();
    while (!releaseFirstRename) await new Promise(resolve => setImmediate(resolve));
    stats.recordStats('beta', { inputTokensRemoved: 2, techniques: { dedup: true } });
    const drainFlush = stats.flushNow();
    releaseFirstRename();
    await Promise.all([firstFlush, drainFlush]);
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0][dayKey()].alpha.dedup.inputTokensRemoved, 1);
    assert.ok(!snapshots[0][dayKey()].beta);
    assert.equal(snapshots[1][dayKey()].beta.dedup.inputTokensRemoved, 2);
  } finally {
    fsp.rename = originalRename;
    fsp.writeFile = originalWriteFile;
    cleanup(file, prevEnv, stats);
  }
});
