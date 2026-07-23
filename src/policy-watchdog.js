'use strict';

const { isValidProjectName } = require('./routing.js');
const { recordPolicyEvent } = require('./stats.js');
const { sendAlert: defaultSendAlert } = require('./daily-rollup.js');

// B6 — policy watchdog (Sprint B §2). ALERT-ONLY: never blocks, never mutates
// a request body or header, never rewrites a model. Drift is checked in
// proxy.js pre-compress (read-only on originalBody.model); context bloat is
// checked in router.js::proxyAnthropicResponse from MEASURED usage only — no
// char/4 estimate fallback, no fabricated signal (v4 honesty contract).

// Parser return contract (§2.1): same null-as-OFF table as parseBudgets.
// Per-project value: plain object with AT LEAST ONE of expectedModel
// (non-empty string ≤64, prefix-matched) / maxContextTokens (int, 10K..2M).
// Unknown keys / wrong types / out-of-bounds → project IGNORED + warning
// (watchdog is advisory; fail-open is fine and consistent).
function parsePolicy(env) {
  if (typeof env !== 'string' || !env.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(env);
  } catch (err) {
    console.warn(`[miser/policy] WARN invalid MISER_POLICY JSON (${err.message}); watchdog OFF`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn('[miser/policy] WARN MISER_POLICY must be a JSON object; watchdog OFF');
    return null;
  }
  const out = {};
  for (const [project, value] of Object.entries(parsed)) {
    if (!isValidProjectName(project)) {
      console.warn(`[miser/policy] WARN invalid project name ${JSON.stringify(project)}; policy ignored`);
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      console.warn(`[miser/policy] WARN project ${project}: policy must be an object; ignored`);
      continue;
    }
    const keys = Object.keys(value);
    const unknown = keys.filter(k => k !== 'expectedModel' && k !== 'maxContextTokens');
    if (unknown.length > 0 || keys.length === 0) {
      console.warn(`[miser/policy] WARN project ${project}: only expectedModel/maxContextTokens allowed (at least one); ignored`);
      continue;
    }
    const entry = {};
    let bad = false;
    if ('expectedModel' in value) {
      const m = value.expectedModel;
      if (typeof m !== 'string' || m.length === 0 || m.length > 64) {
        console.warn(`[miser/policy] WARN project ${project}: expectedModel must be a non-empty string ≤64 chars; ignored`);
        bad = true;
      } else {
        entry.expectedModel = m;
      }
    }
    if (!bad && 'maxContextTokens' in value) {
      const t = value.maxContextTokens;
      if (!Number.isInteger(t) || t < 10_000 || t > 2_000_000) {
        console.warn(`[miser/policy] WARN project ${project}: maxContextTokens must be an integer in [10000, 2000000]; ignored`);
        bad = true;
      } else {
        entry.maxContextTokens = t;
      }
    }
    if (bad) continue;
    out[project] = entry;
  }
  if (Object.keys(out).length === 0) {
    console.warn('[miser/policy] WARN no valid project policies in MISER_POLICY; watchdog OFF');
    return null;
  }
  return out;
}

// Fire-and-forget alert dispatch (§2.5) — never awaited, rejections swallowed.
function dispatchAlert(sendAlert, text) {
  const send = sendAlert || defaultSendAlert;
  Promise.resolve().then(() => send(text)).catch(() => {});
}

// Model drift check (§2.2) — proxy.js, pre-compress, read-only. Runs AFTER the
// budget check (a budget-blocked request never reaches this). Guard order is
// normative: (1) absent/non-string model → skip; (2) no expectedModel for this
// project (bloat-only policy) → skip silently. The passing request proceeds
// through the normal pipeline UNTOUCHED — zero changes to forwardBody.
function checkModelDrift(project, body, guardDeps = {}) {
  const model = body && body.model;
  if (typeof model !== 'string' || !model) return;
  const expected = guardDeps.policyConfig
    && guardDeps.policyConfig[project]
    && guardDeps.policyConfig[project].expectedModel;
  if (!expected) return;
  if (!guardDeps.ledger) return; // missing-ledger: skip — no alert, no counter (§2.5)
  if (model.startsWith(expected)) return;

  const nowFn = guardDeps.nowFn || (() => new Date());
  const counts = recordPolicyEvent(project, { drift: true }, nowFn);
  const key = `policy:${project}:drift`;
  if (guardDeps.ledger.shouldSend(key)) {
    guardDeps.ledger.markSent(key);
    dispatchAlert(guardDeps.sendAlert,
      `👁 miser policy: ${project} model drift — got ${model}, expected ${expected}* (${counts.modelDriftCount}× today)`);
  }
}

function finitePositive(n) {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// contextTokens = input + cacheRead + cache-creation totals — the same
// normalization axes as normalizeUsage() in stats.js (billed truth only).
function measuredContextTokens(rawUsage) {
  let total = finitePositive(rawUsage.input_tokens) + finitePositive(rawUsage.cache_read_input_tokens);
  if (rawUsage.cache_creation && typeof rawUsage.cache_creation === 'object') {
    total += finitePositive(rawUsage.cache_creation.ephemeral_5m_input_tokens);
    total += finitePositive(rawUsage.cache_creation.ephemeral_1h_input_tokens);
  } else {
    total += finitePositive(rawUsage.cache_creation_input_tokens);
  }
  return total;
}

// Context bloat check (§2.2) — called from router.js::proxyAnthropicResponse
// via guardDeps.checkContextBloat, fire-and-forget, exception-isolated at the
// callsite; NEVER delays resolve(). Uses MEASURED usage only: legs with no
// usage capture (Codex/Ollama/aborted stream) pass null → immediate return,
// no estimate fallback.
function checkContextBloat(project, model, rawUsage, guardDeps = {}) {
  if (!guardDeps.ledger) return; // missing-ledger: treat as B6-OFF for this invocation
  if (!rawUsage || typeof rawUsage !== 'object') return; // no measured usage → no signal
  const maxContextTokens = guardDeps.policyConfig
    && guardDeps.policyConfig[project]
    && guardDeps.policyConfig[project].maxContextTokens;
  if (!maxContextTokens) return; // drift-only policy (or no policy) for this project

  const contextTokens = measuredContextTokens(rawUsage);
  if (contextTokens <= maxContextTokens) return;

  const nowFn = guardDeps.nowFn || (() => new Date());
  const counts = recordPolicyEvent(project, { bloat: true }, nowFn);
  const key = `policy:${project}:bloat`;
  if (guardDeps.ledger.shouldSend(key)) {
    guardDeps.ledger.markSent(key);
    dispatchAlert(guardDeps.sendAlert,
      `👁 miser policy: ${project} context ${contextTokens} > ${maxContextTokens} cap (${counts.contextBloatCount}× today)`);
  }
}

module.exports = {
  parsePolicy,
  checkModelDrift,
  checkContextBloat,
  __test: { measuredContextTokens },
};
