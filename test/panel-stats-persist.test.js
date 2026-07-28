'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const panelStatsPath = require.resolve('../src/panel-stats.js');

function tmpPanelFile(name) {
  return path.join(os.tmpdir(), `miser-test-panel-stats-${process.pid}-${name}-${Date.now()}-${Math.random()}.json`);
}

function freshPanelStats(file) {
  delete require.cache[panelStatsPath];
  process.env.MISER_PANEL_STATS_FILE = file;
  return require('../src/panel-stats.js');
}

function cleanup(file, prevEnv) {
  delete require.cache[panelStatsPath];
  if (prevEnv === undefined) delete process.env.MISER_PANEL_STATS_FILE;
  else process.env.MISER_PANEL_STATS_FILE = prevEnv;
  try { fs.unlinkSync(file); } catch (_) {}
  const dir = path.dirname(file);
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(path.basename(file) + '.tmp.')) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    }
  }
}

test('panel stats persist across a simulated restart', async () => {
  const file = tmpPanelFile('persist');
  const prevEnv = process.env.MISER_PANEL_STATS_FILE;
  try {
    let panels = freshPanelStats(file);
    panels.recordPanelUsage('alpha', 'orch', {
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 5,
      cache_creation: { ephemeral_1h_input_tokens: 7, ephemeral_5m_input_tokens: 3 },
    }, () => new Date('2026-07-27T12:00:00.000Z'));
    await panels.flushNow();

    panels = freshPanelStats(file);
    assert.deepEqual(panels.getPanelStats()['alpha--orch'], {
      input: 10,
      output: 2,
      cacheRead: 5,
      cacheWrite1h: 7,
      cacheWrite5m: 3,
      requests: 1,
      lastSeenAt: '2026-07-27T12:00:00.000Z',
    });
  } finally {
    cleanup(file, prevEnv);
  }
});

test('panel stats missing and corrupt files fail soft to empty', () => {
  const missing = tmpPanelFile('missing');
  const corrupt = tmpPanelFile('corrupt');
  const prevEnv = process.env.MISER_PANEL_STATS_FILE;
  try {
    assert.deepEqual(freshPanelStats(missing).getPanelStats(), {});

    fs.writeFileSync(corrupt, '{not json', 'utf8');
    assert.deepEqual(freshPanelStats(corrupt).getPanelStats(), {});
  } finally {
    cleanup(missing, prevEnv);
    try { fs.unlinkSync(corrupt); } catch (_) {}
  }
});

test('stale panel keys are retained and do not accrue traffic for new panel keys', async () => {
  const file = tmpPanelFile('stale');
  const prevEnv = process.env.MISER_PANEL_STATS_FILE;
  try {
    fs.writeFileSync(file, JSON.stringify({
      'alpha--dead': {
        input: 100,
        output: 1,
        cacheRead: 0,
        cacheWrite1h: 0,
        cacheWrite5m: 0,
        requests: 4,
        lastSeenAt: '2026-07-20T00:00:00.000Z',
      },
    }), 'utf8');
    const panels = freshPanelStats(file);
    panels.recordPanelUsage('alpha', 'live', { input_tokens: 9 }, () => new Date('2026-07-27T12:00:00.000Z'));
    await panels.flushNow();

    const stats = panels.getPanelStats();
    assert.equal(stats['alpha--dead'].requests, 4);
    assert.equal(stats['alpha--dead'].lastSeenAt, '2026-07-20T00:00:00.000Z');
    assert.equal(stats['alpha--live'].requests, 1);
    assert.equal(stats['alpha--live'].input, 9);
  } finally {
    cleanup(file, prevEnv);
  }
});
