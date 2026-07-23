'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { computeCost } = require('./pricing.js');

const DEFAULT_DEDUP_FILE = path.join(os.homedir(), '.miser-rollup-last.txt');

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

function buildRollupText(stats, now = new Date()) {
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
    const totals = usageTotals(projectData.usage);
    const baseline = historyCost(stats, project, now);
    const anomaly = baseline != null && anthropicEstCostUSD > 2 * (baseline / 7)
      ? ` ⚠️ ${project} 2× baseline`
      : '';
    rows.push({
      project,
      anthropicEstCostUSD,
      line: `${project}: $${anthropicEstCostUSD.toFixed(2)} (${formatK(totals.input)} input / ${formatK(totals.output)} output / ${formatK(totals.cacheRead)} cacheRead tokens)${anomaly}${guard}`,
    });
  }

  rows.sort((a, b) => b.anthropicEstCostUSD - a.anthropicEstCostUSD || a.project.localeCompare(b.project));
  return rows.map(row => row.line).join('\n');
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

  const endpoint = process.env.MISER_PKACHU_ENDPOINT;
  const tokenPath = process.env.MISER_PKACHU_TOKEN;
  if (!endpoint || !tokenPath) {
    console.warn('[miser/rollup] WARN daily rollup skipped: MISER_PKACHU_TOKEN or MISER_PKACHU_ENDPOINT not set');
    return { emitted: false, reason: 'no_env' };
  }

  const text = buildRollupText(stats || {}, now);
  if (!text) return { emitted: false, reason: 'no_data' };

  try {
    const token = await readToken(tokenPath);
    await pkachu(endpoint, token, text);
    await fsp.writeFile(dedupFile, today, 'utf8');
    return { emitted: true, text };
  } catch (err) {
    console.warn(`[miser/rollup] WARN daily rollup skipped: ${err.message}`);
    return { emitted: false, reason: 'post_failed', error: err };
  }
}

// Shared alert dispatcher (Sprint B §2.5) — the single outbound path for
// guardrail alerts. Reads env + token on EVERY call (consistent with
// emitDailyRollup; the token file may rotate). NEVER throws: pkachu failure
// logs one warn per call (the alert ledger already guarantees at most one
// call per key per UTC day). Callers invoke it fire-and-forget via
// Promise.resolve().then(() => sendAlert(text)).catch(() => {}).
async function sendAlert(text) {
  const endpoint = process.env.MISER_PKACHU_ENDPOINT;
  const tokenPath = process.env.MISER_PKACHU_TOKEN;
  if (!endpoint || !tokenPath) return; // silently skip if not configured
  try {
    const token = await readToken(tokenPath);
    await postPkachu(endpoint, token, text);
  } catch (err) {
    console.warn(`[miser/alert] WARN alert send failed: ${err.message}`);
  }
}

function shouldEmitNow(now = new Date()) {
  return now.getUTCHours() === 0 && now.getUTCMinutes() < 2;
}

function startDailyRollupInterval(getStatsSnapshot, opts = {}) {
  const intervalMs = opts.intervalMs || 60000;
  function tryEmit() {
    const now = new Date();
    if (!shouldEmitNow(now)) return;
    Promise.resolve()
      .then(() => emitDailyRollup(getStatsSnapshot(), undefined, { now }))
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
  emitDailyRollup,
  postPkachu,
  sendAlert,
  shouldEmitNow,
  startDailyRollupInterval,
};
