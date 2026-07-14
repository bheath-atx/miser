'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Persisted per-day x per-project x per-technique stats.
// Atomic write (temp+rename) so process restarts do not corrupt the file.
const STATS_FILE = process.env.MISER_STATS_FILE
  || path.join(os.homedir(), '.miser-stats.json');

let _stats = loadStats();

function loadStats() {
  try {
    const raw = fs.readFileSync(STATS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (_) {
    return {};
  }
}

function flushStats() {
  const tmp = STATS_FILE + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(_stats, null, 2), 'utf8');
    fs.renameSync(tmp, STATS_FILE);
  } catch (err) {
    console.error('[miser/stats] flush error:', err.message);
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function emptyTechniqueBucket() {
  return { inputTokensRemoved: 0, cacheBillingDelta: 0, appliedCount: 0 };
}

function ensureProjectBucket(project) {
  const day = todayKey();
  const proj = project || 'default';
  if (!_stats[day]) _stats[day] = {};
  if (!_stats[day][proj]) _stats[day][proj] = {};
  const bucket = _stats[day][proj];

  if (!bucket.dedup) bucket.dedup = emptyTechniqueBucket();
  if (!bucket.cacheHint) bucket.cacheHint = emptyTechniqueBucket();
  if (!bucket.toolPrune) bucket.toolPrune = emptyTechniqueBucket();
  return bucket;
}

// opts: { inputTokensRemoved, cacheBillingDelta, toolsRemoved, techniques }
function recordStats(project, opts = {}) {
  const bucket = ensureProjectBucket(project);
  const {
    inputTokensRemoved = 0,
    cacheBillingDelta = 0,
    toolsRemoved = 0,
    techniques = {},
  } = opts;

  if (techniques.dedup && inputTokensRemoved > 0) {
    bucket.dedup.inputTokensRemoved += inputTokensRemoved;
    bucket.dedup.appliedCount += 1;
  }
  if (techniques.cacheHint) {
    bucket.cacheHint.cacheBillingDelta += cacheBillingDelta;
    bucket.cacheHint.appliedCount += 1;
  }
  if (techniques.toolPrune && toolsRemoved > 0) {
    bucket.toolPrune.inputTokensRemoved += toolsRemoved;
    bucket.toolPrune.appliedCount += 1;
  }

  flushStats();
}

// GET /api/miser/stats?days=N[&project=X]
// Returns { ok, days, since, perTechnique, perProject, totals }.
// Throws { statusCode: 400 } on malformed days.
function getStats(daysParam, projectFilter) {
  let days = 7;
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

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
  const cutoffKey = cutoff.toISOString().slice(0, 10);

  const perProject = {};
  for (const [day, dayData] of Object.entries(_stats)) {
    if (day < cutoffKey) continue;
    for (const [proj, projData] of Object.entries(dayData)) {
      if (projectFilter && proj !== projectFilter) continue;
      if (!perProject[proj]) {
        perProject[proj] = {
          dedup: emptyTechniqueBucket(),
          cacheHint: emptyTechniqueBucket(),
          toolPrune: emptyTechniqueBucket(),
        };
      }
      for (const tech of ['dedup', 'cacheHint', 'toolPrune']) {
        if (!projData[tech]) continue;
        perProject[proj][tech].inputTokensRemoved += projData[tech].inputTokensRemoved || 0;
        perProject[proj][tech].cacheBillingDelta += projData[tech].cacheBillingDelta || 0;
        perProject[proj][tech].appliedCount += projData[tech].appliedCount || 0;
      }
    }
  }

  const perTechnique = {
    dedup: emptyTechniqueBucket(),
    cacheHint: emptyTechniqueBucket(),
    toolPrune: emptyTechniqueBucket(),
  };
  for (const projData of Object.values(perProject)) {
    for (const tech of ['dedup', 'cacheHint', 'toolPrune']) {
      perTechnique[tech].inputTokensRemoved += projData[tech].inputTokensRemoved;
      perTechnique[tech].cacheBillingDelta += projData[tech].cacheBillingDelta;
      perTechnique[tech].appliedCount += projData[tech].appliedCount;
    }
  }

  const totals = {
    inputTokensRemoved: Object.values(perTechnique).reduce((sum, t) => sum + t.inputTokensRemoved, 0),
    cacheBillingDelta: Object.values(perTechnique).reduce((sum, t) => sum + t.cacheBillingDelta, 0),
    appliedCount: Object.values(perTechnique).reduce((sum, t) => sum + t.appliedCount, 0),
  };

  return {
    ok: true,
    days,
    since: cutoffKey,
    perTechnique,
    perProject,
    totals,
  };
}

function __resetForTest() {
  _stats = {};
}

module.exports = { recordStats, getStats, loadStats, __resetForTest };
