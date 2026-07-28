'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// Persisted per-project--panel attribution stats. This mirrors src/stats.js:
// fail-soft load, async request-path writes, and temp-file + atomic rename.
const PANEL_STATS_FILE = process.env.MISER_PANEL_STATS_FILE
  || path.join(os.homedir(), '.miser-panel-stats.json');

function emptyPanelBucket() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite1h: 0, cacheWrite5m: 0, requests: 0, lastSeenAt: null };
}

function sanitizeBucket(raw) {
  if (!raw || typeof raw !== 'object') return emptyPanelBucket();
  const bucket = emptyPanelBucket();
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite1h', 'cacheWrite5m', 'requests']) {
    if (Number.isFinite(raw[key]) && raw[key] > 0) bucket[key] = raw[key];
  }
  if (typeof raw.lastSeenAt === 'string') bucket.lastSeenAt = raw.lastSeenAt;
  return bucket;
}

function loadPanels() {
  const map = new Map();
  try {
    const raw = fs.readFileSync(PANEL_STATS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return map;
    for (const [key, bucket] of Object.entries(parsed)) {
      if (typeof key === 'string' && key.includes('--')) map.set(key, sanitizeBucket(bucket));
    }
  } catch (_) {
    return map;
  }
  return map;
}

const _panels = loadPanels();

const _pendingFlush = {
  dirty: false,
  timer: null,
  retryTimer: null,
  inFlight: false,
  currentPromise: null,
  flushNowPromise: null,
  mutationCount: 0,
  lastFlushAt: null,
  writeFailures: 0,
  lastFlushErrored: false,
};

function clearTimer(name) {
  if (_pendingFlush[name]) {
    clearTimeout(_pendingFlush[name]);
    _pendingFlush[name] = null;
  }
}

function clonePanels() {
  const out = {};
  for (const [key, bucket] of _panels) out[key] = { ...bucket };
  return out;
}

async function writeSnapshot(snapshot) {
  const tmp = PANEL_STATS_FILE + '.tmp.' + process.pid;
  try {
    await fsp.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    await fsp.rename(tmp, PANEL_STATS_FILE);
  } catch (err) {
    try { await fsp.unlink(tmp); } catch (_) {}
    throw err;
  }
}

function scheduleRetry() {
  if (_pendingFlush.writeFailures > 5) {
    console.error('[miser/panel-stats] CRITICAL panel stats flush failed 6 consecutive times; retry paused');
    return;
  }
  const delay = Math.min(5000 * (2 ** (_pendingFlush.writeFailures - 1)), 60000);
  clearTimer('retryTimer');
  _pendingFlush.retryTimer = setTimeout(() => {
    _pendingFlush.retryTimer = null;
    executeFlush();
  }, delay);
  if (typeof _pendingFlush.retryTimer.unref === 'function') _pendingFlush.retryTimer.unref();
}

function scheduleFlush(countMutation = true) {
  if (countMutation) _pendingFlush.mutationCount += 1;
  _pendingFlush.dirty = true;
  clearTimer('retryTimer');
  clearTimer('timer');
  if (_pendingFlush.mutationCount >= 200) {
    executeFlush();
    return;
  }
  _pendingFlush.timer = setTimeout(() => {
    _pendingFlush.timer = null;
    executeFlush();
  }, 5000);
  if (typeof _pendingFlush.timer.unref === 'function') _pendingFlush.timer.unref();
}

function executeFlush() {
  if (_pendingFlush.inFlight) return _pendingFlush.currentPromise || Promise.resolve({ ok: true });

  clearTimer('timer');
  _pendingFlush.inFlight = true;
  _pendingFlush.dirty = false;
  _pendingFlush.mutationCount = 0;
  const snapshot = clonePanels();

  const promise = (async () => {
    let shouldReschedule = false;
    try {
      await writeSnapshot(snapshot);
      _pendingFlush.lastFlushAt = Date.now();
      _pendingFlush.writeFailures = 0;
      _pendingFlush.lastFlushErrored = false;
      shouldReschedule = _pendingFlush.dirty;
      return { ok: true };
    } catch (err) {
      _pendingFlush.dirty = true;
      _pendingFlush.writeFailures += 1;
      _pendingFlush.lastFlushErrored = true;
      console.error('[miser/panel-stats] ERROR flush error:', err.message);
      scheduleRetry();
      return { ok: false, error: err };
    } finally {
      _pendingFlush.inFlight = false;
      _pendingFlush.currentPromise = null;
      if (shouldReschedule && !_pendingFlush.lastFlushErrored) scheduleFlush(false);
    }
  })();

  _pendingFlush.currentPromise = promise;
  return promise;
}

async function drainFlushNow() {
  _pendingFlush.dirty = true;
  clearTimer('timer');
  while (true) {
    if (_pendingFlush.inFlight) {
      await (_pendingFlush.currentPromise || Promise.resolve());
      if (_pendingFlush.dirty && _pendingFlush.lastFlushErrored) return;
      continue;
    }
    if (!_pendingFlush.dirty) {
      clearTimer('timer');
      return;
    }
    if (_pendingFlush.lastFlushErrored) return;
    await executeFlush();
    if (_pendingFlush.dirty && _pendingFlush.lastFlushErrored) return;
  }
}

function flushNow() {
  if (_pendingFlush.flushNowPromise) return _pendingFlush.flushNowPromise;
  _pendingFlush.flushNowPromise = drainFlushNow().finally(() => {
    _pendingFlush.flushNowPromise = null;
  });
  return _pendingFlush.flushNowPromise;
}

function normalizeRaw(raw) {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite1h: 0, cacheWrite5m: 0 };
  if (!raw || typeof raw !== 'object') return out;
  if (Number.isFinite(raw.input_tokens) && raw.input_tokens > 0)
    out.input = raw.input_tokens;
  if (Number.isFinite(raw.output_tokens) && raw.output_tokens > 0)
    out.output = raw.output_tokens;
  if (Number.isFinite(raw.cache_read_input_tokens) && raw.cache_read_input_tokens > 0)
    out.cacheRead = raw.cache_read_input_tokens;
  const creation = (raw.cache_creation && typeof raw.cache_creation === 'object')
    ? raw.cache_creation : {};
  if (Number.isFinite(creation.ephemeral_1h_input_tokens) && creation.ephemeral_1h_input_tokens > 0) {
    out.cacheWrite1h = creation.ephemeral_1h_input_tokens;
  } else if (Number.isFinite(raw.cache_creation_input_tokens) && raw.cache_creation_input_tokens > 0) {
    out.cacheWrite1h = raw.cache_creation_input_tokens;
  }
  if (Number.isFinite(creation.ephemeral_5m_input_tokens) && creation.ephemeral_5m_input_tokens > 0)
    out.cacheWrite5m = creation.ephemeral_5m_input_tokens;
  return out;
}

function recordPanelUsage(project, panel, rawUsage, nowFn = () => new Date()) {
  if (!project || typeof project !== 'string' || !panel || typeof panel !== 'string') return;
  const key = `${project}--${panel}`;
  let bucket = _panels.get(key);
  if (!bucket) {
    bucket = emptyPanelBucket();
    _panels.set(key, bucket);
  }
  const norm = normalizeRaw(rawUsage);
  bucket.input      += norm.input;
  bucket.output     += norm.output;
  bucket.cacheRead  += norm.cacheRead;
  bucket.cacheWrite1h += norm.cacheWrite1h;
  bucket.cacheWrite5m += norm.cacheWrite5m;
  bucket.requests   += 1;
  bucket.lastSeenAt = nowFn().toISOString();
  scheduleFlush();
}

function getPanelStats() {
  return clonePanels();
}

function __resetForTest() {
  _panels.clear();
  clearTimer('timer');
  clearTimer('retryTimer');
  _pendingFlush.dirty = false;
  _pendingFlush.inFlight = false;
  _pendingFlush.currentPromise = null;
  _pendingFlush.flushNowPromise = null;
  _pendingFlush.mutationCount = 0;
  _pendingFlush.lastFlushAt = null;
  _pendingFlush.writeFailures = 0;
  _pendingFlush.lastFlushErrored = false;
}

module.exports = { recordPanelUsage, getPanelStats, flushNow, loadPanels, __resetForTest };
