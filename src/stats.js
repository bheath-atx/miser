'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

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
    // inputTokensRemoved stays 0 for toolPrune in v1 (no reliable byte estimate at proxy time)
    bucket.toolPrune.toolsRemovedCount += toolsRemoved;
    bucket.toolPrune.appliedCount += 1;
  }
  if (pollClass === 'likely') {
    bucket.likelyPollCount += 1;
  } else if (pollClass === 'unlikely') {
    bucket.workTurnCount += 1;
  }

  flushStats();
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

  if (hasMeasuredAxis || editStats) flushStats();
  if (usage.cacheWrite5m > 0) {
    console.warn(`[miser] WARN cacheWrite5m observed over 24h window project=${project || 'default'} provider=${providerKey} model=${modelKey}`);
  }
}

// GET /api/miser/stats?days=N[&project=X]
// Returns { ok, days, since, perTechnique, perProject, totals }.
// Throws { statusCode: 400 } on malformed days.
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

function getStats(daysParam, projectFilter, weights = DEFAULT_WEIGHTS) {
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

  const totals = {
    // toolPrune no longer contributes to inputTokensRemoved (it counts tools, not bytes)
    inputTokensRemoved: (perTechnique.dedup.inputTokensRemoved || 0) + (perTechnique.cacheHint.inputTokensRemoved || 0),
    estRemovedTokens: (perTechnique.dedup.estRemovedTokens || 0) + (perTechnique.cacheHint.estRemovedTokens || 0),
    cacheBillingDelta: Object.values(perTechnique).reduce((sum, t) => sum + t.cacheBillingDelta, 0),
    appliedCount: Object.values(perTechnique).reduce((sum, t) => sum + t.appliedCount, 0),
    toolsRemovedCount: perTechnique.toolPrune.toolsRemovedCount || 0,
  };

  const usage = {};
  for (const [project, projectData] of Object.entries(perProject)) {
    if (projectData.usage) usage[project] = projectData.usage;
  }

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

function __resetForTest() {
  _stats = {};
}

module.exports = {
  recordStats,
  recordAnthropicUsage,
  getStats,
  loadStats,
  weightedTokenEquivalents,
  __resetForTest,
};
