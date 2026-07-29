'use strict';

const { isValidProjectName } = require('./routing.js');
const { recordPollRewriteStats } = require('./stats.js');

const DEFAULT_BREAKER = Object.freeze({
  windowMs: 300000,
  threshold: 3,
  resetMs: 1800000,
});
const PROJECT_KEYS = new Set(['panels', 'maxTokens', 'thinking', 'modelMap']);
const MODEL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const LEVER_ORDER = ['maxTokens', 'thinking', 'model'];

function warn(warnings, message) {
  warnings.push(`[miser] poll-rewrite: ${message}`);
}

function cloneProject(knobs) {
  const out = {
    panels: knobs.panels === '*' ? '*' : [...knobs.panels],
  };
  if (Object.prototype.hasOwnProperty.call(knobs, 'maxTokens')) out.maxTokens = knobs.maxTokens;
  if (Object.prototype.hasOwnProperty.call(knobs, 'thinking')) out.thinking = knobs.thinking;
  if (Object.prototype.hasOwnProperty.call(knobs, 'modelMap')) out.modelMap = { ...knobs.modelMap };
  return out;
}

function cloneProjects(projects = {}) {
  const out = {};
  for (const [project, knobs] of Object.entries(projects || {})) out[project] = cloneProject(knobs);
  return out;
}

function validPanelSelector(panels) {
  if (panels === '*') return true;
  if (!Array.isArray(panels) || panels.length < 1 || panels.length > 20) return false;
  return panels.every(isValidProjectName);
}

function validModelMap(modelMap) {
  if (!modelMap || typeof modelMap !== 'object' || Array.isArray(modelMap)) return false;
  const entries = Object.entries(modelMap);
  if (entries.length < 1 || entries.length > 10) return false;
  return entries.every(([from, to]) => (
    typeof from === 'string' && typeof to === 'string'
    && MODEL_ID_RE.test(from) && MODEL_ID_RE.test(to)
  ));
}

function validateProject(project, raw, warnings) {
  if (!isValidProjectName(project)) {
    warn(warnings, `dropping invalid project "${project}"`);
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(warnings, `dropping project "${project}": entry must be an object`);
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!PROJECT_KEYS.has(key)) {
      warn(warnings, `dropping project "${project}": unknown key "${key}"`);
      return null;
    }
  }
  if (!validPanelSelector(raw.panels)) {
    warn(warnings, `dropping project "${project}": invalid panels`);
    return null;
  }

  const out = { panels: raw.panels === '*' ? '*' : [...raw.panels] };
  let levers = 0;

  if (Object.prototype.hasOwnProperty.call(raw, 'maxTokens')) {
    if (!Number.isInteger(raw.maxTokens) || raw.maxTokens < 1 || raw.maxTokens > 32000) {
      warn(warnings, `dropping project "${project}": invalid maxTokens`);
      return null;
    }
    out.maxTokens = raw.maxTokens;
    levers += 1;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'thinking')) {
    const ok = raw.thinking === 'strip'
      || (Number.isInteger(raw.thinking) && raw.thinking >= 1024 && raw.thinking <= 32000);
    if (!ok) {
      warn(warnings, `dropping project "${project}": invalid thinking`);
      return null;
    }
    out.thinking = raw.thinking;
    levers += 1;
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'modelMap')) {
    if (!validModelMap(raw.modelMap)) {
      warn(warnings, `dropping project "${project}": invalid modelMap`);
      return null;
    }
    out.modelMap = { ...raw.modelMap };
    levers += 1;
  }
  if (levers === 0) {
    warn(warnings, `dropping project "${project}": no levers configured`);
    return null;
  }
  return out;
}

function parsePollRewriteConfig(raw) {
  if (raw == null || raw === '') return { projects: {}, warnings: [] };
  const warnings = [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    warn(warnings, 'invalid MISER_POLL_REWRITE JSON; feature disabled');
    return { projects: {}, warnings };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn(warnings, 'MISER_POLL_REWRITE must be a JSON object; feature disabled');
    return { projects: {}, warnings };
  }
  const projects = {};
  for (const [project, cfg] of Object.entries(parsed)) {
    const valid = validateProject(project, cfg, warnings);
    if (valid) projects[project] = valid;
  }
  return { projects, warnings };
}

function parseBreakerKnob(value, key, def) {
  if (value === undefined || value === null || value === '') return { value: def, warning: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return { value: null, warning: `${key} invalid` };
  return { value: n, warning: null };
}

function parsePollRewriteEnv({ raw, windowMs, threshold, resetMs } = {}) {
  const parsed = parsePollRewriteConfig(raw || '');
  const warnings = [...parsed.warnings];
  for (const [key, value, def] of [
    ['windowMs', windowMs, DEFAULT_BREAKER.windowMs],
    ['threshold', threshold, DEFAULT_BREAKER.threshold],
    ['resetMs', resetMs, DEFAULT_BREAKER.resetMs],
  ]) {
    const knob = parseBreakerKnob(value, key, def);
    if (knob.warning) {
      warn(warnings, `${key} breaker knob invalid; feature disabled`);
      return { projects: {}, breaker: null, warnings };
    }
  }
  const w = parseBreakerKnob(windowMs, 'windowMs', DEFAULT_BREAKER.windowMs).value;
  const t = parseBreakerKnob(threshold, 'threshold', DEFAULT_BREAKER.threshold).value;
  const r = parseBreakerKnob(resetMs, 'resetMs', DEFAULT_BREAKER.resetMs).value;
  return { projects: parsed.projects, breaker: { windowMs: w, threshold: t, resetMs: r }, warnings };
}

function panelMatches(selector, panel) {
  if (selector === '*') return true;
  return panel != null && selector.includes(panel);
}

function shouldRewrite(project, panel, pollClass, format, projects, breaker, nowMs) {
  if (format !== 'anthropic') return false;
  if (pollClass !== 'likely') return false;
  const knobs = projects && projects[project];
  if (!knobs) return false;
  if (!panelMatches(knobs.panels, panel)) return false;
  if (!breaker || typeof breaker.isDisabled !== 'function') return false;
  return !breaker.isDisabled(project, nowMs);
}

function isInvalidThinking(body) {
  const thinking = body && body.thinking;
  if (!thinking || thinking.type !== 'enabled') return null;
  if (Number.isFinite(thinking.budget_tokens) && thinking.budget_tokens < 1024) {
    return 'thinking-budget-too-low';
  }
  if (Number.isFinite(thinking.budget_tokens) && Number.isFinite(body.max_tokens)
      && thinking.budget_tokens >= body.max_tokens) {
    return 'thinking-exceeds-max-tokens';
  }
  return null;
}

function applyPollRewrite(body, knobs = {}) {
  let out = body;
  const applied = [];
  const details = {};

  function copy() {
    if (out === body) out = { ...body };
  }

  if (knobs.modelMap && body && typeof body.model === 'string'
      && Object.prototype.hasOwnProperty.call(knobs.modelMap, body.model)) {
    copy();
    out.model = knobs.modelMap[body.model];
    applied.push('model');
    details.model = out.model;
  }

  if (Object.prototype.hasOwnProperty.call(knobs, 'thinking')) {
    const thinking = body && body.thinking;
    if (knobs.thinking === 'strip') {
      if (Object.prototype.hasOwnProperty.call(body || {}, 'thinking')) {
        copy();
        delete out.thinking;
        applied.push('thinking');
        details.thinking = 'strip';
      }
    } else if (thinking && thinking.type === 'enabled'
        && Number.isFinite(thinking.budget_tokens)
        && thinking.budget_tokens > knobs.thinking) {
      copy();
      out.thinking = { ...thinking, budget_tokens: knobs.thinking };
      applied.push('thinking');
      details.thinking = knobs.thinking;
    }
  }

  if (Object.prototype.hasOwnProperty.call(knobs, 'maxTokens')
      && Number.isFinite(body && body.max_tokens)
      && body.max_tokens > knobs.maxTokens) {
    copy();
    out.max_tokens = knobs.maxTokens;
    applied.push('maxTokens');
    details.maxTokens = knobs.maxTokens;
  }

  if (applied.length === 0) return { body, applied: [], skipped: null, details: {} };

  const invalid = isInvalidThinking(out);
  if (invalid) return { body, applied: [], skipped: invalid, details: {} };
  return { body: out, applied, skipped: null, details };
}

function formatRewriteHeader(applied, details = {}) {
  if (!Array.isArray(applied) || applied.length === 0) return null;
  const appliedSet = new Set(applied);
  const parts = [];
  for (const key of LEVER_ORDER) {
    if (appliedSet.has(key) && Object.prototype.hasOwnProperty.call(details, key)) {
      parts.push(`${key}=${details[key]}`);
    }
  }
  return parts.length > 0 ? parts.join(';') : null;
}

function createPollRewriteBreaker(opts = {}, deps = {}) {
  const windowMs = opts.windowMs;
  const threshold = opts.threshold;
  const resetMs = opts.resetMs;
  const states = new Map();

  function state(project) {
    if (!states.has(project)) states.set(project, { errors: [], disabledUntil: 0, trips: 0 });
    return states.get(project);
  }

  function prune(s, nowMs) {
    const cutoff = nowMs - windowMs;
    s.errors = s.errors.filter(t => t >= cutoff);
  }

  function alert(project) {
    try {
      const ledger = deps.ledger;
      const sendAlert = deps.sendAlert;
      const key = `pollrewrite-breaker:${project}`;
      if (!ledger || !sendAlert || !ledger.shouldSend(key)) return;
      ledger.markSent(key);
      Promise.resolve()
        .then(() => sendAlert(`⚠️ miser poll-rewrite breaker: project=${project}`))
        .catch(e => console.warn('[miser] poll-rewrite alert error:', e.message));
    } catch (e) {
      console.warn('[miser] poll-rewrite alert error:', e.message);
    }
  }

  return {
    isDisabled(project, nowMs) {
      const s = state(project);
      if (nowMs >= s.disabledUntil) prune(s, nowMs);
      return nowMs < s.disabledUntil;
    },
    recordOutcome(project, ok, nowMs) {
      const s = state(project);
      if (ok) {
        prune(s, nowMs);
        return { tripped: false };
      }
      prune(s, nowMs);
      s.errors.push(nowMs);
      if (s.errors.length >= threshold) {
        s.disabledUntil = nowMs + resetMs;
        s.errors = [];
        s.trips += 1;
        console.warn(`[miser] poll-rewrite disabled project=${project} reason=error-spike (${threshold} errors in ${windowMs}ms)`);
        alert(project);
        return { tripped: true };
      }
      return { tripped: false };
    },
    getState(project) {
      const s = state(project);
      return { disabledUntil: s.disabledUntil, windowCount: s.errors.length, trips: s.trips };
    },
  };
}

function wirePollRewrite(config, guardDeps = {}, seams = {}) {
  const projects = config && config.pollRewriteProjects;
  const breakerOpts = config && config.pollRewriteBreaker;
  if (!projects || Object.keys(projects).length === 0 || !breakerOpts) return null;

  let ledger = guardDeps.ledger;
  if (!ledger) {
    const mkLedger = typeof seams.createLedger === 'function'
      ? seams.createLedger
      : require('./alert-ledger.js').createLedger;
    ledger = mkLedger();
  }
  const sendAlert = guardDeps.sendAlert
    || (typeof seams.sendAlert === 'function' ? seams.sendAlert : require('./daily-rollup.js').sendAlert);

  return {
    projects: cloneProjects(projects),
    breaker: createPollRewriteBreaker({ ...breakerOpts }, { ledger, sendAlert }),
    shouldRewrite,
    applyPollRewrite,
    formatRewriteHeader,
    recordPollRewriteStats: typeof seams.recordPollRewriteStats === 'function'
      ? seams.recordPollRewriteStats
      : recordPollRewriteStats,
    nowFn: typeof seams.nowFn === 'function' ? seams.nowFn : () => new Date(),
  };
}

module.exports = {
  parsePollRewriteConfig,
  parsePollRewriteEnv,
  shouldRewrite,
  applyPollRewrite,
  formatRewriteHeader,
  createPollRewriteBreaker,
  wirePollRewrite,
  __test: { cloneProjects },
};
