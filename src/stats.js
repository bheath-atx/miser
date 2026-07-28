'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { computeCost } = require('./pricing.js');

// Persisted per-day x per-project x per-technique stats.
// Atomic write (temp+rename) so process restarts do not corrupt the file.
const STATS_FILE = process.env.MISER_STATS_FILE
  || path.join(os.homedir(), '.miser-stats.json');
const WEEKLY_KEY = '__weekly';
const WEEKLY_META_KEY = '__meta';
const STATS_META_KEY = '__meta';
// Historical E3-only key name retained only so unshipped snapshots can be cleaned.
const DAILY_RETENTION_WATERMARK_KEY = 'dailyRetentionWatermark';
// Daily buckets are the observation log. __meta.recordingStartedAt is display
// metadata only; weekly authority is based on daily key presence plus persistence.
const RECORDING_STARTED_AT_KEY = 'recordingStartedAt';
const SUBSCRIPTION_TIME_ZONE = 'America/Chicago';
const DEFAULT_OBSERVATION_SEAL_INTERVAL_MS = 60_000;
const MIN_OBSERVATION_SEAL_INTERVAL_MS = 60_000;
const MAX_OBSERVATION_SEAL_INTERVAL_MS = 300_000;
// Keep two years of completed weekly buckets by default: enough for year-over-year
// comparisons while bounding persisted __weekly growth.
const DEFAULT_WEEKLY_MAX_WEEKS = 104;
const MAX_WEEKLY_MAX_WEEKS = 260;
// Stats writers tolerate normal delayed/replayed events, but reject clock readings
// outside this service window so one bad host clock cannot create permanent keys.
const DEFAULT_CLOCK_PAST_DAYS = 400;
const DEFAULT_CLOCK_FUTURE_DAYS = 7;
const MAX_CLOCK_PAST_DAYS = 730;
const MAX_CLOCK_FUTURE_DAYS = 30;
const WEEKLY_MAX_WEEKS = parsePositiveInt(process.env.MISER_WEEKLY_STATS_MAX_WEEKS, DEFAULT_WEEKLY_MAX_WEEKS, MAX_WEEKLY_MAX_WEEKS, 'MISER_WEEKLY_STATS_MAX_WEEKS');
const CLOCK_PAST_MS = parsePositiveInt(process.env.MISER_STATS_CLOCK_PAST_DAYS, DEFAULT_CLOCK_PAST_DAYS, MAX_CLOCK_PAST_DAYS, 'MISER_STATS_CLOCK_PAST_DAYS') * 24 * 60 * 60 * 1000;
const CLOCK_FUTURE_MS = parsePositiveInt(process.env.MISER_STATS_CLOCK_FUTURE_DAYS, DEFAULT_CLOCK_FUTURE_DAYS, MAX_CLOCK_FUTURE_DAYS, 'MISER_STATS_CLOCK_FUTURE_DAYS') * 24 * 60 * 60 * 1000;
const OBSERVATION_SEAL_INTERVAL_MS = parsePositiveInt(
  process.env.MISER_STATS_SEAL_INTERVAL_MS,
  DEFAULT_OBSERVATION_SEAL_INTERVAL_MS,
  MAX_OBSERVATION_SEAL_INTERVAL_MS,
  'MISER_STATS_SEAL_INTERVAL_MS',
);
let _timeZoneStatus = null;
let _timeZoneUnsupportedRetries = 0;
let _timezoneFallbackWarned = false;
const TIME_ZONE_UNSUPPORTED_RETRY_MS = 60_000;
const TIME_ZONE_IMMEDIATE_RETRIES = 1;

const _persistence = {
  lastLoadErrored: false,
  lastErrorCode: null,
  lastErrorMessage: null,
  lastLoadAt: null,
  pendingSince: null,
};

const DEFAULT_WEIGHTS = Object.freeze({
  input: 1.0,
  cacheRead: 0.1,
  cacheWrite5m: 1.25,
  cacheWrite1h: 2.0,
  output: 5.0,
});

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

const _observationSeal = {
  startupTimer: null,
  intervalTimer: null,
};

let _loadStatsNeedsFlush = false;
let _stats = loadStats();
if (_loadStatsNeedsFlush) {
  scheduleFlush(false, 0);
}
startObservationSeal();

const _recordRejections = {
  total: 0,
  invalidTimestamp: 0,
  outOfBoundsTimestamp: 0,
  loadFailureRefusal: 0,
  byLabel: {},
  firstRejectedAt: null,
  lastRejectedAt: null,
  firstDroppedAt: null,
  lastDroppedAt: null,
  warned: false,
};

function parsePositiveInt(value, fallback, max, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) return fallback;
  if (n > max) {
    console.warn(`[miser/stats] WARN clamping ${name}=${n} to ${max}`);
    return max;
  }
  return n;
}

function probeSubscriptionTimeZone() {
  if (process.env.MISER_FORCE_SUBSCRIPTION_TZ_FALLBACK === '1') {
    return { supported: false, reason: 'forced by MISER_FORCE_SUBSCRIPTION_TZ_FALLBACK' };
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: SUBSCRIPTION_TIME_ZONE }).format(new Date('2026-01-01T00:00:00.000Z'));
    return { supported: true, reason: null };
  } catch (err) {
    if (err instanceof RangeError) return { supported: false, reason: err.message };
    throw err;
  }
}

function getSubscriptionTimeZoneStatus() {
  if (process.env.MISER_FORCE_SUBSCRIPTION_TZ_FALLBACK === '1') {
    _timeZoneStatus = { supported: false, reason: 'forced by MISER_FORCE_SUBSCRIPTION_TZ_FALLBACK' };
    return _timeZoneStatus;
  }
  if (_timeZoneStatus && _timeZoneStatus.supported) return _timeZoneStatus;
  if (_timeZoneStatus && !_timeZoneStatus.supported
      && _timeZoneStatus.nextRetryAt && Date.now() < _timeZoneStatus.nextRetryAt) {
    return _timeZoneStatus;
  }
  _timeZoneStatus = probeSubscriptionTimeZone();
  if (_timeZoneStatus.supported) {
    _timezoneFallbackWarned = false;
    _timeZoneUnsupportedRetries = 0;
  } else if (_timeZoneUnsupportedRetries < TIME_ZONE_IMMEDIATE_RETRIES) {
    _timeZoneUnsupportedRetries += 1;
    _timeZoneStatus.nextRetryAt = 0;
  } else {
    _timeZoneStatus.nextRetryAt = Date.now() + TIME_ZONE_UNSUPPORTED_RETRY_MS;
  }
  return _timeZoneStatus;
}

function loadStats() {
  _loadStatsNeedsFlush = false;
  let parsed;
  try {
    const raw = fs.readFileSync(STATS_FILE, 'utf8');
    parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const err = new Error('stats file root must be an object');
      err.code = 'LOAD_SHAPE';
      throw err;
    }
    _persistence.lastLoadErrored = false;
    _persistence.lastErrorCode = null;
    _persistence.lastErrorMessage = null;
    _persistence.lastLoadAt = Date.now();
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      _persistence.lastLoadErrored = true;
      _persistence.lastErrorCode = err.code || 'LOAD_ERROR';
      _persistence.lastErrorMessage = err.message;
      console.warn('[miser/stats] WARN load failed; starting empty:', err.message);
    }
    return {};
  }
  try {
    const meta = getStatsMeta(parsed);
    const hadLegacyBoundary = !!(meta
      && Object.prototype.hasOwnProperty.call(meta, DAILY_RETENTION_WATERMARK_KEY));
    const removedLegacyOnlyBoundary = migrateStatsMeta(parsed);
    const derivedBoundary = removedLegacyOnlyBoundary ? false : deriveRecordingStartedAtFromDaily(parsed);
    reconcileWeeklyFromDaily(parsed);
    pruneWeeklyRetention(parsed);
    if (hadLegacyBoundary || derivedBoundary) _loadStatsNeedsFlush = true;
  } catch (err) {
    console.error('[miser/stats] ERROR stats migration/retention failed; preserving parsed daily stats:', err.message);
    if (!parsed[WEEKLY_KEY] || typeof parsed[WEEKLY_KEY] !== 'object' || Array.isArray(parsed[WEEKLY_KEY])) {
      delete parsed[WEEKLY_KEY];
    } else {
      markAllWeeklyNonAuthoritative(parsed[WEEKLY_KEY], 'migration_retention_failed');
    }
  }
  return parsed;
}

function clearTimer(name) {
  if (_pendingFlush[name]) {
    clearTimeout(_pendingFlush[name]);
    _pendingFlush[name] = null;
  }
}

function cloneStats() {
  reconcileWeeklyFromDaily(_stats);
  pruneWeeklyRetention(_stats);
  markRuntimeWeeklyCoverageGaps(_stats);
  return JSON.parse(JSON.stringify(_stats));
}

async function writeSnapshot(snapshot) {
  const tmp = STATS_FILE + '.tmp.' + process.pid;
  try {
    await fsp.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    await fsp.rename(tmp, STATS_FILE);
  } catch (err) {
    try { await fsp.unlink(tmp); } catch (_) {}
    throw err;
  }
}

function scheduleRetry() {
  if (_pendingFlush.writeFailures > 5) {
    console.error('[miser/stats] CRITICAL stats flush failed 6 consecutive times; retry paused');
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

function scheduleFlush(countMutation = true, delayMs = 5000) {
  if (countMutation) _pendingFlush.mutationCount += 1;
  if (!_pendingFlush.dirty && !_pendingFlush.inFlight) _persistence.pendingSince = Date.now();
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
  }, delayMs);
  if (typeof _pendingFlush.timer.unref === 'function') _pendingFlush.timer.unref();
}

function executeFlush() {
  if (_pendingFlush.inFlight) return _pendingFlush.currentPromise || Promise.resolve({ ok: true });

  clearTimer('timer');
  _pendingFlush.inFlight = true;
  _pendingFlush.dirty = false;
  _pendingFlush.mutationCount = 0;

  const promise = (async () => {
    let shouldReschedule = false;
    try {
      if (_persistence.lastLoadErrored) {
        const err = new Error('stats load failed; refusing to overwrite existing persisted data');
        err.code = _persistence.lastErrorCode || 'LOAD_ERROR';
        throw err;
      }
      const snapshot = cloneStats();
      await writeSnapshot(snapshot);
      _pendingFlush.lastFlushAt = Date.now();
      _pendingFlush.writeFailures = 0;
      _pendingFlush.lastFlushErrored = false;
      _pendingFlush.lastErrorCode = null;
      _persistence.lastErrorCode = null;
      _persistence.lastErrorMessage = null;
      shouldReschedule = _pendingFlush.dirty;
      if (!_pendingFlush.dirty) _persistence.pendingSince = null;
      return { ok: true, file: STATS_FILE };
    } catch (err) {
      _pendingFlush.dirty = true;
      if (_persistence.lastLoadErrored) {
        _pendingFlush.lastFlushErrored = false;
        _pendingFlush.lastErrorCode = null;
        _persistence.lastErrorCode = err.code || _persistence.lastErrorCode || 'LOAD_ERROR';
        _persistence.lastErrorMessage = err.message;
        console.error('[miser/stats] ERROR refusing flush after load failure:', err.message);
      } else {
        _pendingFlush.writeFailures += 1;
        _pendingFlush.lastFlushErrored = true;
        _pendingFlush.lastErrorCode = err.code || 'WRITE_ERROR';
        _persistence.lastErrorCode = _pendingFlush.lastErrorCode;
        _persistence.lastErrorMessage = err.message;
        console.error('[miser/stats] ERROR flush error:', err.message);
        scheduleRetry();
      }
      return {
        ok: false,
        error: err,
        errorCode: _pendingFlush.lastErrorCode || _persistence.lastErrorCode,
        file: STATS_FILE,
      };
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
  clearTimer('retryTimer');
  let lastResult = { ok: true, file: STATS_FILE };
  while (true) {
    if (_pendingFlush.inFlight) {
      lastResult = await (_pendingFlush.currentPromise || Promise.resolve(lastResult));
      if (_pendingFlush.dirty && (_pendingFlush.lastFlushErrored || _persistence.lastLoadErrored)) return lastResult;
      continue;
    }
    if (!_pendingFlush.dirty) {
      clearTimer('timer');
      return lastResult;
    }
    lastResult = await executeFlush();
    if (_pendingFlush.dirty && (_pendingFlush.lastFlushErrored || _persistence.lastLoadErrored)) return lastResult;
  }
}

function flushNow() {
  if (_pendingFlush.flushNowPromise) return _pendingFlush.flushNowPromise;
  _pendingFlush.flushNowPromise = drainFlushNow().finally(() => {
    _pendingFlush.flushNowPromise = null;
  });
  return _pendingFlush.flushNowPromise;
}

function getPendingWriteCount() {
  return _pendingFlush.mutationCount;
}

function getFlushLagMs() {
  return _pendingFlush.lastFlushAt == null ? null : Date.now() - _pendingFlush.lastFlushAt;
}

function getPersistenceStatus() {
  const pending = _pendingFlush.dirty || _pendingFlush.inFlight;
  const degraded = _pendingFlush.lastFlushErrored || _pendingFlush.writeFailures > 0
    || _persistence.lastLoadErrored;
  return {
    healthy: !degraded,
    durable: !degraded && !pending,
    pending,
    dirty: _pendingFlush.dirty,
    inFlight: _pendingFlush.inFlight,
    pendingSince: pending ? (_persistence.pendingSince || null) : null,
    lastFlushErrored: _pendingFlush.lastFlushErrored,
    lastLoadErrored: _persistence.lastLoadErrored,
    writeFailures: _pendingFlush.writeFailures,
    lastErrorCode: _pendingFlush.lastErrorCode || _persistence.lastErrorCode,
    lastErrorMessage: _persistence.lastErrorMessage,
    file: STATS_FILE,
  };
}

function getStatsMeta(statsObj, create = false) {
  if (!statsObj || typeof statsObj !== 'object' || Array.isArray(statsObj)) return null;
  const existing = statsObj[STATS_META_KEY];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) return existing;
  if (!create) return null;
  statsObj[STATS_META_KEY] = {};
  return statsObj[STATS_META_KEY];
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function dayKeyFromDate(date) {
  return date.toISOString().slice(0, 10);
}

function getZonedParts(date, timeZone = SUBSCRIPTION_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  if (parts.hour === 24) parts.hour = 0;
  return parts;
}

function utcForZonedTime(timeZone, year, month, day, hour, minute = 0, second = 0) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 4; i++) {
    const parts = getZonedParts(new Date(guess), timeZone);
    const observedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const delta = desiredAsUtc - observedAsUtc;
    if (delta === 0) return new Date(guess);
    guess += delta;
  }
  return new Date(guess);
}

function localDatePlusDays(parts, days) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 0, 0, 0));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function subscriptionWeekStartDate(date) {
  const timeZoneStatus = getSubscriptionTimeZoneStatus();
  if (!timeZoneStatus.supported) {
    if (!_timezoneFallbackWarned) {
      _timezoneFallbackWarned = true;
      console.warn(`[miser/stats] WARN ${SUBSCRIPTION_TIME_ZONE} timezone data unavailable (${timeZoneStatus.reason}); using Sunday 12:00 UTC weekly fallback`);
    }
    return subscriptionWeekStartFallbackDate(date);
  }
  try {
    const local = getZonedParts(date);
    const localDateUtc = new Date(Date.UTC(local.year, local.month - 1, local.day, 0, 0, 0));
    const daysSinceSunday = localDateUtc.getUTCDay();
    const thisSunday = localDatePlusDays(local, -daysSinceSunday);
    let boundary = utcForZonedTime(
      SUBSCRIPTION_TIME_ZONE,
      thisSunday.year,
      thisSunday.month,
      thisSunday.day,
      6,
      0,
      0,
    );
    if (date >= boundary) return boundary;
    const priorSunday = localDatePlusDays(thisSunday, -7);
    boundary = utcForZonedTime(
      SUBSCRIPTION_TIME_ZONE,
      priorSunday.year,
      priorSunday.month,
      priorSunday.day,
      6,
      0,
      0,
    );
    return boundary;
  } catch (err) {
    throw err;
  }
}

function subscriptionWeekStartFallbackDate(date) {
  // If the runtime lacks the America/Chicago zone database, preserve bounded
  // weekly accounting with a conservative CST reset: Sunday 12:00 UTC.
  const d = new Date(date);
  const daysSinceSunday = d.getUTCDay();
  const boundary = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceSunday, 12, 0, 0));
  if (date >= boundary) return boundary;
  boundary.setUTCDate(boundary.getUTCDate() - 7);
  return boundary;
}

function subscriptionWeekKeyFromDate(date) {
  return subscriptionWeekStartDate(date).toISOString();
}

function cutoffKeyForDays(days) {
  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
  return dayKeyFromDate(cutoff);
}

function parseDays(daysParam, defaultDays, maxDays = null) {
  let days = defaultDays;
  if (daysParam !== undefined) {
    if (!/^[0-9]+$/.test(String(daysParam))) {
      const err = new Error('invalid days parameter');
      err.statusCode = 400;
      throw err;
    }
    days = Number(daysParam);
    if (!Number.isSafeInteger(days) || days < 1) {
      const err = new Error('invalid days parameter');
      err.statusCode = 400;
      throw err;
    }
  }
  return maxDays == null ? days : Math.min(days, maxDays);
}

function isValidDailyKey(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const d = new Date(`${key}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === key;
}

function migrateStatsMeta(statsObj) {
  const meta = getStatsMeta(statsObj);
  if (!meta) return false;
  const current = meta[RECORDING_STARTED_AT_KEY];
  const hasLegacy = Object.prototype.hasOwnProperty.call(meta, DAILY_RETENTION_WATERMARK_KEY);
  const hasCurrent = Object.prototype.hasOwnProperty.call(meta, RECORDING_STARTED_AT_KEY);
  if (hasLegacy) {
    // dailyRetentionWatermark never shipped. Delete stale E3 snapshots instead of
    // resurrecting the legacy value as a compatibility boundary.
    delete meta[DAILY_RETENTION_WATERMARK_KEY];
  }
  return hasLegacy && !hasCurrent && !isValidDailyKey(current);
}

function deriveRecordingStartedAtFromDaily(statsObj) {
  const meta = getStatsMeta(statsObj);
  if (meta && Object.prototype.hasOwnProperty.call(meta, RECORDING_STARTED_AT_KEY)) return false;
  const earliestDailyKey = Object.keys(statsObj || {})
    .filter(isValidDailyKey)
    .sort()[0];
  if (!earliestDailyKey) return false;
  // This derivation is valid only while daily buckets are never pruned: for every
  // file this code has produced so far, the earliest surviving daily key is the
  // recording start. Any future daily retention policy must revisit this because
  // pruning would make the earliest surviving key newer than the real boundary.
  const targetMeta = getStatsMeta(statsObj, true);
  targetMeta[RECORDING_STARTED_AT_KEY] = earliestDailyKey;
  return true;
}

function getRecordingStartedAt(statsObj) {
  const meta = getStatsMeta(statsObj);
  if (!meta) return null;
  const current = meta[RECORDING_STARTED_AT_KEY];
  if (isValidDailyKey(current)) return current;
  return null;
}

function noteRecordingStartedAt(statsObj, day) {
  if (!isValidDailyKey(day)) return;
  const meta = getStatsMeta(statsObj, true);
  migrateStatsMeta(statsObj);
  const current = getRecordingStartedAt(statsObj);
  if (!current) meta[RECORDING_STARTED_AT_KEY] = day;
}

function ensureDayObserved(day) {
  if (!isValidDailyKey(day)) return false;
  noteRecordingStartedAt(_stats, day);
  const existing = _stats[day];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) return false;
  _stats[day] = {};
  return true;
}

function sealTodayObserved() {
  try {
    if (_persistence.lastLoadErrored) return false;
    const changed = ensureDayObserved(todayKey());
    if (changed) scheduleFlush(false, 0);
    return changed;
  } catch (err) {
    console.error('[miser/stats] ERROR observation seal failed:', err.message);
    return false;
  }
}

function startObservationSeal() {
  clearObservationSealTimers();
  _observationSeal.startupTimer = setTimeout(() => {
    _observationSeal.startupTimer = null;
    sealTodayObserved();
  }, 0);
  if (typeof _observationSeal.startupTimer.unref === 'function') _observationSeal.startupTimer.unref();

  _observationSeal.intervalTimer = setInterval(() => {
    sealTodayObserved();
  }, Math.max(MIN_OBSERVATION_SEAL_INTERVAL_MS, OBSERVATION_SEAL_INTERVAL_MS));
  if (typeof _observationSeal.intervalTimer.unref === 'function') _observationSeal.intervalTimer.unref();
}

function clearObservationSealTimers() {
  if (_observationSeal.startupTimer) {
    clearTimeout(_observationSeal.startupTimer);
    _observationSeal.startupTimer = null;
  }
  if (_observationSeal.intervalTimer) {
    clearInterval(_observationSeal.intervalTimer);
    _observationSeal.intervalTimer = null;
  }
}

function canRetainMutationAfterLoadFailure(label) {
  if (!_persistence.lastLoadErrored) return true;
  // Preserve at most one post-load-failure in-memory mutation for degraded
  // visibility. Once the refusal path has pending dirty data, dropping later
  // accounting mutations prevents unbounded growth while protecting the file.
  const canRetain = !_pendingFlush.dirty && !_pendingFlush.inFlight;
  if (!canRetain) noteDroppedMutationAfterLoadFailure(label);
  return canRetain;
}

function isAllowedRecordTime(date, label) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    noteRecordRejection(label, 'invalidTimestamp', 'invalid timestamp');
    return false;
  }
  const nowMs = Date.now();
  if (date.getTime() > nowMs + CLOCK_FUTURE_MS || date.getTime() < nowMs - CLOCK_PAST_MS) {
    noteRecordRejection(label, 'outOfBoundsTimestamp', `out-of-bounds timestamp ${date.toISOString()}`);
    return false;
  }
  return true;
}

function noteRecordRejection(label, reason, detail) {
  const nowIso = new Date().toISOString();
  _recordRejections.total += 1;
  _recordRejections[reason] += 1;
  _recordRejections.byLabel[label] = (_recordRejections.byLabel[label] || 0) + 1;
  if (!_recordRejections.firstRejectedAt) _recordRejections.firstRejectedAt = nowIso;
  _recordRejections.lastRejectedAt = nowIso;
  if (!_recordRejections.warned) {
    _recordRejections.warned = true;
    console.warn(`[miser/stats] WARN rejecting stats records; first=${label} ${detail}; further rejection logs suppressed, counters exposed in /api/miser/stats`);
  }
}

function noteDroppedMutationAfterLoadFailure(label) {
  noteRecordRejection(label, 'loadFailureRefusal', 'load-failure refusal');
  const nowIso = new Date().toISOString();
  if (!_recordRejections.firstDroppedAt) _recordRejections.firstDroppedAt = nowIso;
  _recordRejections.lastDroppedAt = nowIso;
}

function getRecordRejectionStatus() {
  return {
    total: _recordRejections.total,
    invalidTimestamp: _recordRejections.invalidTimestamp,
    outOfBoundsTimestamp: _recordRejections.outOfBoundsTimestamp,
    loadFailureRefusal: _recordRejections.loadFailureRefusal,
    byLabel: { ..._recordRejections.byLabel },
    firstRejectedAt: _recordRejections.firstRejectedAt,
    lastRejectedAt: _recordRejections.lastRejectedAt,
    firstDroppedAt: _recordRejections.firstDroppedAt,
    lastDroppedAt: _recordRejections.lastDroppedAt,
  };
}

function validWeekKey(key) {
  if (typeof key !== 'string') return false;
  const d = new Date(key);
  return Number.isFinite(d.getTime()) && d.toISOString() === key;
}

function expectedDailyKeysForWeek(weekKey, now = new Date()) {
  if (!validWeekKey(weekKey)) return [];
  const weekStart = new Date(weekKey);
  const today = todayKey();
  const nowDay = dayKeyFromDate(now);
  const maxDay = nowDay < today ? nowDay : today;
  const start = new Date(Date.UTC(
    weekStart.getUTCFullYear(),
    weekStart.getUTCMonth(),
    weekStart.getUTCDate(),
    12,
    0,
    0,
  ));
  const expected = [];
  for (let offset = 0; offset < 9; offset++) {
    const probe = new Date(start);
    probe.setUTCDate(probe.getUTCDate() + offset);
    const key = dayKeyFromDate(probe);
    if (key > maxDay) break;
    if (subscriptionWeekKeyFromDate(probe) === weekKey) expected.push(key);
  }
  return expected;
}

function dailyCoverageForWeek(statsObj, weekKey) {
  const expectedDays = expectedDailyKeysForWeek(weekKey);
  const presentDays = expectedDays
    .filter(day => {
      const dayData = statsObj && statsObj[day];
      return isValidDailyKey(day) && dayData && typeof dayData === 'object' && !Array.isArray(dayData);
    });
  const present = new Set(presentDays);
  const missingDays = expectedDays
    .filter(day => !present.has(day));
  return {
    complete: missingDays.length === 0,
    presentDays,
    missingDays,
    expectedDays,
    presentCount: presentDays.length,
    expectedCount: expectedDays.length,
  };
}

function nonAuthoritativeReasonForCoverage(coverage) {
  if (!coverage) return null;
  if (!coverage.complete) return 'missing_daily_observation';
  return null;
}

function coverageMetadataForWeek(statsObj, weekKey) {
  if (!validWeekKey(weekKey)) return null;
  const coverage = dailyCoverageForWeek(statsObj, weekKey);
  const reason = nonAuthoritativeReasonForCoverage(coverage);
  return reason ? { reason, coverage } : null;
}

function isCoverageAuthorityReason(reason) {
  return reason === 'missing_daily_observation';
}

function pruneWeeklyRetention(statsObj, now = new Date()) {
  const weekly = statsObj && statsObj[WEEKLY_KEY];
  if (!weekly || typeof weekly !== 'object') return;
  const currentWeekStart = subscriptionWeekKeyFromDate(now);
  const prior = Object.keys(weekly)
    .filter(key => validWeekKey(key) && key < currentWeekStart)
    .sort()
    .reverse();
  const keepPrior = new Set(prior.slice(0, WEEKLY_MAX_WEEKS));
  for (const key of Object.keys(weekly)) {
    if (!validWeekKey(key)) {
      delete weekly[key];
    } else if (key < currentWeekStart && !keepPrior.has(key)) {
      delete weekly[key];
    }
  }
}

function addOptimizerFields(target, source) {
  const hasOptimizer = !!(source && (source.dedup || source.cacheHint || source.toolPrune
    || Number.isFinite(source.likelyPollCount) || Number.isFinite(source.workTurnCount)));
  if (!hasOptimizer) return;
  ensureOptimizerFields(target);
  for (const tech of ['dedup', 'cacheHint', 'toolPrune']) {
    const src = source[tech];
    if (!src || typeof src !== 'object') continue;
    target[tech].estRemovedTokens += src.estRemovedTokens || 0;
    target[tech].inputTokensRemoved += src.inputTokensRemoved || 0;
    target[tech].cacheBillingDelta += src.cacheBillingDelta || 0;
    target[tech].appliedCount += src.appliedCount || 0;
    if (tech === 'toolPrune') target[tech].toolsRemovedCount += src.toolsRemovedCount || 0;
  }
  target.likelyPollCount += source.likelyPollCount || 0;
  target.workTurnCount += source.workTurnCount || 0;
}

function addGuardrailFields(target, source) {
  if (source.budget && typeof source.budget === 'object' && (source.budget.blockedCount || 0) > 0) {
    if (!target.budget) target.budget = { blockedCount: 0 };
    target.budget.blockedCount += source.budget.blockedCount;
    const first = source.budget.firstBlockedAt;
    if (typeof first === 'string' && (!target.budget.firstBlockedAt || first < target.budget.firstBlockedAt)) {
      target.budget.firstBlockedAt = first;
    }
  }
  if (source.policy && typeof source.policy === 'object') {
    const drift = source.policy.modelDriftCount || 0;
    const bloat = source.policy.contextBloatCount || 0;
    if (drift > 0 || bloat > 0) {
      if (!target.policy) target.policy = { modelDriftCount: 0, contextBloatCount: 0 };
      target.policy.modelDriftCount += drift;
      target.policy.contextBloatCount += bloat;
    }
  }
}

function buildWeeklyFromDaily(statsObj) {
  const weekly = {};
  for (const [day, dayData] of Object.entries(statsObj || {})) {
    if (!isValidDailyKey(day) || !dayData || typeof dayData !== 'object') continue;
    const weekKey = subscriptionWeekKeyFromDate(new Date(`${day}T12:00:00.000Z`));
    if (!weekly[weekKey]) weekly[weekKey] = {};
    for (const [project, projectData] of Object.entries(dayData)) {
      if (!projectData || typeof projectData !== 'object') continue;
      if (!weekly[weekKey][project]) weekly[weekKey][project] = {};
      const target = weekly[weekKey][project];
      addOptimizerFields(target, projectData);
      if (projectData.usage) addUsageTree(target.usage || (target.usage = {}), projectData.usage);
      addContextManagement(target, projectData.contextManagement);
      addGuardrailFields(target, projectData);
    }
  }
  return weekly;
}

function isWeeklyContainer(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function markWeekNonAuthoritative(weekData, reason, extra = null) {
  if (!isWeeklyContainer(weekData)) return weekData;
  weekData[WEEKLY_META_KEY] = {
    authoritative: false,
    reason,
  };
  if (extra && typeof extra === 'object') {
    weekData[WEEKLY_META_KEY].coverage = {
      presentDays: extra.presentDays,
      missingDays: extra.missingDays,
      expectedDays: extra.expectedDays,
      presentCount: extra.presentCount,
      expectedCount: extra.expectedCount,
    };
  }
  return weekData;
}

function markAllWeeklyNonAuthoritative(weekly, reason) {
  if (!isWeeklyContainer(weekly)) return;
  for (const [weekKey, weekData] of Object.entries(weekly)) {
    if (!validWeekKey(weekKey) || !isWeeklyContainer(weekData)) continue;
    markWeekNonAuthoritative(weekData, reason);
  }
}

function hasHardFailedWeeklyMigration(statsObj) {
  const weekly = statsObj && statsObj[WEEKLY_KEY];
  if (!isWeeklyContainer(weekly)) return false;
  return Object.entries(weekly).some(([weekKey, weekData]) => {
    if (!validWeekKey(weekKey) || !isWeeklyContainer(weekData)) return false;
    const meta = isWeeklyContainer(weekData[WEEKLY_META_KEY]) ? weekData[WEEKLY_META_KEY] : null;
    return meta && meta.authoritative === false && meta.reason === 'migration_retention_failed';
  });
}

function reconcileWeeklyFromDaily(statsObj) {
  if (hasHardFailedWeeklyMigration(statsObj)) return;
  const rebuilt = buildWeeklyFromDaily(statsObj);
  const reconciled = {};
  for (const [weekKey, weekData] of Object.entries(rebuilt)) {
    if (validWeekKey(weekKey)) {
      const coverageMeta = coverageMetadataForWeek(statsObj, weekKey);
      if (coverageMeta) {
        reconciled[weekKey] = markWeekNonAuthoritative(
          weekData,
          coverageMeta.reason,
          coverageMeta.coverage,
        );
        continue;
      }
    }
    reconciled[weekKey] = weekData;
  }
  if (Object.keys(reconciled).length > 0) statsObj[WEEKLY_KEY] = reconciled;
  else delete statsObj[WEEKLY_KEY];
}

function markRuntimeWeeklyCoverageGaps(statsObj) {
  const weekly = statsObj && statsObj[WEEKLY_KEY];
  if (!isWeeklyContainer(weekly)) return;
  for (const [weekKey, weekData] of Object.entries(weekly)) {
    if (!validWeekKey(weekKey) || !isWeeklyContainer(weekData)) continue;
    const meta = isWeeklyContainer(weekData[WEEKLY_META_KEY]) ? weekData[WEEKLY_META_KEY] : null;
    if (meta && meta.authoritative === false && !isCoverageAuthorityReason(meta.reason)) continue;
    const coverageMeta = coverageMetadataForWeek(statsObj, weekKey);
    if (coverageMeta) {
      markWeekNonAuthoritative(weekData, coverageMeta.reason, coverageMeta.coverage);
    } else if (meta && meta.authoritative === false && isCoverageAuthorityReason(meta.reason)) {
      delete weekData[WEEKLY_META_KEY];
    }
  }
}

function emptyTechniqueBucket() {
  return { estRemovedTokens: 0, inputTokensRemoved: 0, cacheBillingDelta: 0, appliedCount: 0 };
}

function emptyUsageBucket() {
  return { requests: 0 };
}

function ensureOptimizerFields(bucket) {
  if (!bucket.dedup) bucket.dedup = emptyTechniqueBucket();
  if (!bucket.cacheHint) bucket.cacheHint = emptyTechniqueBucket();
  if (!bucket.toolPrune) bucket.toolPrune = { estRemovedTokens: 0, inputTokensRemoved: 0, cacheBillingDelta: 0, appliedCount: 0, toolsRemovedCount: 0 };
  if (!Number.isFinite(bucket.likelyPollCount)) bucket.likelyPollCount = 0;
  if (!Number.isFinite(bucket.workTurnCount)) bucket.workTurnCount = 0;
  return bucket;
}

function ensureProjectBucketForDay(project, day) {
  const proj = project || 'default';
  ensureDayObserved(day);
  if (!_stats[day][proj]) _stats[day][proj] = {};
  return ensureOptimizerFields(_stats[day][proj]);
}

function ensureProjectBucketForWeek(project, week) {
  const proj = project || 'default';
  if (!_stats[WEEKLY_KEY] || typeof _stats[WEEKLY_KEY] !== 'object') _stats[WEEKLY_KEY] = {};
  if (!_stats[WEEKLY_KEY][week] || typeof _stats[WEEKLY_KEY][week] !== 'object') _stats[WEEKLY_KEY][week] = {};
  if (!_stats[WEEKLY_KEY][week][proj]) _stats[WEEKLY_KEY][week][proj] = {};
  return ensureOptimizerFields(_stats[WEEKLY_KEY][week][proj]);
}

function ensureProjectBucket(project, now = new Date()) {
  return ensureProjectBucketForDay(project, dayKeyFromDate(now));
}

function ensureMeasuredProjectBucketForDay(project, day) {
  const proj = project || 'default';
  ensureDayObserved(day);
  if (!_stats[day][proj]) _stats[day][proj] = {};
  return _stats[day][proj];
}

function ensureMeasuredProjectBucketForWeek(project, week) {
  const proj = project || 'default';
  if (!_stats[WEEKLY_KEY] || typeof _stats[WEEKLY_KEY] !== 'object') _stats[WEEKLY_KEY] = {};
  if (!_stats[WEEKLY_KEY][week] || typeof _stats[WEEKLY_KEY][week] !== 'object') _stats[WEEKLY_KEY][week] = {};
  if (!_stats[WEEKLY_KEY][week][proj]) _stats[WEEKLY_KEY][week][proj] = {};
  return _stats[WEEKLY_KEY][week][proj];
}

function ensureMeasuredProjectBucket(project, now = new Date()) {
  return ensureMeasuredProjectBucketForDay(project, dayKeyFromDate(now));
}

// Sprint B guardrail writers. Takes an EXPLICIT day string (not todayKey()) so
// an injected nowFn fully controls the day bucket — no midnight-split risk.
function ensureGuardrailBucket(project, dayKey) {
  const proj = project || 'default';
  ensureDayObserved(dayKey);
  if (!_stats[dayKey][proj]) _stats[dayKey][proj] = {};
  return _stats[dayKey][proj];
}

function ensureWeeklyGuardrailBucket(project, weekKey) {
  const proj = project || 'default';
  if (!_stats[WEEKLY_KEY] || typeof _stats[WEEKLY_KEY] !== 'object') _stats[WEEKLY_KEY] = {};
  if (!_stats[WEEKLY_KEY][weekKey] || typeof _stats[WEEKLY_KEY][weekKey] !== 'object') _stats[WEEKLY_KEY][weekKey] = {};
  if (!_stats[WEEKLY_KEY][weekKey][proj]) _stats[WEEKLY_KEY][weekKey][proj] = {};
  return _stats[WEEKLY_KEY][weekKey][proj];
}

// G3: sparse per-day per-project `budget` node { blockedCount, firstBlockedAt }.
// nowFn() is captured exactly ONCE per invocation; dayKey and firstBlockedAt
// both derive from that single capture.
function recordBudgetBlock(project, nowFn = () => new Date()) {
  const now = nowFn();
  if (!isAllowedRecordTime(now, 'budget')) return 0;
  if (!canRetainMutationAfterLoadFailure('budget')) return 0;
  const dayKey = now.toISOString().slice(0, 10);
  const weekKey = subscriptionWeekKeyFromDate(now);
  const bucket = ensureGuardrailBucket(project, dayKey);
  const weekBucket = ensureWeeklyGuardrailBucket(project, weekKey);
  if (!bucket.budget) bucket.budget = { blockedCount: 0 };
  if (!weekBucket.budget) weekBucket.budget = { blockedCount: 0 };
  bucket.budget.blockedCount += 1;
  weekBucket.budget.blockedCount += 1;
  if (!bucket.budget.firstBlockedAt) bucket.budget.firstBlockedAt = now.toISOString();
  if (!weekBucket.budget.firstBlockedAt) weekBucket.budget.firstBlockedAt = now.toISOString();
  scheduleFlush();
  return bucket.budget.blockedCount;
}

// B6: sparse per-day per-project `policy` node { modelDriftCount, contextBloatCount }.
// Same single-capture nowFn pattern. Returns the updated counts (alert text
// uses the today-count).
function recordPolicyEvent(project, { drift = false, bloat = false } = {}, nowFn = () => new Date()) {
  if (!drift && !bloat) return { modelDriftCount: 0, contextBloatCount: 0 }; // no-op: never write zero node
  const now = nowFn();
  if (!isAllowedRecordTime(now, 'policy')) return { modelDriftCount: 0, contextBloatCount: 0 };
  if (!canRetainMutationAfterLoadFailure('policy')) return { modelDriftCount: 0, contextBloatCount: 0 };
  const dayKey = now.toISOString().slice(0, 10);
  const weekKey = subscriptionWeekKeyFromDate(now);
  const bucket = ensureGuardrailBucket(project, dayKey);
  const weekBucket = ensureWeeklyGuardrailBucket(project, weekKey);
  if (!bucket.policy) bucket.policy = { modelDriftCount: 0, contextBloatCount: 0 };
  if (!weekBucket.policy) weekBucket.policy = { modelDriftCount: 0, contextBloatCount: 0 };
  if (drift) bucket.policy.modelDriftCount += 1;
  if (drift) weekBucket.policy.modelDriftCount += 1;
  if (bloat) bucket.policy.contextBloatCount += 1;
  if (bloat) weekBucket.policy.contextBloatCount += 1;
  scheduleFlush();
  return { modelDriftCount: bucket.policy.modelDriftCount, contextBloatCount: bucket.policy.contextBloatCount };
}

function applyOptimizerStats(bucket, opts = {}) {
  const {
    inputTokensRemoved = 0,
    cacheBillingDelta = 0,
    toolsRemoved = 0,
    pollClass,
    techniques = {},
  } = opts;

  if (techniques.dedup && inputTokensRemoved > 0) {
    bucket.dedup.estRemovedTokens = (bucket.dedup.estRemovedTokens || 0) + inputTokensRemoved;
    bucket.dedup.inputTokensRemoved += inputTokensRemoved;
    bucket.dedup.appliedCount += 1;
  }
  if (techniques.cacheHint) {
    bucket.cacheHint.cacheBillingDelta += cacheBillingDelta;
    bucket.cacheHint.appliedCount += 1;
  }
  if (techniques.toolPrune && toolsRemoved > 0) {
    bucket.toolPrune.toolsRemovedCount += toolsRemoved;
    bucket.toolPrune.appliedCount += 1;
  }
  if (pollClass === 'likely') {
    bucket.likelyPollCount += 1;
  } else if (pollClass === 'unlikely') {
    bucket.workTurnCount += 1;
  }
}

// opts: { inputTokensRemoved, cacheBillingDelta, toolsRemoved, techniques }
function recordStats(project, opts = {}, nowFn = () => new Date()) {
  const now = nowFn();
  if (!isAllowedRecordTime(now, 'optimizer')) return;
  if (!canRetainMutationAfterLoadFailure('optimizer')) return;
  const day = dayKeyFromDate(now);
  const observedChanged = ensureDayObserved(day);
  const bucket = ensureProjectBucketForDay(project, day);
  const weekBucket = ensureProjectBucketForWeek(project, subscriptionWeekKeyFromDate(now));

  applyOptimizerStats(bucket, opts);
  applyOptimizerStats(weekBucket, opts);

  scheduleFlush(true, observedChanged ? 0 : 5000);
}

function finitePositive(n) {
  return Number.isFinite(n) && n > 0;
}

function addMeasured(bucket, key, value) {
  if (!finitePositive(value)) return;
  bucket[key] = (bucket[key] || 0) + value;
}

function normalizeUsage(raw = {}) {
  const out = {};
  addMeasured(out, 'input', raw.input_tokens);
  addMeasured(out, 'output', raw.output_tokens);
  addMeasured(out, 'cacheRead', raw.cache_read_input_tokens);
  const creation = raw.cache_creation && typeof raw.cache_creation === 'object'
    ? raw.cache_creation
    : {};
  addMeasured(out, 'cacheWrite5m', creation.ephemeral_5m_input_tokens);
  addMeasured(out, 'cacheWrite1h', creation.ephemeral_1h_input_tokens);
  if (!raw.cache_creation || typeof raw.cache_creation !== 'object') {
    addMeasured(out, 'cacheWrite1h', raw.cache_creation_input_tokens);
  }
  return out;
}

function normalizeAppliedEdits(appliedEdits) {
  if (!Array.isArray(appliedEdits) || appliedEdits.length === 0) return null;
  const out = { clearedToolUses: 0, clearedInputTokens: 0, editCount: appliedEdits.length };
  for (const edit of appliedEdits) {
    if (!edit || typeof edit !== 'object') continue;
    const toolUses = edit.cleared_tool_uses ?? edit.clearedToolUses ?? edit.cleared_tool_use_count;
    const inputTokens = edit.cleared_input_tokens ?? edit.clearedInputTokens;
    if (Number.isFinite(toolUses)) out.clearedToolUses += toolUses;
    if (Number.isFinite(inputTokens)) out.clearedInputTokens += inputTokens;
  }
  return out;
}

function applyMeasuredUsage(bucket, providerKey, modelKey, usage, editStats) {
  const hasMeasuredAxis = Object.keys(usage).length > 0;

  if (hasMeasuredAxis) {
    if (!bucket.usage) bucket.usage = {};
    if (!bucket.usage[providerKey]) bucket.usage[providerKey] = {};
    if (!bucket.usage[providerKey][modelKey]) bucket.usage[providerKey][modelKey] = emptyUsageBucket();
    const usageBucket = bucket.usage[providerKey][modelKey];
    usageBucket.requests += 1;
    for (const [key, value] of Object.entries(usage)) {
      usageBucket[key] = (usageBucket[key] || 0) + value;
    }
  }

  if (editStats) {
    if (!bucket.contextManagement) {
      bucket.contextManagement = { clearedToolUses: 0, clearedInputTokens: 0, editCount: 0 };
    }
    bucket.contextManagement.clearedToolUses += editStats.clearedToolUses;
    bucket.contextManagement.clearedInputTokens += editStats.clearedInputTokens;
    bucket.contextManagement.editCount += editStats.editCount;
  }

  return hasMeasuredAxis || !!editStats;
}

function recordAnthropicUsage(project, provider, model, rawUsage = {}, appliedEdits = null, nowFn = () => new Date()) {
  const now = nowFn();
  if (!isAllowedRecordTime(now, 'usage')) return;
  if (!canRetainMutationAfterLoadFailure('usage')) return;
  const day = dayKeyFromDate(now);
  const observedChanged = ensureDayObserved(day);
  const bucket = ensureMeasuredProjectBucketForDay(project, day);
  const weekBucket = ensureMeasuredProjectBucketForWeek(project, subscriptionWeekKeyFromDate(now));
  const providerKey = provider || 'anthropic';
  const modelKey = model || 'unknown';
  const usage = normalizeUsage(rawUsage);
  const hasMeasuredAxis = Object.keys(usage).length > 0;
  const editStats = normalizeAppliedEdits(appliedEdits);

  applyMeasuredUsage(bucket, providerKey, modelKey, usage, editStats);
  applyMeasuredUsage(weekBucket, providerKey, modelKey, usage, editStats);

  if (hasMeasuredAxis || editStats || observedChanged) scheduleFlush(true, observedChanged ? 0 : 5000);
  if (usage.cacheWrite5m > 0) {
    console.warn(`[miser] WARN cacheWrite5m observed over 24h window project=${project || 'default'} provider=${providerKey} model=${modelKey}`);
  }
}

function addUsageTree(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const [provider, models] of Object.entries(source)) {
    if (!models || typeof models !== 'object') continue;
    if (!target[provider]) target[provider] = {};
    for (const [model, bucket] of Object.entries(models)) {
      if (!bucket || typeof bucket !== 'object') continue;
      if (!target[provider][model]) target[provider][model] = emptyUsageBucket();
      const out = target[provider][model];
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'requests']) {
        if (Number.isFinite(bucket[key])) out[key] = (out[key] || 0) + bucket[key];
      }
    }
  }
}

function addContextManagement(target, source) {
  if (!source || typeof source !== 'object') return;
  if (!target.contextManagement) {
    target.contextManagement = { clearedToolUses: 0, clearedInputTokens: 0, editCount: 0 };
  }
  target.contextManagement.clearedToolUses += source.clearedToolUses || 0;
  target.contextManagement.clearedInputTokens += source.clearedInputTokens || 0;
  target.contextManagement.editCount += source.editCount || 0;
}

function weightedTokenEquivalents(usage, weights = DEFAULT_WEIGHTS) {
  const byProject = {};
  let total = 0;
  for (const [project, projectData] of Object.entries(usage || {})) {
    byProject[project] = {};
    for (const [provider, models] of Object.entries(projectData || {})) {
      byProject[project][provider] = {};
      for (const [model, bucket] of Object.entries(models || {})) {
        const value =
          (bucket.input || 0) * weights.input
          + (bucket.cacheRead || 0) * weights.cacheRead
          + (bucket.cacheWrite5m || 0) * weights.cacheWrite5m
          + (bucket.cacheWrite1h || 0) * weights.cacheWrite1h
          + (bucket.output || 0) * weights.output;
        byProject[project][provider][model] = value;
        total += value;
      }
    }
  }
  return { total, byProject };
}

function projectHasMeasuredUsage(projData) {
  return !!(projData && projData.usage && typeof projData.usage === 'object');
}

function accumulateProjectAggregate(perProject, proj, projData, projectFilter) {
  if (proj === WEEKLY_META_KEY) return;
  if (projectFilter && proj !== projectFilter) return;
  // No-fabrication guard (Sprint B): legacy bucket init fires only for
  // projects with usage, contextManagement, or any legacy optimizer key in
  // the raw day data (unchanged baseline — all existing project categories
  // preserved). Projects with EXCLUSIVELY guardrail keys (budget/policy)
  // must not appear with fabricated zeroed legacy buckets.
  const hasLegacy = !!(projData.usage || projData.contextManagement
    || projData.dedup || projData.cacheHint || projData.toolPrune);
  // Guardrail activity only counts when counts are positive (sparse contract §2.3).
  const hasGuardrail = (projData.budget && (projData.budget.blockedCount || 0) > 0)
    || (projData.policy && ((projData.policy.modelDriftCount || 0) > 0 || (projData.policy.contextBloatCount || 0) > 0));
  if (!hasLegacy && !hasGuardrail) return;
  if (!perProject[proj]) perProject[proj] = {};
  const target = perProject[proj];
  if (hasLegacy && !target.dedup) {
    target.dedup = emptyTechniqueBucket();
    target.cacheHint = emptyTechniqueBucket();
    target.toolPrune = { estRemovedTokens: 0, inputTokensRemoved: 0, cacheBillingDelta: 0, appliedCount: 0, toolsRemovedCount: 0 };
    target.pollClass = { likely: 0, work: 0 };
  }
  if (target.dedup) {
    for (const tech of ['dedup', 'cacheHint', 'toolPrune']) {
      if (!projData[tech]) continue;
      target[tech].estRemovedTokens += projData[tech].estRemovedTokens || projData[tech].inputTokensRemoved || 0;
      target[tech].inputTokensRemoved += projData[tech].inputTokensRemoved || 0;
      target[tech].cacheBillingDelta += projData[tech].cacheBillingDelta || 0;
      target[tech].appliedCount += projData[tech].appliedCount || 0;
      if (tech === 'toolPrune') {
        target[tech].toolsRemovedCount += projData[tech].toolsRemovedCount || 0;
      }
    }
    target.pollClass.likely += projData.likelyPollCount || 0;
    target.pollClass.work += projData.workTurnCount || 0;
  }
  addUsageTree(target.usage || (projData.usage ? (target.usage = {}) : {}), projData.usage);
  addContextManagement(target, projData.contextManagement);
  // Sprint B guardrail aggregation across the selected window (sparse):
  // blockedCount / drift / bloat counts summed; firstBlockedAt = EARLIEST
  // ISO timestamp across all buckets in the window.
  // Sparse contract (§2.3): only emit budget node when blockedCount > 0,
  // only emit policy node when at least one count > 0. Never fabricate zeroes.
  if (projData.budget && typeof projData.budget === 'object'
      && (projData.budget.blockedCount || 0) > 0) {
    if (!target.budget) target.budget = { blockedCount: 0 };
    target.budget.blockedCount += projData.budget.blockedCount;
    const first = projData.budget.firstBlockedAt;
    if (typeof first === 'string' && (!target.budget.firstBlockedAt || first < target.budget.firstBlockedAt)) {
      target.budget.firstBlockedAt = first;
    }
  }
  if (projData.policy && typeof projData.policy === 'object') {
    const dc = projData.policy.modelDriftCount || 0;
    const bc = projData.policy.contextBloatCount || 0;
    if (dc > 0 || bc > 0) {
      if (!target.policy) target.policy = { modelDriftCount: 0, contextBloatCount: 0 };
      target.policy.modelDriftCount += dc;
      target.policy.contextBloatCount += bc;
    }
  }
}

function finalizeAggregate(perProject, weights = DEFAULT_WEIGHTS) {
  const perTechnique = {
    dedup: emptyTechniqueBucket(),
    cacheHint: emptyTechniqueBucket(),
    toolPrune: { estRemovedTokens: 0, inputTokensRemoved: 0, cacheBillingDelta: 0, appliedCount: 0, toolsRemovedCount: 0 },
  };
  for (const projData of Object.values(perProject)) {
    if (!projData.dedup) continue; // guardrail-only project — no legacy buckets to roll up
    for (const tech of ['dedup', 'cacheHint', 'toolPrune']) {
      perTechnique[tech].inputTokensRemoved += projData[tech].inputTokensRemoved;
      perTechnique[tech].estRemovedTokens += projData[tech].estRemovedTokens;
      perTechnique[tech].cacheBillingDelta += projData[tech].cacheBillingDelta;
      perTechnique[tech].appliedCount += projData[tech].appliedCount;
      if (tech === 'toolPrune') {
        perTechnique[tech].toolsRemovedCount += projData[tech].toolsRemovedCount || 0;
      }
    }
  }

  const usage = {};
  let anthropicEstCostUSD = 0;
  for (const [project, projectData] of Object.entries(perProject)) {
    if (projectData.usage) usage[project] = projectData.usage;
    projectData.anthropicEstCostUSD = computeCost(projectData.usage || {});
    anthropicEstCostUSD += projectData.anthropicEstCostUSD;
  }
  anthropicEstCostUSD = Math.round(anthropicEstCostUSD * 1e6) / 1e6;

  const totals = {
    inputTokensRemoved: (perTechnique.dedup.inputTokensRemoved || 0) + (perTechnique.cacheHint.inputTokensRemoved || 0),
    estRemovedTokens: (perTechnique.dedup.estRemovedTokens || 0) + (perTechnique.cacheHint.estRemovedTokens || 0),
    cacheBillingDelta: Object.values(perTechnique).reduce((sum, t) => sum + t.cacheBillingDelta, 0),
    appliedCount: Object.values(perTechnique).reduce((sum, t) => sum + t.appliedCount, 0),
    toolsRemovedCount: perTechnique.toolPrune.toolsRemovedCount || 0,
    anthropicEstCostUSD,
  };

  return {
    perTechnique,
    perProject,
    usage,
    weightedTokenEquivalents: weightedTokenEquivalents(usage, weights),
    totals,
  };
}

function aggregatePeriod(periodData, projectFilter, weights = DEFAULT_WEIGHTS) {
  const perProject = {};
  if (periodData && typeof periodData === 'object') {
    for (const [proj, projData] of Object.entries(periodData)) {
      if (!projData || typeof projData !== 'object') continue;
      accumulateProjectAggregate(perProject, proj, projData, projectFilter);
    }
  }
  return finalizeAggregate(perProject, weights);
}

function getSubscriptionWeeks(projectFilter, weights = DEFAULT_WEIGHTS, now = new Date()) {
  reconcileWeeklyFromDaily(_stats);
  pruneWeeklyRetention(_stats, now);
  const weeklyData = (_stats[WEEKLY_KEY] && typeof _stats[WEEKLY_KEY] === 'object') ? _stats[WEEKLY_KEY] : {};
  const currentWeekStart = subscriptionWeekKeyFromDate(now);
  const persistence = getPersistenceStatus();
  const persistenceMeta = !(persistence.healthy && persistence.durable)
    ? { authoritative: false, reason: 'persistence_degraded' }
    : null;
  const makeWeek = (weekStart, complete) => {
    const weekData = weeklyData[weekStart];
    const storedMeta = isWeeklyContainer(weekData) && isWeeklyContainer(weekData[WEEKLY_META_KEY])
      ? weekData[WEEKLY_META_KEY] : null;
    const coverageMeta = !isWeeklyContainer(weekData)
      || (storedMeta && storedMeta.authoritative === false && !isCoverageAuthorityReason(storedMeta.reason))
      ? null
      : coverageMetadataForWeek(_stats, weekStart);
    const meta = (storedMeta && storedMeta.authoritative === false && !isCoverageAuthorityReason(storedMeta.reason))
      ? storedMeta
      : coverageMeta && {
        authoritative: false,
        reason: coverageMeta.reason,
        coverage: coverageMeta.coverage,
      };
    const effectiveMeta = persistenceMeta || meta;
    const authoritative = !(effectiveMeta && effectiveMeta.authoritative === false);
    const out = {
      weekStart,
      complete,
      authoritative,
      degraded: !authoritative,
      ...aggregatePeriod(weekData, projectFilter, weights),
    };
    if (effectiveMeta && typeof effectiveMeta.reason === 'string') out.nonAuthoritativeReason = effectiveMeta.reason;
    if (meta && isWeeklyContainer(meta.coverage)) out.coverage = meta.coverage;
    return out;
  };
  const priorCompleteWeeks = Object.keys(weeklyData)
    .filter(key => validWeekKey(key) && key < currentWeekStart)
    .sort()
    .reverse()
    .slice(0, WEEKLY_MAX_WEEKS)
    .map(weekStart => makeWeek(weekStart, true));
  const currentWeekToDate = makeWeek(currentWeekStart, false);
  const authoritative = currentWeekToDate.authoritative
    && priorCompleteWeeks.every(week => week.authoritative);

  return {
    timeZone: SUBSCRIPTION_TIME_ZONE,
    localReset: 'Sunday 06:00',
    authoritative,
    degraded: !authoritative,
    currentWeekStart,
    currentWeekToDate,
    priorCompleteWeeks,
  };
}

function weeklyAuthorityRollup(weekly) {
  const weeks = [
    weekly && weekly.currentWeekToDate,
    ...((weekly && Array.isArray(weekly.priorCompleteWeeks)) ? weekly.priorCompleteWeeks : []),
  ].filter(Boolean);
  const nonAuthoritative = weeks.filter(week => week.authoritative === false);
  const reasons = [];
  const seen = new Set();
  for (const week of nonAuthoritative) {
    const reason = week.nonAuthoritativeReason;
    if (typeof reason !== 'string' || seen.has(reason)) continue;
    seen.add(reason);
    reasons.push(reason);
  }
  return {
    weeklyAuthoritative: nonAuthoritative.length === 0,
    nonAuthoritativeWeekCount: nonAuthoritative.length,
    nonAuthoritativeReasons: reasons,
  };
}

function getStats(daysParam, projectFilter, weights = DEFAULT_WEIGHTS) {
  const days = parseDays(daysParam, 7);
  const cutoffKey = cutoffKeyForDays(days);

  const perProject = {};
  for (const [day, dayData] of Object.entries(_stats)) {
    if (!isValidDailyKey(day)) continue;
    if (day < cutoffKey || !dayData || typeof dayData !== 'object') continue;
    for (const [proj, projData] of Object.entries(dayData)) {
      if (!projData || typeof projData !== 'object') continue;
      accumulateProjectAggregate(perProject, proj, projData, projectFilter);
    }
  }
  const aggregate = finalizeAggregate(perProject, weights);
  const persistence = getPersistenceStatus();
  const authoritative = persistence.healthy && persistence.durable;
  const weekly = getSubscriptionWeeks(projectFilter, weights);
  const weeklyRollup = weeklyAuthorityRollup(weekly);

  return {
    ok: authoritative,
    days,
    since: cutoffKey,
    ...aggregate,
    recordRejections: getRecordRejectionStatus(),
    durable: persistence.durable,
    degraded: !persistence.healthy,
    authoritative,
    persistence,
    ...weeklyRollup,
    weekly,
  };
}

function summarizeUsage(usageTree) {
  const out = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  };
  for (const models of Object.values(usageTree || {})) {
    if (!models || typeof models !== 'object') continue;
    for (const bucket of Object.values(models)) {
      if (!bucket || typeof bucket !== 'object') continue;
      out.input += bucket.input || 0;
      out.output += bucket.output || 0;
      out.cacheRead += bucket.cacheRead || 0;
      out.cacheWrite5m += bucket.cacheWrite5m || 0;
      out.cacheWrite1h += bucket.cacheWrite1h || 0;
    }
  }
  return out;
}

function getDailyTrend(daysParam, projectFilter) {
  const days = parseDays(daysParam, 30, 90);
  const cutoffKey = cutoffKeyForDays(days);
  const entries = [];

  const dayKeys = Object.keys(_stats).filter(day => isValidDailyKey(day) && day >= cutoffKey).sort();
  for (const day of dayKeys) {
    const dayData = _stats[day];
    if (!dayData || typeof dayData !== 'object') continue;
    const projects = Object.keys(dayData).sort();
    for (const project of projects) {
      if (projectFilter && project !== projectFilter) continue;
      const projData = dayData[project];
      if (!projectHasMeasuredUsage(projData)) continue;
      entries.push({
        date: day,
        project,
        ...summarizeUsage(projData.usage),
        anthropicEstCostUSD: computeCost(projData.usage),
      });
    }
  }

  const persistence = getPersistenceStatus();
  const authoritative = persistence.healthy && persistence.durable;
  return {
    ok: authoritative,
    days,
    since: cutoffKey,
    entries,
    recordRejections: getRecordRejectionStatus(),
    durable: persistence.durable,
    degraded: !persistence.healthy,
    authoritative,
    persistence,
  };
}

function __resetForTest() {
  _stats = {};
  clearTimer('timer');
  clearTimer('retryTimer');
  clearObservationSealTimers();
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
  _persistence.lastLoadAt = null;
  _persistence.pendingSince = null;
  _recordRejections.total = 0;
  _recordRejections.invalidTimestamp = 0;
  _recordRejections.outOfBoundsTimestamp = 0;
  _recordRejections.loadFailureRefusal = 0;
  _recordRejections.byLabel = {};
  _recordRejections.firstRejectedAt = null;
  _recordRejections.lastRejectedAt = null;
  _recordRejections.firstDroppedAt = null;
  _recordRejections.lastDroppedAt = null;
  _recordRejections.warned = false;
  _timeZoneStatus = null;
  _timeZoneUnsupportedRetries = 0;
  _timezoneFallbackWarned = false;
}

function getRawStatsSnapshot() {
  return cloneStats();
}

module.exports = {
  recordStats,
  recordAnthropicUsage,
  recordBudgetBlock,
  recordPolicyEvent,
  getStats,
  getDailyTrend,
  loadStats,
  weightedTokenEquivalents,
  computeCost,
  scheduleFlush,
  executeFlush,
  flushNow,
  getPendingWriteCount,
  getFlushLagMs,
  getPersistenceStatus,
  getRawStatsSnapshot,
  __resetForTest,
  __test: {
    _pendingFlush,
    _persistence,
    subscriptionWeekKeyFromDate,
    subscriptionWeekStartDate,
    subscriptionWeekStartFallbackDate,
    isValidDailyKey,
    getSubscriptionTimeZoneStatus,
    getRecordRejectionStatus,
    migrateStatsMeta,
    getRecordingStartedAt,
    ensureDayObserved,
    sealTodayObserved,
    _observationSeal,
    reconcileWeeklyFromDaily,
    dailyCoverageForWeek,
    WEEKLY_MAX_WEEKS,
    CLOCK_PAST_MS,
    CLOCK_FUTURE_MS,
    WEEKLY_KEY,
    WEEKLY_META_KEY,
    STATS_META_KEY,
    DAILY_RETENTION_WATERMARK_KEY,
    RECORDING_STARTED_AT_KEY,
  },
};
