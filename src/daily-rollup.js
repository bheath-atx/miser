'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { computeCost } = require('./pricing.js');

const DEFAULT_DEDUP_FILE = process.env.MISER_ROLLUP_DEDUP_FILE
  || path.join(os.homedir(), '.miser-rollup-last.txt');

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function offsetDayKey(base, offset) {
  const d = new Date(base);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return dayKey(d);
}

function usageTotals(usageTree) {
  const totals = {
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
      totals.input += bucket.input || 0;
      totals.output += bucket.output || 0;
      totals.cacheRead += bucket.cacheRead || 0;
      totals.cacheWrite5m += bucket.cacheWrite5m || 0;
      totals.cacheWrite1h += bucket.cacheWrite1h || 0;
    }
  }
  return totals;
}

function weightedTotalFromUsageTree(usageTree, weights = { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 }) {
  const totals = usageTotals(usageTree);
  return (totals.input * weights.input)
    + (totals.cacheRead * weights.cacheRead)
    + (totals.cacheWrite5m * weights.cacheWrite5m)
    + (totals.cacheWrite1h * weights.cacheWrite1h)
    + (totals.output * weights.output);
}

function formatK(tokens) {
  return `${Math.round((tokens || 0) / 1000)}k`;
}

function historyCost(stats, project, today) {
  let daysWithData = 0;
  let total = 0;
  for (let offset = -7; offset <= -1; offset++) {
    const key = offsetDayKey(today, offset);
    const usage = stats[key] && stats[key][project] && stats[key][project].usage;
    if (usage) daysWithData += 1;
    total += computeCost(usage || {});
  }
  return daysWithData >= 3 ? total : null;
}

function historyWeighted(stats, project, today) {
  let daysWithData = 0;
  let total = 0;
  for (let offset = -7; offset <= -1; offset++) {
    const key = offsetDayKey(today, offset);
    const usage = stats[key] && stats[key][project] && stats[key][project].usage;
    if (usage) daysWithData += 1;
    total += weightedTotalFromUsageTree(usage || {});
  }
  return daysWithData >= 3 ? total : null;
}

// Sprint B: guardrail rollup fields, appended only when nonzero (sparse).
function guardrailSuffix(projectData) {
  const blocked = (projectData.budget && projectData.budget.blockedCount) || 0;
  const drift = (projectData.policy && projectData.policy.modelDriftCount) || 0;
  const bloat = (projectData.policy && projectData.policy.contextBloatCount) || 0;
  let out = '';
  if (blocked > 0) out += ` blocked:${blocked}`;
  if (drift > 0) out += ` drift:${drift}`;
  if (bloat > 0) out += ` bloat:${bloat}`;
  return out;
}

function formatWeighted(n) {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

function formatPercent(n) {
  return `${(n * 100).toFixed(1)}%`;
}

const PACE_DEFERRAL_LINE = 'fleet pace: NOT ALERTED (deferred by design — see PROPOSAL-FACTB §4.3.7); run weekly-pace.py for the current transcript-visible-fleet verdict';

function buildPaceLines(pace) {
  const lines = [];
  const weighted = pace && Number.isFinite(pace.weightedRoutedConsumed)
    ? pace.weightedRoutedConsumed
    : 0;
  let line = `week to date: ${formatWeighted(weighted)} weighted tokens across miser-routed traffic (a floor - unrouted panels not counted); transcript-visible fleet % of cap: see weekly-pace.py`;
  if (pace && Number.isFinite(pace.routedConsumedFrac)) {
    line += `; miser-routed ${formatPercent(pace.routedConsumedFrac)} of cap`;
  } else if (pace && pace.unavailableReason) {
    line += `; miser-routed % unavailable: ${pace.unavailableReason}`;
  }
  lines.push(line);
  lines.push(PACE_DEFERRAL_LINE);
  if (pace && Array.isArray(pace.degradedReasons) && pace.degradedReasons.includes('unpriced-models')) {
    lines.push('unpriced models: observed fallback-priced Anthropic traffic; update DEFAULT_PRICING');
  }
  return lines;
}

function hasUnpricedModels(pace) {
  return !!(pace && Array.isArray(pace.degradedReasons) && pace.degradedReasons.includes('unpriced-models'));
}

function buildRollupText(stats, now = new Date(), opts = {}) {
  const today = dayKey(now);
  const todayData = stats[today] || {};
  const rows = [];

  for (const [project, projectData] of Object.entries(todayData)) {
    if (!projectData) continue;
    const guard = guardrailSuffix(projectData);
    if (!projectData.usage) {
      // Guardrail-only project (no Anthropic usage): line only when any
      // guardrail count is nonzero; no token fields — no usage data.
      if (guard) rows.push({ project, anthropicEstCostUSD: 0, line: `${project}: $0.00${guard}` });
      continue;
    }
    const anthropicEstCostUSD = computeCost(projectData.usage);
    const weighted = weightedTotalFromUsageTree(projectData.usage);
    const totals = usageTotals(projectData.usage);
    const baseline = historyWeighted(stats, project, now);
    const anomaly = baseline != null && weighted > 2 * (baseline / 7)
      ? ` ⚠️ ${project} 2× baseline`
      : '';
    rows.push({
      project,
      anthropicEstCostUSD,
      weighted,
      line: `${project}: ${formatWeighted(weighted)} weighted tokens (${formatK(totals.input)} input / ${formatK(totals.output)} output / ${formatK(totals.cacheRead)} cacheRead tokens; $${anthropicEstCostUSD.toFixed(2)} est)${anomaly}${guard}`,
    });
  }

  rows.sort((a, b) => b.weighted - a.weighted || a.project.localeCompare(b.project));
  return [...buildPaceLines(opts.pace), ...rows.map(row => row.line)].join('\n');
}

// The ONE implementation of the MISER_PKACHU_* read (§2.6). Both the rollup and
// alert-routes.js route through this, so there is exactly one reader — the
// accurate form of R2's overstated "exactly one call site" claim.
function defaultRouteFromEnv() {
  const endpoint = process.env.MISER_PKACHU_ENDPOINT;
  const tokenFile = process.env.MISER_PKACHU_TOKEN;
  if (!endpoint || !tokenFile) return null;
  return { endpoint, tokenFile };
}

async function readToken(tokenPath) {
  return (await fsp.readFile(tokenPath, 'utf8')).trim();
}

function postPkachu(endpoint, token, text) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const body = JSON.stringify({ text });
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`pkachu HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function emitDailyRollup(stats, pkachu = postPkachu, opts = {}) {
  const now = opts.now || new Date();
  const today = dayKey(now);
  const dedupFile = opts.dedupFile || DEFAULT_DEDUP_FILE;

  let last = '';
  try { last = fs.readFileSync(dedupFile, 'utf8').trim(); } catch (_) {}
  if (last === today) return { emitted: false, reason: 'dedup' };

  // Route source is INJECTED downward from the composition root (§2.6). The
  // un-injected path is not a second policy — it is the same policy reached
  // without the resolver, which is why rollup.test.js passes unmodified.
  const route = opts.resolveRoute ? opts.resolveRoute(null) : defaultRouteFromEnv();
  if (!route || !route.endpoint || !route.tokenFile) {
    console.warn('[miser/rollup] WARN daily rollup skipped: MISER_PKACHU_TOKEN or MISER_PKACHU_ENDPOINT not set');
    return { emitted: false, reason: 'no_env' };
  }
  const endpoint = route.endpoint;
  const tokenPath = route.tokenFile;

  const text = buildRollupText(stats || {}, now, { pace: opts.pace });
  if (!text) return { emitted: false, reason: 'no_data' };

  try {
    const token = await readToken(tokenPath);
    await pkachu(endpoint, token, text);
    if (hasUnpricedModels(opts.pace) && typeof opts.sendAlert === 'function') {
      await opts.sendAlert(
        'miser unpriced models observed: fallback pricing was used for Anthropic traffic; update DEFAULT_PRICING',
        { scope: 'fleet', kind: 'unpriced-models' },
      );
    }
    await fsp.writeFile(dedupFile, today, 'utf8');
    return { emitted: true, text };
  } catch (err) {
    console.warn(`[miser/rollup] WARN daily rollup skipped: ${err.message}`);
    return { emitted: false, reason: 'post_failed', error: err };
  }
}

// The Sprint-B shared dispatcher that used to live here is GONE. It is replaced
// by createAlertDispatcher in alert-routes.js, which is now the SINGLE outbound
// path for guardrail alerts (§2.9a) and which resolves a per-project route
// instead of reading one env destination per call. This module keeps only the
// transport (postPkachu), the token read, and the ONE MISER_PKACHU_* read
// (defaultRouteFromEnv) — §8 forbids changing the wire format, and §2.6 requires
// exactly one implementation of that env read.
//
// Leaving the old function here would have meant a live, network-capable
// outbound path that nothing calls — precisely the hazard §3.4 Layer 1 removes.
// See STATUS.md FINDING 2026-08-04 for the reasoning and the AR11 comment fix.

function shouldEmitNow(now = new Date()) {
  return now.getUTCHours() === 0 && now.getUTCMinutes() < 2;
}

function startDailyRollupInterval(getStatsSnapshot, opts = {}) {
  const intervalMs = opts.intervalMs || 60000;
  function tryEmit() {
    const now = new Date();
    if (!shouldEmitNow(now)) return;
    const pace = typeof opts.getPace === 'function' ? opts.getPace() : opts.pace;
    Promise.resolve()
      .then(() => emitDailyRollup(getStatsSnapshot(), undefined, {
        now,
        resolveRoute: opts.resolveRoute,
        pace,
        sendAlert: opts.alertDispatcher,
      }))
      .catch((err) => console.warn(`[miser/rollup] WARN daily rollup skipped: ${err.message}`));
  }
  // Immediate check on startup so process starting within the midnight window doesn't miss it.
  tryEmit();
  const timer = setInterval(tryEmit, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  DEFAULT_DEDUP_FILE,
  buildRollupText,
  defaultRouteFromEnv,
  emitDailyRollup,
  postPkachu,
  readToken,
  shouldEmitNow,
  startDailyRollupInterval,
  PACE_DEFERRAL_LINE,
  hasUnpricedModels,
};
