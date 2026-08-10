'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const WEEKLY_CAPS_FILE = process.env.MISER_WEEKLY_CAPS_FILE
  || path.join(os.homedir(), '.claude', 'weekly-caps.json');
const CAP_REVALIDATE_MS = 60_000; // Sourced from weekly-pace-gauge §12.3.

const MISER_METHOD_ID = crypto.createHash('sha256').update(JSON.stringify({
  traffic: 'anthropic routed through miser only',
  dedupe: 'none; response-path provider usage observations',
  weights: { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 },
  modelMultipliers: 'none',
})).digest('hex').slice(0, 12);

let cached = null;

function parseJson(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, reason: 'parse-error', message: err.message };
  }
}

function readWeeklyCapsFile(now = new Date()) {
  let stat;
  try {
    stat = fs.statSync(WEEKLY_CAPS_FILE);
  } catch (err) {
    return {
      capSource: 'absent',
      reason: err && err.code === 'ENOENT' ? 'cap-absent' : 'cap-unreadable',
      path: WEEKLY_CAPS_FILE,
      asOf: now.toISOString(),
    };
  }

  const cacheKey = `${stat.mtimeMs}:${stat.size}`;
  if (cached && cached.cacheKey === cacheKey && (now.getTime() - cached.readAtMs) < CAP_REVALIDATE_MS) {
    return { ...cached.result, asOf: now.toISOString() };
  }

  let raw;
  try {
    raw = fs.readFileSync(WEEKLY_CAPS_FILE, 'utf8');
  } catch (_) {
    return { capSource: 'absent', reason: 'cap-unreadable', path: WEEKLY_CAPS_FILE, asOf: now.toISOString() };
  }
  const parsed = parseJson(raw);
  if (!parsed.ok) {
    return { capSource: 'absent', reason: parsed.reason, path: WEEKLY_CAPS_FILE, asOf: now.toISOString() };
  }

  const doc = parsed.value;
  const result = deriveCap(doc, now);
  result.path = WEEKLY_CAPS_FILE;
  cached = { cacheKey, readAtMs: now.getTime(), result: { ...result } };
  return result;
}

function unitForMethod(methodId) {
  return `weighted_opus_equivalent_tokens_v${methodId}`;
}

function configuredCap(doc, now) {
  const claude = doc && doc.caps && doc.caps.claude;
  if (!claude || typeof claude !== 'object') return null;
  if (!Number.isFinite(claude.value) || claude.value <= 0) return null;
  const methodId = typeof doc.method_id === 'string' ? doc.method_id : '';
  const unit = typeof claude.unit === 'string' ? claude.unit : '';
  return {
    capSource: 'configured',
    weeklyCap: claude.value,
    capUnit: unit,
    capMethodId: methodId,
    capAsOf: now.toISOString(),
    unitMatches: unit === unitForMethod(MISER_METHOD_ID) && methodId === MISER_METHOD_ID,
    mismatchReason: unit !== unitForMethod(MISER_METHOD_ID) || methodId !== MISER_METHOD_ID ? 'unit-mismatch' : null,
    raw: { cap: claude.value, unit, method_id: methodId },
  };
}

function calibrationCap(doc, now) {
  const cal = doc && doc.calibration;
  if (!cal || typeof cal !== 'object') return null;
  const observedFraction = Number(cal.observed_fraction);
  const anchorWeekStart = typeof cal.anchor_week_start === 'string' ? cal.anchor_week_start : '';
  if (!Number.isFinite(observedFraction) || observedFraction <= 0) return null;
  if (!anchorWeekStart) return null;
  const range = cal.range && typeof cal.range === 'object'
    ? { low: Number(cal.range.low), high: Number(cal.range.high) }
    : null;
  const stalenessWeeks = Number.isFinite(cal.staleness_weeks) && cal.staleness_weeks >= 0
    ? cal.staleness_weeks
    : 8;
  return {
    capSource: 'estimated',
    capUnit: unitForMethod(MISER_METHOD_ID),
    capMethodId: MISER_METHOD_ID,
    capAsOf: now.toISOString(),
    calibration: {
      anchorWeekStart,
      observedFraction,
      range,
      stalenessWeeks,
    },
    estimate: true,
    unitMatches: true,
    estimateNotes: ['mix drift: not evaluated'],
  };
}

function deriveCap(doc, now = new Date()) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { capSource: 'absent', reason: 'schema-unknown', asOf: now.toISOString() };
  }
  if (doc.schema_version !== 1) {
    return { capSource: 'absent', reason: 'schema-unknown', asOf: now.toISOString() };
  }
  const configured = configuredCap(doc, now);
  if (configured) return configured;
  const estimated = calibrationCap(doc, now);
  if (estimated) return estimated;
  return { capSource: 'absent', reason: 'cap-absent', asOf: now.toISOString() };
}

function __resetForTest() {
  cached = null;
}

module.exports = {
  WEEKLY_CAPS_FILE,
  MISER_METHOD_ID,
  CAP_REVALIDATE_MS,
  unitForMethod,
  readWeeklyCapsFile,
  deriveCap,
  __resetForTest,
};
