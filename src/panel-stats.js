'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// Persisted per-project--panel attribution stats. This mirrors src/stats.js:
// fail-soft load, async request-path writes, and temp-file + atomic rename.
const PANEL_STATS_FILE = process.env.MISER_PANEL_STATS_FILE
  || path.join(os.homedir(), '.miser-panel-stats.json');
// One year of hourly panel UUID rotations across ~20 panels is about 38k-49k
// keys in the R1 audit. Keep a little headroom, then evict least-recently-seen
// keys so startup parse/stringify cost stays bounded.
const DEFAULT_MAX_KEYS = 50_000;
const DEFAULT_MAX_AGE_DAYS = 400;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const PANEL_STATS_MAX_KEYS = parsePositiveInt(process.env.MISER_PANEL_STATS_MAX_KEYS, DEFAULT_MAX_KEYS);
const PANEL_STATS_MAX_AGE_MS = parsePositiveInt(process.env.MISER_PANEL_STATS_MAX_AGE_DAYS, DEFAULT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;
const PANEL_STATS_MAX_BYTES = parsePositiveInt(process.env.MISER_PANEL_STATS_MAX_BYTES, DEFAULT_MAX_BYTES);

const _persistence = {
  lastLoadErrored: false,
  lastErrorCode: null,
  lastErrorMessage: null,
};

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

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
    const stat = fs.statSync(PANEL_STATS_FILE);
    if (stat.size > PANEL_STATS_MAX_BYTES) {
      const err = new Error(`panel stats file exceeds ${PANEL_STATS_MAX_BYTES} byte retention guard`);
      err.code = 'E2BIG';
      throw err;
    }
    const raw = fs.readFileSync(PANEL_STATS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return map;
    for (const [key, bucket] of Object.entries(parsed)) {
      if (typeof key === 'string' && key.includes('--')) map.set(key, sanitizeBucket(bucket));
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      _persistence.lastLoadErrored = true;
      _persistence.lastErrorCode = err.code || 'LOAD_ERROR';
      _persistence.lastErrorMessage = err.message;
      console.warn('[miser/panel-stats] WARN load failed; starting empty:', err.message);
    }
    return map;
  }
  return prunePanelMap(map);
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
  lastErrorCode: null,
};

function clearTimer(name) {
  if (_pendingFlush[name]) {
    clearTimeout(_pendingFlush[name]);
    _pendingFlush[name] = null;
  }
}

function clonePanels() {
  const out = {};
  prunePanelMap(_panels);
  for (const [key, bucket] of _panels) out[key] = { ...bucket };
  return out;
}

async function writeSnapshot(snapshot) {
  const tmp = PANEL_STATS_FILE + '.tmp.' + process.pid;
  try {
    await fsp.writeFile(tmp, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(tmp, PANEL_STATS_FILE);
    try { await fsp.chmod(PANEL_STATS_FILE, 0o600); } catch (_) {}
  } catch (err) {
    try { await fsp.unlink(tmp); } catch (_) {}
    throw err;
  }
}

function seenTime(bucket) {
  if (!bucket || typeof bucket.lastSeenAt !== 'string') return 0;
  const t = Date.parse(bucket.lastSeenAt);
  return Number.isFinite(t) ? t : 0;
}

function prunePanelMap(map, nowMs = Date.now()) {
  if (!(map instanceof Map) || map.size === 0) return map;
  const minSeenMs = nowMs - PANEL_STATS_MAX_AGE_MS;
  for (const [key, bucket] of map) {
    const t = seenTime(bucket);
    if (t > 0 && t < minSeenMs) map.delete(key);
  }
  if (map.size <= PANEL_STATS_MAX_KEYS) return map;
  const keep = [...map.entries()]
    .sort((a, b) => seenTime(b[1]) - seenTime(a[1]))
    .slice(0, PANEL_STATS_MAX_KEYS);
  map.clear();
  for (const [key, bucket] of keep) map.set(key, bucket);
  return map;
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
      _pendingFlush.lastErrorCode = null;
      _persistence.lastLoadErrored = false;
      _persistence.lastErrorCode = null;
      _persistence.lastErrorMessage = null;
      shouldReschedule = _pendingFlush.dirty;
      return { ok: true, file: PANEL_STATS_FILE };
    } catch (err) {
      _pendingFlush.dirty = true;
      _pendingFlush.writeFailures += 1;
      _pendingFlush.lastFlushErrored = true;
      _pendingFlush.lastErrorCode = err.code || 'WRITE_ERROR';
      _persistence.lastErrorCode = _pendingFlush.lastErrorCode;
      _persistence.lastErrorMessage = err.message;
      console.error('[miser/panel-stats] ERROR flush error:', err.message);
      scheduleRetry();
      return { ok: false, error: err, errorCode: _pendingFlush.lastErrorCode, file: PANEL_STATS_FILE };
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
  let lastResult = { ok: true, file: PANEL_STATS_FILE };
  while (true) {
    if (_pendingFlush.inFlight) {
      lastResult = await (_pendingFlush.currentPromise || Promise.resolve(lastResult));
      if (_pendingFlush.dirty && _pendingFlush.lastFlushErrored) return lastResult;
      continue;
    }
    if (!_pendingFlush.dirty) {
      clearTimer('timer');
      return lastResult;
    }
    if (_pendingFlush.lastFlushErrored) return {
      ok: false,
      errorCode: _pendingFlush.lastErrorCode,
      file: PANEL_STATS_FILE,
    };
    lastResult = await executeFlush();
    if (_pendingFlush.dirty && _pendingFlush.lastFlushErrored) return lastResult;
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

function getPersistenceStatus() {
  const degraded = _pendingFlush.lastFlushErrored || _pendingFlush.writeFailures > 0 || _persistence.lastLoadErrored;
  return {
    healthy: !degraded,
    durable: !degraded,
    lastFlushErrored: _pendingFlush.lastFlushErrored,
    lastLoadErrored: _persistence.lastLoadErrored,
    writeFailures: _pendingFlush.writeFailures,
    lastErrorCode: _pendingFlush.lastErrorCode || _persistence.lastErrorCode,
    lastErrorMessage: _persistence.lastErrorMessage,
    file: PANEL_STATS_FILE,
    retention: {
      maxKeys: PANEL_STATS_MAX_KEYS,
      maxAgeDays: Math.round(PANEL_STATS_MAX_AGE_MS / (24 * 60 * 60 * 1000)),
      maxBytes: PANEL_STATS_MAX_BYTES,
    },
  };
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
  _pendingFlush.lastErrorCode = null;
  _persistence.lastLoadErrored = false;
  _persistence.lastErrorCode = null;
  _persistence.lastErrorMessage = null;
}

module.exports = { recordPanelUsage, getPanelStats, getPersistenceStatus, flushNow, loadPanels, __resetForTest };
