'use strict';

const { isValidProjectName } = require('./routing.js');
const { computeCost } = require('./pricing.js');
const { getRawStatsSnapshot, recordBudgetBlock } = require('./stats.js');
const { sendAlert: defaultSendAlert } = require('./daily-rollup.js');

// G3 — per-project daily USD budget caps (Sprint B §1).
//
// The ONLY blocking feature in miser, and it blocks BEFORE any token is spent:
// the check runs pre-compress(), pre-upstream. It never mutates a forwarded
// request. Blocking is the dangerous direction here, so config parsing is
// fail-open PER PROJECT (a budget we don't fully understand is ignored with a
// warning, never enforced) and the whole feature is fail-closed-to-OFF (null).

// Parser return contract (normative, §1.1): returns null when OFF (env
// unset/empty, malformed JSON, array/non-object, or ALL projects invalid) —
// null is the exclusive OFF signal. Never returns {}.
function parseBudgets(env) {
  if (typeof env !== 'string' || !env.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(env);
  } catch (err) {
    console.warn(`[miser/budgets] WARN invalid MISER_BUDGETS JSON (${err.message}); budgets OFF`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn('[miser/budgets] WARN MISER_BUDGETS must be a JSON object; budgets OFF');
    return null;
  }
  const out = {};
  for (const [project, value] of Object.entries(parsed)) {
    if (!isValidProjectName(project)) {
      console.warn(`[miser/budgets] WARN invalid project name ${JSON.stringify(project)}; budget ignored`);
      continue;
    }
    // Reject prototype-poisoning keys that pass P1 grammar (e.g. "__proto__").
    if (project === '__proto__' || project === 'constructor' || project === 'prototype') {
      console.warn(`[miser/budgets] WARN reserved key ${JSON.stringify(project)}; budget ignored`);
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      console.warn(`[miser/budgets] WARN project ${project}: budget must be an object; ignored`);
      continue;
    }
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== 'dailyUSD') {
      console.warn(`[miser/budgets] WARN project ${project}: only key "dailyUSD" is allowed; ignored`);
      continue;
    }
    const dailyUSD = value.dailyUSD;
    if (typeof dailyUSD !== 'number' || !Number.isFinite(dailyUSD) || dailyUSD < 0.01 || dailyUSD > 10000) {
      console.warn(`[miser/budgets] WARN project ${project}: dailyUSD must be a finite number in [0.01, 10000]; ignored`);
      continue;
    }
    out[project] = { dailyUSD };
  }
  if (Object.keys(out).length === 0) {
    console.warn('[miser/budgets] WARN no valid project budgets in MISER_BUDGETS; budgets OFF');
    return null;
  }
  return out;
}

// Grace parser contract (§1.1): ALWAYS returns an array ([] for unset/empty/
// malformed) — grace is a modifier, not a feature toggle, so no null-as-OFF.
function parseBudgetGrace(env) {
  if (typeof env !== 'string' || !env.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(env);
  } catch (err) {
    console.warn(`[miser/budgets] WARN invalid MISER_BUDGET_GRACE JSON (${err.message}); no grace projects`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn('[miser/budgets] WARN MISER_BUDGET_GRACE must be a JSON array; no grace projects');
    return [];
  }
  const out = [];
  for (const name of parsed) {
    if (!isValidProjectName(name)) {
      console.warn(`[miser/budgets] WARN invalid grace project name ${JSON.stringify(name)}; ignored`);
      continue;
    }
    out.push(name);
  }
  return out;
}

// Alert dispatch is ALWAYS fire-and-forget: never awaited on the request path,
// outer .catch swallows any rejection from the production or injected sendAlert.
function dispatchAlert(sendAlert, text) {
  const send = sendAlert || defaultSendAlert;
  Promise.resolve().then(() => send(text)).catch(() => {});
}

// Sum of measured Anthropic-leg .requests — anthropic provider only (§1.5).
// Consistent with computeCost which also filters to provider === 'anthropic'.
function requestsToday(usageTree) {
  let total = 0;
  const anthropicModels = (usageTree || {}).anthropic;
  if (!anthropicModels || typeof anthropicModels !== 'object') return 0;
  for (const bucket of Object.values(anthropicModels)) {
    if (bucket && Number.isFinite(bucket.requests)) total += bucket.requests;
  }
  return total;
}

// Today's spend for a project = computeCost over the IN-MEMORY stats usage tree
// for the current UTC day (§1.2). In-memory is authoritative: the raw snapshot
// clones the live _stats, so un-flushed writes count. Only MEASURED Anthropic
// usage accrues; Codex/Ollama/OpenAI-format legs record no USD.
function computeTodaySpendUSD(project, now) {
  const today = now.toISOString().slice(0, 10);
  const snapshot = getRawStatsSnapshot();
  const usage = snapshot[today] && snapshot[today][project] && snapshot[today][project].usage;
  return { spend: computeCost(usage || {}), usage: usage || null };
}

// Exact §1.4 block response. Never forwarded; Anthropic error wire shape so
// Claude Code's native backoff handles it. Dollar amounts use toFixed(2).
function buildBlockResponse(project, spend, dailyUSD, now) {
  const nextUTCMidnightMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const retryAfter = Math.max(1, Math.ceil((nextUTCMidnightMs - now.getTime()) / 1000));
  return {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'retry-after': String(retryAfter),
      'x-miser-budget': 'exhausted',
    },
    body: {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: `miser: project '${project}' daily budget of $${dailyUSD.toFixed(2)} exhausted (spent $${spend.toFixed(2)}); resets at next UTC midnight`,
      },
    },
  };
}

// Per-project per-day state machine (§1.3): OFF → UNDER → WARNED → CAPPED.
// State is recomputed, never stored — a pure function of (spend, cap, ledger).
// Returns null (request passes) or a block-response descriptor (§1.4).
function checkBudget(project, guardDeps = {}) {
  const {
    budgetsConfig,
    budgetGraceConfig = [],
    ledger,
    sendAlert,
    nowFn = () => new Date(),
  } = guardDeps;

  if (!budgetsConfig) return null;
  const budget = budgetsConfig[project];
  if (!budget) return null; // OFF for this project — no check, no alert
  // Missing-ledger (normative §2.5): no ledger = no dedup = alert-storm risk;
  // treat as feature-OFF for this invocation. No alert, no block, no counter.
  if (!ledger) return null;

  const now = nowFn();
  const dailyUSD = budget.dailyUSD;
  const { spend, usage } = computeTodaySpendUSD(project, now);

  if (spend >= dailyUSD) {
    // CAPPED — one cap alert per project per UTC day.
    const grace = budgetGraceConfig.includes(project);
    const key = `budget:${project}:cap`;
    if (ledger.shouldSend(key)) {
      ledger.markSent(key); // mark BEFORE send (normative): failed send is not retried that day
      const suffix = grace ? ' — GRACE: alerting only, not blocking' : ' — blocking until UTC midnight';
      dispatchAlert(sendAlert, `⛔ miser budget: ${project} EXHAUSTED $${spend.toFixed(2)}/$${dailyUSD.toFixed(2)}${suffix}`);
    }
    if (grace) return null; // grace-listed: alerts only, never the 429
    recordBudgetBlock(project, () => now); // pass captured now — single clock read, no midnight split
    return buildBlockResponse(project, spend, dailyUSD, now);
  }

  if (spend >= 0.8 * dailyUSD) {
    // WARNED — one warn alert per project per UTC day; request passes.
    const key = `budget:${project}:warn`;
    if (ledger.shouldSend(key)) {
      ledger.markSent(key);
      const n = requestsToday(usage);
      dispatchAlert(sendAlert, `⚠️ miser budget: ${project} at $${spend.toFixed(2)}/$${dailyUSD.toFixed(2)} (80%) — ${n} requests today`);
    }
  }

  return null; // UNDER / WARNED — request passes
}

// Production guardDeps assembly (normative §2.5). Extracted from index.js so
// AC1 can prove the wiring: both-OFF → empty deps + NO createLedger() call;
// G3-only → no checkContextBloat key at all; both-on → ledger + both hooks.
// Lazy requires keep `require('./budgets.js')` free of policy/ledger loading
// when guardrails are OFF (and avoid any import cycle with config.js).
function buildGuardDeps(config, seams = {}) {
  const guardDeps = {};
  const budgets = config.budgets != null ? config.budgets : null;
  const policy = config.policy != null ? config.policy : null;
  if (budgets === null && policy === null) return guardDeps;

  const mkLedger = seams.createLedger || require('./alert-ledger.js').createLedger;
  guardDeps.ledger = mkLedger();
  guardDeps.nowFn = seams.nowFn || (() => new Date());
  if (budgets !== null) {
    guardDeps.budgetsConfig = budgets;
    guardDeps.budgetGraceConfig = config.budgetGrace || []; // always [] when budgets active
  }
  if (policy !== null) {
    guardDeps.checkContextBloat = require('./policy-watchdog.js').checkContextBloat;
    guardDeps.policyConfig = policy;
  }
  return guardDeps;
}

module.exports = {
  parseBudgets,
  parseBudgetGrace,
  checkBudget,
  buildBlockResponse,
  buildGuardDeps,
  __test: { requestsToday, computeTodaySpendUSD, dispatchAlert },
};
