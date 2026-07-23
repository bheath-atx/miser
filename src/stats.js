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

let _stats = loadStats();

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
};

function loadStats() {
  try {
    const raw = fs.readFileSync(STATS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (_) {
    return {};
  }
}

function clearTimer(name) {
  if (_pendingFlush[name]) {
    clearTimeout(_pendingFlush[name]);
    _pendingFlush[name] = null;
  }
}

function cloneStats() {
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
  const snapshot = cloneStats();

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
      console.error('[miser/stats] ERROR flush error:', err.message);
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

function getPendingWriteCount() {
  return _pendingFlush.mutationCount;
}

function getFlushLagMs() {
  return _pendingFlush.lastFlushAt == null ? null : Date.now() - _pendingFlush.lastFlushAt;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function dayKeyFromDate(date) {
  return date.toISOString().slice(0, 10);
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

function emptyTechniqueBucket() {
  return { estRemovedTokens: 0, inputTokensRemoved: 0, cacheBillingDelta: 0, appliedCount: 0 };
}

function emptyUsageBucket() {
  return { requests: 0 };
}

function ensureProjectBucket(project) {
  const day = todayKey();
  const proj = project || 'default';
  if (!_stats[day]) _stats[day] = {};
  if (!_stats[day][proj]) _stats[day][proj] = {};
  const bucket = _stats[day][proj];

  if (!bucket.dedup) bucket.dedup = emptyTechniqueBucket();
  if (!bucket.cacheHint) bucket.cacheHint = emptyTechniqueBucket();
  if (!bucket.toolPrune) bucket.toolPrune = { estRemovedTokens: 0, inputTokensRemoved: 0, cacheBillingDelta: 0, appliedCount: 0, toolsRemovedCount: 0 };
  if (!Number.isFinite(bucket.likelyPollCount)) bucket.likelyPollCount = 0;
  if (!Number.isFinite(bucket.workTurnCount)) bucket.workTurnCount = 0;
  return bucket;
}

function ensureMeasuredProjectBucket(project) {
  const day = todayKey();
  const proj = project || 'default';
  if (!_stats[day]) _stats[day] = {};
  if (!_stats[day][proj]) _stats[day][proj] = {};
  return _stats[day][proj];
}

// opts: { inputTokensRemoved, cacheBillingDelta, toolsRemoved, techniques }
function recordStats(project, opts = {}) {
  const bucket = ensureProjectBucket(project);
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

  scheduleFlush();
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

function recordAnthropicUsage(project, provider, model, rawUsage = {}, appliedEdits = null) {
  const bucket = ensureMeasuredProjectBucket(project);
  const providerKey = provider || 'anthropic';
  const modelKey = model || 'unknown';
  const usage = normalizeUsage(rawUsage);
  const hasMeasuredAxis = Object.keys(usage).length > 0;
  const editStats = normalizeAppliedEdits(appliedEdits);

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

  if (hasMeasuredAxis || editStats) scheduleFlush();
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

function getStats(daysParam, projectFilter, weights = DEFAULT_WEIGHTS) {
  const days = parseDays(daysParam, 7);
  const cutoffKey = cutoffKeyForDays(days);

  const perProject = {};
  for (const [day, dayData] of Object.entries(_stats)) {
    if (day < cutoffKey || !dayData || typeof dayData !== 'object') continue;
    for (const [proj, projData] of Object.entries(dayData)) {
      if (projectFilter && proj !== projectFilter) continue;
      if (!perProject[proj]) {
        perProject[proj] = {
          dedup: emptyTechniqueBucket(),
          cacheHint: emptyTechniqueBucket(),
          toolPrune: { estRemovedTokens: 0, inputTokensRemoved: 0, cacheBillingDelta: 0, appliedCount: 0, toolsRemovedCount: 0 },
          pollClass: { likely: 0, work: 0 },
        };
      }
      for (const tech of ['dedup', 'cacheHint', 'toolPrune']) {
        if (!projData[tech]) continue;
        perProject[proj][tech].estRemovedTokens += projData[tech].estRemovedTokens || projData[tech].inputTokensRemoved || 0;
        perProject[proj][tech].inputTokensRemoved += projData[tech].inputTokensRemoved || 0;
        perProject[proj][tech].cacheBillingDelta += projData[tech].cacheBillingDelta || 0;
        perProject[proj][tech].appliedCount += projData[tech].appliedCount || 0;
        if (tech === 'toolPrune') {
          perProject[proj][tech].toolsRemovedCount += projData[tech].toolsRemovedCount || 0;
        }
      }
      perProject[proj].pollClass.likely += projData.likelyPollCount || 0;
      perProject[proj].pollClass.work += projData.workTurnCount || 0;
      addUsageTree(perProject[proj].usage || (projData.usage ? (perProject[proj].usage = {}) : {}), projData.usage);
      addContextManagement(perProject[proj], projData.contextManagement);
    }
  }

  const perTechnique = {
    dedup: emptyTechniqueBucket(),
    cacheHint: emptyTechniqueBucket(),
    toolPrune: { estRemovedTokens: 0, inputTokensRemoved: 0, cacheBillingDelta: 0, appliedCount: 0, toolsRemovedCount: 0 },
  };
  for (const projData of Object.values(perProject)) {
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
    ok: true,
    days,
    since: cutoffKey,
    perTechnique,
    perProject,
    usage,
    weightedTokenEquivalents: weightedTokenEquivalents(usage, weights),
    totals,
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

  const dayKeys = Object.keys(_stats).filter(day => day >= cutoffKey).sort();
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

  return { days, since: cutoffKey, entries };
}

function __resetForTest() {
  _stats = {};
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

function getRawStatsSnapshot() {
  return cloneStats();
}

module.exports = {
  recordStats,
  recordAnthropicUsage,
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
  getRawStatsSnapshot,
  __resetForTest,
  __test: { _pendingFlush },
};
