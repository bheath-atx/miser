'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const panelStatsPath = require.resolve('../src/panel-stats.js');
const proxyPath = require.resolve('../src/proxy.js');

function tmpPanelFile(name) {
  return path.join(os.tmpdir(), `miser-test-panel-stats-${process.pid}-${name}-${Date.now()}-${Math.random()}.json`);
}

function freshPanelStats(file) {
  delete require.cache[panelStatsPath];
  process.env.MISER_PANEL_STATS_FILE = file;
  return require('../src/panel-stats.js');
}

async function freshLoadedPanelStats(file) {
  const panels = freshPanelStats(file);
  await panels.__test.waitForLoad();
  return panels;
}

function cleanup(file, prevEnv) {
  delete require.cache[panelStatsPath];
  if (prevEnv === undefined) delete process.env.MISER_PANEL_STATS_FILE;
  else process.env.MISER_PANEL_STATS_FILE = prevEnv;
  try { fs.rmSync(file, { recursive: true, force: true }); } catch (_) {}
  const dir = path.dirname(file);
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(path.basename(file) + '.tmp.')) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    }
  }
}

function fakeGetReq(url) {
  const listeners = {};
  const req = {
    method: 'GET',
    url,
    headers: {},
    on(evt, cb) { listeners[evt] = cb; return req; },
  };
  process.nextTick(() => { if (listeners.end) listeners.end(); });
  return req;
}

function makeRes() {
  return {
    statusCode: null,
    headers: null,
    chunks: [],
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
      return this;
    },
    write(chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) this.write(chunk);
      if (this.resolve) this.resolve(this);
      return this;
    },
    body() { return this.chunks.join(''); },
  };
}

function runGetHandler(handler, url) {
  const res = makeRes();
  const done = new Promise(resolve => { res.resolve = resolve; });
  handler(fakeGetReq(url), res);
  return done;
}

test('panel stats persist across a simulated restart', async () => {
  const file = tmpPanelFile('persist');
  const prevEnv = process.env.MISER_PANEL_STATS_FILE;
  try {
    let panels = await freshLoadedPanelStats(file);
    panels.recordPanelUsage('alpha', 'orch', {
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 5,
      cache_creation: { ephemeral_1h_input_tokens: 7, ephemeral_5m_input_tokens: 3 },
    }, () => new Date('2026-07-27T12:00:00.000Z'));
    await panels.flushNow();
    assert.equal((fs.statSync(file).mode & 0o777), 0o600);

    panels = await freshLoadedPanelStats(file);
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

test('panel stats missing and corrupt files fail soft to empty', async () => {
  const missing = tmpPanelFile('missing');
  const corrupt = tmpPanelFile('corrupt');
  const prevEnv = process.env.MISER_PANEL_STATS_FILE;
  try {
    assert.deepEqual((await freshLoadedPanelStats(missing)).getPanelStats(), {});

    fs.writeFileSync(corrupt, '{not json', 'utf8');
    assert.deepEqual((await freshLoadedPanelStats(corrupt)).getPanelStats(), {});
  } finally {
    cleanup(missing, prevEnv);
    try { fs.unlinkSync(corrupt); } catch (_) {}
  }
});

test('panel stats invalid JSON shapes load as empty', async () => {
  const prevEnv = process.env.MISER_PANEL_STATS_FILE;
  for (const [name, value] of [
    ['zero', ''],
    ['array', '[]'],
    ['scalar', '"nope"'],
  ]) {
    const file = tmpPanelFile(name);
    try {
      fs.writeFileSync(file, value, 'utf8');
      assert.deepEqual((await freshLoadedPanelStats(file)).getPanelStats(), {});
    } finally {
      cleanup(file, prevEnv);
    }
  }
});

test('panel stats sanitize wrong-typed counters on load', async () => {
  const file = tmpPanelFile('wrong-types');
  const prevEnv = process.env.MISER_PANEL_STATS_FILE;
  try {
    fs.writeFileSync(file, JSON.stringify({
      'alpha--orch': {
        input: '10',
        output: -1,
        cacheRead: 3,
        cacheWrite1h: null,
        cacheWrite5m: Infinity,
        requests: 2,
        lastSeenAt: 123,
      },
    }), 'utf8');
    assert.deepEqual((await freshLoadedPanelStats(file)).getPanelStats()['alpha--orch'], {
      input: 0,
      output: 0,
      cacheRead: 3,
      cacheWrite1h: 0,
      cacheWrite5m: 0,
      requests: 2,
      lastSeenAt: null,
    });
  } finally {
    cleanup(file, prevEnv);
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
    let panels = await freshLoadedPanelStats(file);
    panels.recordPanelUsage('alpha', 'live', { input_tokens: 9 }, () => new Date('2026-07-27T12:00:00.000Z'));
    await panels.flushNow();

    panels = await freshLoadedPanelStats(file);
    const stats = panels.getPanelStats();
    assert.equal(stats['alpha--dead'].requests, 4);
    assert.equal(stats['alpha--dead'].lastSeenAt, '2026-07-20T00:00:00.000Z');
    assert.equal(stats['alpha--live'].requests, 1);
    assert.equal(stats['alpha--live'].input, 9);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('panel stats report write failure for unwritable path without throwing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-panel-unwritable-${process.pid}-`));
  const file = path.join(dir, 'stats.json');
  const prevEnv = process.env.MISER_PANEL_STATS_FILE;
  try {
    fs.chmodSync(dir, 0o500);
    const panels = await freshLoadedPanelStats(file);
    panels.recordPanelUsage('alpha', 'orch', { input_tokens: 1 });
    const result = await panels.flushNow();
    assert.equal(result.ok, false);
    assert.match(result.errorCode, /EACCES|EPERM/);
    const status = panels.getPersistenceStatus();
    assert.equal(status.healthy, false);
    assert.equal(status.lastFlushErrored, true);
    assert.equal(status.writeFailures, 1);
  } finally {
    try { fs.chmodSync(dir, 0o700); } catch (_) {}
    cleanup(file, prevEnv);
    try { fs.rmdirSync(dir); } catch (_) {}
  }
});

test('panel stats report directory target as persistence failure', async () => {
  const file = fs.mkdtempSync(path.join(os.tmpdir(), `miser-panel-dir-target-${process.pid}-`));
  const prevEnv = process.env.MISER_PANEL_STATS_FILE;
  try {
    const panels = await freshLoadedPanelStats(file);
    panels.recordPanelUsage('alpha', 'orch', { input_tokens: 1 });
    const result = await panels.flushNow();
    assert.equal(result.ok, false);
    assert.ok(result.errorCode);
    assert.equal(panels.getPersistenceStatus().healthy, false);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('panel stats evict least-recently-seen keys on load and flush', async () => {
  const file = tmpPanelFile('retention');
  const prevFileEnv = process.env.MISER_PANEL_STATS_FILE;
  const prevMaxEnv = process.env.MISER_PANEL_STATS_MAX_KEYS;
  const prevAgeEnv = process.env.MISER_PANEL_STATS_MAX_AGE_DAYS;
  try {
    process.env.MISER_PANEL_STATS_MAX_KEYS = '2';
    process.env.MISER_PANEL_STATS_MAX_AGE_DAYS = '10000';
    fs.writeFileSync(file, JSON.stringify({
      'alpha--old': { requests: 1, lastSeenAt: '2026-07-20T00:00:00.000Z' },
      'alpha--middle': { requests: 1, lastSeenAt: '2026-07-21T00:00:00.000Z' },
      'alpha--new': { requests: 1, lastSeenAt: '2026-07-22T00:00:00.000Z' },
    }), 'utf8');
    let panels = await freshLoadedPanelStats(file);
    assert.deepEqual(Object.keys(panels.getPanelStats()).sort(), ['alpha--middle', 'alpha--new']);
    const loadedStatus = panels.getPersistenceStatus();
    assert.equal(loadedStatus.healthy, false);
    assert.equal(loadedStatus.retention.evictedKeys, 1);
    assert.equal(loadedStatus.retention.lastPrune.maxKeysEvicted, 1);

    panels.__resetForTest();
    panels.recordPanelUsage('alpha', 'one', { input_tokens: 1 }, () => new Date('2026-07-23T00:00:00.000Z'));
    panels.recordPanelUsage('alpha', 'two', { input_tokens: 1 }, () => new Date('2026-07-24T00:00:00.000Z'));
    panels.recordPanelUsage('alpha', 'three', { input_tokens: 1 }, () => new Date('2026-07-25T00:00:00.000Z'));
    await panels.flushNow();
    panels = await freshLoadedPanelStats(file);
    assert.deepEqual(Object.keys(panels.getPanelStats()).sort(), ['alpha--three', 'alpha--two']);
  } finally {
    if (prevMaxEnv === undefined) delete process.env.MISER_PANEL_STATS_MAX_KEYS;
    else process.env.MISER_PANEL_STATS_MAX_KEYS = prevMaxEnv;
    if (prevAgeEnv === undefined) delete process.env.MISER_PANEL_STATS_MAX_AGE_DAYS;
    else process.env.MISER_PANEL_STATS_MAX_AGE_DAYS = prevAgeEnv;
    cleanup(file, prevFileEnv);
  }
});

test('panel stats expose unflushed dirty data as pending, not durable', async () => {
  const file = tmpPanelFile('pending');
  const prevEnv = process.env.MISER_PANEL_STATS_FILE;
  try {
    const panels = await freshLoadedPanelStats(file);
    panels.recordPanelUsage('alpha', 'orch', { input_tokens: 1 });
    const status = panels.getPersistenceStatus();
    assert.equal(status.healthy, true);
    assert.equal(status.durable, false);
    assert.equal(status.pending, true);
    assert.equal(status.dirty, true);
    assert.ok(status.pendingSince);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('panel stats do not overwrite existing file after load failure followed by flush', async () => {
  const file = tmpPanelFile('load-failure-preserve');
  const prevEnv = process.env.MISER_PANEL_STATS_FILE;
  const corruptBody = '{not json';
  try {
    fs.writeFileSync(file, corruptBody, 'utf8');
    const panels = await freshLoadedPanelStats(file);
    assert.deepEqual(panels.getPanelStats(), {});
    assert.equal(panels.getPersistenceStatus().lastLoadErrored, true);

    panels.recordPanelUsage('alpha', 'orch', { input_tokens: 9 }, () => new Date('2026-07-27T12:00:00.000Z'));
    const result = await panels.flushNow();
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'LOAD_ERROR');
    assert.equal(fs.readFileSync(file, 'utf8'), corruptBody);

    const status = panels.getPersistenceStatus();
    assert.equal(status.healthy, false);
    assert.equal(status.durable, false);
    assert.equal(status.pending, true);
    assert.equal(status.dirty, true);
    assert.equal(status.lastLoadErrored, true);
  } finally {
    cleanup(file, prevEnv);
  }
});

test('panel stats bound and count mutations after load-failure refusal', async () => {
  const file = tmpPanelFile('load-failure-drop-counts');
  const prevEnv = process.env.MISER_PANEL_STATS_FILE;
  const prevWarn = console.warn;
  const prevError = console.error;
  const corruptBody = '{not json';
  const warnings = [];
  const errors = [];
  try {
    console.warn = (...args) => warnings.push(args.join(' '));
    console.error = (...args) => errors.push(args.join(' '));
    fs.writeFileSync(file, corruptBody, 'utf8');
    const panels = await freshLoadedPanelStats(file);
    warnings.length = 0;

    panels.recordPanelUsage('alpha', 'seed', { input_tokens: 9 }, () => new Date('2026-07-27T12:00:00.000Z'));
    const first = await panels.flushNow();
    assert.equal(first.ok, false);
    assert.equal(first.errorCode, 'LOAD_ERROR');
    assert.equal(fs.readFileSync(file, 'utf8'), corruptBody);

    mock.timers.enable({ apis: ['Date'], now: new Date('2026-07-28T12:00:00.000Z') });
    panels.recordPanelUsage('alpha', 'one', { input_tokens: 1 });
    mock.timers.setTime(new Date('2026-07-28T12:00:01.000Z').getTime());
    panels.recordPanelUsage('beta', 'two', { input_tokens: 2 });
    panels.recordPanelUsage('alpha', 'one', { input_tokens: 3 });

    const stats = panels.getPanelStats();
    assert.deepEqual(Object.keys(stats), ['alpha--seed']);
    assert.equal(stats['alpha--seed'].input, 9);
    assert.equal(stats['alpha--one'], undefined);
    assert.equal(stats['beta--two'], undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /load-failure refusal/);
    assert.match(warnings[0], /further rejection logs suppressed/);
    assert.match(errors.join('\n'), /refusing flush after load failure/);

    const rejections = panels.getRecordRejectionStatus();
    assert.equal(rejections.total, 3);
    assert.equal(rejections.loadFailureRefusal, 3);
    assert.deepEqual(rejections.byLabel, {
      'alpha--one': 2,
      'beta--two': 1,
    });
    assert.equal(rejections.firstRejectedAt, '2026-07-28T12:00:00.000Z');
    assert.equal(rejections.lastRejectedAt, '2026-07-28T12:00:01.000Z');
    assert.equal(rejections.firstDroppedAt, '2026-07-28T12:00:00.000Z');
    assert.equal(rejections.lastDroppedAt, '2026-07-28T12:00:01.000Z');

    delete require.cache[proxyPath];
    const { createProxy } = require('../src/proxy.js');
    const res = await runGetHandler(createProxy(), '/api/miser/stats/panels');
    const body = JSON.parse(res.body());
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, false);
    assert.equal(body.degraded, true);
    assert.equal(body.persistence.lastLoadErrored, true);
    assert.deepEqual(body.recordRejections, rejections);
    assert.deepEqual(Object.keys(body.panels), ['alpha--seed']);
  } finally {
    mock.timers.reset();
    console.warn = prevWarn;
    console.error = prevError;
    cleanup(file, prevEnv);
    delete require.cache[proxyPath];
  }
});

test('panel stats final flush retries after a previous write failure', async () => {
  const file = tmpPanelFile('flush-retry');
  const prevEnv = process.env.MISER_PANEL_STATS_FILE;
  const originalWriteFile = fsp.writeFile;
  let failOnce = true;
  try {
    const panels = await freshLoadedPanelStats(file);
    panels.recordPanelUsage('alpha', 'orch', { input_tokens: 1 }, () => new Date('2026-07-27T12:00:00.000Z'));
    fsp.writeFile = async (...args) => {
      if (failOnce) {
        failOnce = false;
        const err = new Error('temporary write failure');
        err.code = 'EIO';
        throw err;
      }
      return originalWriteFile(...args);
    };

    const first = await panels.flushNow();
    assert.equal(first.ok, false);
    assert.equal(first.errorCode, 'EIO');

    const second = await panels.flushNow();
    assert.equal(second.ok, true);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(persisted['alpha--orch'].input, 1);
    assert.equal(panels.getPersistenceStatus().healthy, true);
  } finally {
    fsp.writeFile = originalWriteFile;
    cleanup(file, prevEnv);
  }
});

test('panel stats treat chmod failure as flush failure', async () => {
  const file = tmpPanelFile('chmod');
  const prevEnv = process.env.MISER_PANEL_STATS_FILE;
  const originalChmod = fsp.chmod;
  try {
    const panels = await freshLoadedPanelStats(file);
    panels.recordPanelUsage('alpha', 'orch', { input_tokens: 1 });
    fsp.chmod = async () => {
      const err = new Error('chmod denied');
      err.code = 'EACCES';
      throw err;
    };
    const result = await panels.flushNow();
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'EACCES');
    const status = panels.getPersistenceStatus();
    assert.equal(status.healthy, false);
    assert.equal(status.writeFailures, 1);
  } finally {
    fsp.chmod = originalChmod;
    cleanup(file, prevEnv);
  }
});

test('panel stats retention tie-breaker keeps deterministic key order', async () => {
  const file = tmpPanelFile('tie-break');
  const prevFileEnv = process.env.MISER_PANEL_STATS_FILE;
  const prevMaxEnv = process.env.MISER_PANEL_STATS_MAX_KEYS;
  try {
    process.env.MISER_PANEL_STATS_MAX_KEYS = '2';
    fs.writeFileSync(file, JSON.stringify({
      'alpha--c': { requests: 1 },
      'alpha--a': { requests: 1 },
      'alpha--b': { requests: 1 },
    }), 'utf8');
    const panels = await freshLoadedPanelStats(file);
    assert.deepEqual(Object.keys(panels.getPanelStats()).sort(), ['alpha--a', 'alpha--b']);
  } finally {
    if (prevMaxEnv === undefined) delete process.env.MISER_PANEL_STATS_MAX_KEYS;
    else process.env.MISER_PANEL_STATS_MAX_KEYS = prevMaxEnv;
    cleanup(file, prevFileEnv);
  }
});

test('panel stats clamps abusive retention env vars', async () => {
  const file = tmpPanelFile('clamp');
  const prevFileEnv = process.env.MISER_PANEL_STATS_FILE;
  const prevMaxKeys = process.env.MISER_PANEL_STATS_MAX_KEYS;
  const prevMaxAge = process.env.MISER_PANEL_STATS_MAX_AGE_DAYS;
  const prevMaxBytes = process.env.MISER_PANEL_STATS_MAX_BYTES;
  try {
    process.env.MISER_PANEL_STATS_MAX_KEYS = '9007199254740991';
    process.env.MISER_PANEL_STATS_MAX_AGE_DAYS = '9007199254740991';
    process.env.MISER_PANEL_STATS_MAX_BYTES = '9007199254740991';
    const panels = await freshLoadedPanelStats(file);
    const retention = panels.getPersistenceStatus().retention;
    assert.equal(retention.maxKeys, 100000);
    assert.equal(retention.maxAgeDays, 730);
    assert.equal(retention.maxBytes, 20 * 1024 * 1024);
  } finally {
    if (prevMaxKeys === undefined) delete process.env.MISER_PANEL_STATS_MAX_KEYS;
    else process.env.MISER_PANEL_STATS_MAX_KEYS = prevMaxKeys;
    if (prevMaxAge === undefined) delete process.env.MISER_PANEL_STATS_MAX_AGE_DAYS;
    else process.env.MISER_PANEL_STATS_MAX_AGE_DAYS = prevMaxAge;
    if (prevMaxBytes === undefined) delete process.env.MISER_PANEL_STATS_MAX_BYTES;
    else process.env.MISER_PANEL_STATS_MAX_BYTES = prevMaxBytes;
    cleanup(file, prevFileEnv);
  }
});
