'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isValidProjectName } = require('./routing.js');

const VALID_MODES = new Set(['observe', 'alert', 'throttle', 'block']);
const DEFAULT_POLICY = Object.freeze({
  mode: 'observe',
  scarceModeUsedWeeklyPct: 80,
  poll: Object.freeze({
    maxLikelyPollsPer10Min: 1,
    maxLikelyPollsPerHour: 6,
    minIdlePollSpacingSec: 600,
  }),
  orchControl: Object.freeze({
    maxControlTurnsPerHour: 12,
    maxControlTurnsPerSession: 60,
    terminalHandoffAllowed: true,
    terminalHandoffMaxTurns: 6,
    inboundBradReplyMaxTurns: 1,
  }),
  session: Object.freeze({
    maxAssistantTurnsObserve: 100,
    maxPollTurnRatio: 0.60,
    minTurnsForRatioGate: 40,
    maxRequestContextTokensObserve: 450000,
    maxSummedContextWeightedM: 40,
    maxFreshInputM: 25,
  }),
  toolResults: Object.freeze({
    maxToolResultBytes: 32768,
    maxTotalToolResultBytes: 131072,
    mode: 'alert',
  }),
  override: Object.freeze({
    allowGraceProjects: Object.freeze([]),
    overrideHeader: 'x-miser-override',
    overrideFile: '~/.miser-overrides.json',
    overrideReasonRequired: true,
  }),
});

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function finiteInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) return fallback;
  return n;
}

function cleanSubobject(value, defaults, spec = {}, partial = false) {
  const out = partial ? {} : { ...defaults };
  if (!isPlainObject(value)) return out;
  for (const key of Object.keys(defaults)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (typeof defaults[key] === 'boolean') {
      out[key] = Boolean(value[key]);
    } else if (Array.isArray(defaults[key])) {
      out[key] = Array.isArray(value[key]) ? value[key].filter(v => typeof v === 'string') : defaults[key];
    } else if (typeof defaults[key] === 'number') {
      const bounds = spec[key] || {};
      const integer = bounds.integer !== false;
      out[key] = integer
        ? finiteInt(value[key], defaults[key], bounds.min ?? 0, bounds.max ?? Number.MAX_SAFE_INTEGER)
        : finiteNumber(value[key], defaults[key], bounds.min ?? 0, bounds.max ?? Number.MAX_SAFE_INTEGER);
    } else if (typeof defaults[key] === 'string') {
      out[key] = typeof value[key] === 'string' && value[key].trim() ? value[key].trim() : defaults[key];
    }
  }
  return out;
}

function cleanPolicy(raw, project, partial = false) {
  if (!isPlainObject(raw)) {
    console.warn(`[miser/enforcement] WARN ${project}: policy must be an object; ignored`);
    return null;
  }
  const out = {};
  if (VALID_MODES.has(raw.mode)) out.mode = raw.mode;
  else if (!partial) out.mode = DEFAULT_POLICY.mode;
  if (raw.mode !== undefined && !VALID_MODES.has(raw.mode)) {
    console.warn(`[miser/enforcement] WARN ${project}: invalid mode ${JSON.stringify(raw.mode)}; using observe`);
  }
  if (raw.scarceModeUsedWeeklyPct !== undefined || !partial) {
    out.scarceModeUsedWeeklyPct = finiteNumber(raw.scarceModeUsedWeeklyPct, DEFAULT_POLICY.scarceModeUsedWeeklyPct, 0, 1000);
  }
  out.poll = cleanSubobject(raw.poll, DEFAULT_POLICY.poll, {}, partial);
  out.orchControl = cleanSubobject(raw.orchControl, DEFAULT_POLICY.orchControl, {}, partial);
  out.session = cleanSubobject(raw.session, DEFAULT_POLICY.session, {
    maxPollTurnRatio: { integer: false, min: 0, max: 1 },
  }, partial);
  out.toolResults = cleanSubobject(raw.toolResults, DEFAULT_POLICY.toolResults, {}, partial);
  if (out.toolResults.mode && !['observe', 'alert', 'throttle', 'block'].includes(out.toolResults.mode)) {
    out.toolResults.mode = DEFAULT_POLICY.toolResults.mode;
  }
  out.override = cleanSubobject(raw.override, DEFAULT_POLICY.override, {}, partial);
  return out;
}

function parseEnforcement(env) {
  if (typeof env !== 'string' || !env.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(env);
  } catch (err) {
    console.warn(`[miser/enforcement] WARN invalid MISER_ENFORCEMENT JSON (${err.message}); enforcement OFF`);
    return null;
  }
  if (!isPlainObject(parsed)) {
    console.warn('[miser/enforcement] WARN MISER_ENFORCEMENT must be a JSON object; enforcement OFF');
    return null;
  }
  const out = {};
  for (const [project, value] of Object.entries(parsed)) {
    const wildcard = project === '*';
    if (!wildcard && (!isValidProjectName(project)
        || project === '__proto__' || project === 'constructor' || project === 'prototype')) {
      console.warn(`[miser/enforcement] WARN invalid project key ${JSON.stringify(project)}; ignored`);
      continue;
    }
    const clean = cleanPolicy(value, project, !wildcard);
    if (clean) out[project] = clean;
  }
  if (Object.keys(out).length === 0) {
    console.warn('[miser/enforcement] WARN no valid project policies in MISER_ENFORCEMENT; enforcement OFF');
    return null;
  }
  return out;
}

function mergePolicy(base, override) {
  if (!base && !override) return null;
  const src = base || DEFAULT_POLICY;
  const over = override || {};
  return {
    ...src,
    ...over,
    poll: { ...(src.poll || {}), ...(over.poll || {}) },
    orchControl: { ...(src.orchControl || {}), ...(over.orchControl || {}) },
    session: { ...(src.session || {}), ...(over.session || {}) },
    toolResults: { ...(src.toolResults || {}), ...(over.toolResults || {}) },
    override: { ...(src.override || {}), ...(over.override || {}) },
  };
}

function resolvePolicy(config, project) {
  if (!config) return null;
  const base = config['*'] || null;
  const specific = config[project] || null;
  if (!base && !specific) return null;
  return mergePolicy(base || DEFAULT_POLICY, specific);
}

function textFromContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(block => {
      if (block == null) return '';
      if (typeof block === 'string') return block;
      if (typeof block.text === 'string') return block.text;
      if (block.type === 'tool_result') return textFromContent(block.content);
      if (block.type === 'tool_use') {
        try { return `${block.name || ''} ${JSON.stringify(block.input || {})}`; } catch (_) { return block.name || ''; }
      }
      try { return JSON.stringify(block); } catch (_) { return ''; }
    }).join('\n');
  }
  if (typeof content.text === 'string') return content.text;
  try { return JSON.stringify(content); } catch (_) { return ''; }
}

function blockBytes(block) {
  if (!block || block.type !== 'tool_result') return 0;
  if (typeof block.content === 'string') return Buffer.byteLength(block.content, 'utf8');
  try { return Buffer.byteLength(JSON.stringify(block.content), 'utf8'); } catch (_) { return 0; }
}

function latestUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') return messages[i];
  }
  return null;
}

function assistantTurns(messages) {
  return messages.filter(msg => msg && msg.role === 'assistant').length;
}

function collectClassifierText(body, project, panel) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const latestUser = latestUserMessage(messages);
  const parts = [project || '', panel || ''];
  if (latestUser) parts.push(textFromContent(latestUser.content));
  for (let i = Math.max(0, messages.length - 12); i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block && block.type === 'tool_use') parts.push(textFromContent([block]));
    }
  }
  return parts.join('\n').toLowerCase();
}

function includesAny(haystack, needles) {
  return needles.some(needle => haystack.includes(needle));
}

function classifyControl(body, project, panel) {
  const text = collectClassifierText(body, project, panel);
  const classes = [];
  if (includesAny(text, [
    'spawn-lane', 'safe-reap', 'boot-inject', '/api/sessions', 'replycount',
    'lastactivity', 'termdeck_session', 'predecessor', 'successor', 'census', 'reap',
  ])) classes.push('panel_lifecycle');
  if (includesAny(text, [
    'spawn-codex', 'spawn-grok', 'codex', 'grok', 'iqa', 'inversion',
    'builder-audit', 'briefing-', 'status_file', 'result.md', 'evidence.md',
    'deadline=',
  ]) || (text.includes('while ') && (text.includes('result.md') || text.includes('status_file')))) {
    classes.push('audit_monitor');
  }
  if (includesAny(text, [
    'weekly-pace', '/api/miser', 'miser/stats', 'miser/health', 'orch-token-gauge',
    'context data', 'fresh input', 'weighted token', 'miser_enforcement',
    'policy-watchdog', 'stopgap-watchdog',
  ])) classes.push('usage_monitor');
  if ((text.includes('/v1/orch/') && text.includes('/reply')) || includesAny(text, [
    'reply.token', 'telegram', 'pkachu channel', 'msg_id', 'thread.jsonl',
  ])) classes.push('brad_comms');
  if (includesAny(text, [
    'gh pr', 'gh run', 'git status', 'git diff', 'git fetch', 'mergeable',
    'ci status', 'check status',
  ])) classes.push('repo_status');
  if (includesAny(text, ['handoff', 'compact', 'compact-state', 'rotation', 'successor', 'predecessor'])) {
    classes.push('handoff');
  }
  return [...new Set(classes)];
}

function latestToolResultStats(body) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const latest = latestUserMessage(messages);
  const blocks = Array.isArray(latest && latest.content) ? latest.content : [];
  let max = 0;
  let total = 0;
  for (const block of blocks) {
    const bytes = blockBytes(block);
    max = Math.max(max, bytes);
    total += bytes;
  }
  return { maxLatestToolResultBytes: max, totalLatestToolResultBytes: total };
}

function classifyRequest(project, panel, body, compactHeaders = {}, rawTokens = 0) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const controlClasses = classifyControl(body, project, panel);
  return {
    project: project || 'default',
    panel: panel || null,
    pollClass: compactHeaders['x-miser-poll-class'] || compactHeaders['X-Miser-Poll-Class'] || 'unknown',
    controlClasses,
    isControl: controlClasses.length > 0,
    assistantTurns: assistantTurns(messages),
    messageCount: messages.length,
    rawTokens: Number.isFinite(rawTokens) ? rawTokens : 0,
    ...latestToolResultStats(body),
  };
}

function stateKey(project, panel) {
  return `${project || 'default'}--${panel || 'default'}`;
}

function pruneTimes(times, cutoff) {
  while (times.length > 0 && times[0] < cutoff) times.shift();
}

function weightedFromUsage(usage = {}, weights = DEFAULT_POLICY.weights || {}) {
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const creation = isPlainObject(usage.cache_creation) ? usage.cache_creation : {};
  const cacheWrite5m = creation.ephemeral_5m_input_tokens || 0;
  const cacheWrite1h = creation.ephemeral_1h_input_tokens || usage.cache_creation_input_tokens || 0;
  return input * (weights.input ?? 1)
    + cacheRead * (weights.cacheRead ?? 0.1)
    + cacheWrite5m * (weights.cacheWrite5m ?? 1.25)
    + cacheWrite1h * (weights.cacheWrite1h ?? 2)
    + output * (weights.output ?? 5);
}

function createEnforcementState(opts = {}) {
  const nowMs = opts.nowMs || (() => Date.now());
  const sessions = new Map();
  const events = [];

  function get(project, panel) {
    const key = stateKey(project, panel);
    if (!sessions.has(key)) {
      sessions.set(key, {
        project: project || 'default',
        panel: panel || null,
        likelyPollAt: [],
        controlAt: [],
        totalRequests: 0,
        likelyPollRequests: 0,
        controlTurns: 0,
        postCapHandoffTurns: 0,
        inboundBradReplyTurns: 0,
        freshInput: 0,
        weighted: 0,
        blocks: 0,
        wouldBlocks: 0,
        alerts: 0,
      });
    }
    return sessions.get(key);
  }

  function recordRequest(project, panel, classification) {
    const now = nowMs();
    const st = get(project, panel);
    pruneTimes(st.likelyPollAt, now - 60 * 60 * 1000);
    pruneTimes(st.controlAt, now - 60 * 60 * 1000);
    st.totalRequests += 1;
    if (classification.pollClass === 'likely') {
      st.likelyPollRequests += 1;
      st.likelyPollAt.push(now);
    }
    if (classification.isControl) {
      st.controlTurns += 1;
      st.controlAt.push(now);
    }
    return st;
  }

  function recordUsage(project, panel, usage = {}, weights = {}) {
    const st = get(project, panel);
    st.freshInput += usage.input_tokens || 0;
    st.weighted += weightedFromUsage(usage, weights);
    return st;
  }

  function recordDecision(project, panel, event) {
    const st = get(project, panel);
    if (event.decision === 'block') st.blocks += 1;
    if (event.decision === 'would_block') st.wouldBlocks += 1;
    if (event.decision === 'alert') st.alerts += 1;
    const stamped = { ...event, project, panel: panel || null, at: new Date(nowMs()).toISOString() };
    events.push(stamped);
    while (events.length > 500) events.shift();
    return stamped;
  }

  function snapshot() {
    return {
      warm: sessions.size > 0,
      sessions: Array.from(sessions.values()).map(st => ({ ...st, likelyPollAt: [...st.likelyPollAt], controlAt: [...st.controlAt] })),
      recentEvents: [...events],
    };
  }

  return { get, recordRequest, recordUsage, recordDecision, snapshot };
}

const defaultState = createEnforcementState();

function expandHome(file) {
  if (typeof file !== 'string' || !file.trim()) return null;
  if (file === '~') return os.homedir();
  if (file.startsWith('~/')) return path.join(os.homedir(), file.slice(2));
  return file;
}

function hasOverride(project, policy, headers = {}) {
  const override = policy && policy.override;
  if (!override) return false;
  const allow = Array.isArray(override.allowGraceProjects) ? override.allowGraceProjects : [];
  if (allow.includes(project)) return true;
  const headerName = String(override.overrideHeader || '').toLowerCase();
  if (headerName) {
    for (const [k, v] of Object.entries(headers || {})) {
      if (String(k).toLowerCase() === headerName && String(Array.isArray(v) ? v[0] : v).trim()) return true;
    }
  }
  const file = expandHome(override.overrideFile);
  if (!file) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) return parsed.includes(project);
    if (isPlainObject(parsed)) {
      const value = parsed[project];
      if (value === true) return true;
      if (isPlainObject(value)) {
        if (value.enabled === false) return false;
        if (value.expiresAt && Date.now() > new Date(value.expiresAt).getTime()) return false;
        return true;
      }
    }
  } catch (_) {}
  return false;
}

function canaryPollThrottleApplies(project, classification) {
  return project === 'nacho-orch' && classification.isControl;
}

function isTerminalHandoffTurn(classification) {
  const classes = new Set(classification.controlClasses || []);
  return classes.has('handoff') || classes.has('panel_lifecycle');
}

function isInboundBradTurn(classification) {
  const classes = new Set(classification.controlClasses || []);
  return classes.has('brad_comms');
}

function responseStatusFor(mode, reason) {
  if (mode === 'throttle') return reason === 'poll-budget' ? 429 : 429;
  return 403;
}

function buildEnforcementResponse(reason, mode, message, retryAfter = null) {
  const status = responseStatusFor(mode, reason);
  const headers = {
    'content-type': 'application/json',
    'x-miser-enforcement': reason,
    'x-miser-enforcement-mode': mode,
  };
  if (status === 429 && retryAfter) headers['retry-after'] = String(retryAfter);
  return {
    status,
    headers,
    body: {
      type: 'error',
      error: {
        type: status === 429 ? 'rate_limit_error' : 'invalid_request_error',
        message,
      },
    },
    enforcement: { reason, mode, status },
  };
}

function modeDecision(mode) {
  if (mode === 'observe') return 'would_block';
  if (mode === 'alert') return 'alert';
  return 'block';
}

function maybeBlock(project, panel, policy, classification, state, guardDeps, reason, message, retryAfter = 600) {
  const mode = policy.mode || 'observe';
  const decision = modeDecision(mode);
  const event = state.recordDecision(project, panel, {
    decision,
    reason,
    mode,
    controlClasses: classification.controlClasses,
    pollClass: classification.pollClass,
    assistantTurns: classification.assistantTurns,
  });
  if (guardDeps.recordEnforcementEvent) {
    guardDeps.recordEnforcementEvent(project, event, guardDeps.nowFn || (() => new Date()));
  }
  if (decision !== 'block') return null;
  return buildEnforcementResponse(reason, mode, message, retryAfter);
}

function pollCounts(st, now) {
  const tenMinCutoff = now - 10 * 60 * 1000;
  return {
    tenMin: st.likelyPollAt.filter(ts => ts >= tenMinCutoff).length,
    hour: st.likelyPollAt.length,
  };
}

function checkEnforcement(project, panel, body, compactHeaders = {}, rawTokens = 0, guardDeps = {}, requestHeaders = {}) {
  const config = guardDeps.enforcementConfig;
  if (!config) return null;
  const policy = resolvePolicy(config, project);
  if (!policy) return null;
  if (hasOverride(project, policy, requestHeaders)) return null;

  const state = guardDeps.enforcementState || defaultState;
  const classification = classifyRequest(project, panel, body, compactHeaders, rawTokens);
  const st = state.recordRequest(project, panel, classification);
  const now = guardDeps.nowFn ? guardDeps.nowFn().getTime() : Date.now();
  pruneTimes(st.likelyPollAt, now - 60 * 60 * 1000);
  pruneTimes(st.controlAt, now - 60 * 60 * 1000);

  const toolMode = policy.toolResults && policy.toolResults.mode;
  if (classification.maxLatestToolResultBytes > (policy.toolResults.maxToolResultBytes || Infinity)
      && toolMode === 'block' && policy.mode === 'block') {
    return maybeBlock(project, panel, policy, classification, state, guardDeps,
      'tool-result-budget',
      'miser: latest tool_result too large; write large output to an artifact and summarize the path',
      null);
  }

  if (classification.pollClass === 'likely' && canaryPollThrottleApplies(project, classification)) {
    const counts = pollCounts(st, now);
    if (counts.tenMin > (policy.poll.maxLikelyPollsPer10Min || DEFAULT_POLICY.poll.maxLikelyPollsPer10Min)
        || counts.hour > (policy.poll.maxLikelyPollsPerHour || DEFAULT_POLICY.poll.maxLikelyPollsPerHour)) {
      return maybeBlock(project, panel, policy, classification, state, guardDeps,
        'poll-budget',
        'miser: poll budget exceeded; use a zero-LLM watcher artifact before polling again',
        policy.poll.minIdlePollSpacingSec || 600);
    }
  }

  if (classification.isControl && project === 'nacho-orch') {
    const overHour = st.controlAt.length > (policy.orchControl.maxControlTurnsPerHour || DEFAULT_POLICY.orchControl.maxControlTurnsPerHour);
    const overSession = st.controlTurns > (policy.orchControl.maxControlTurnsPerSession || DEFAULT_POLICY.orchControl.maxControlTurnsPerSession);
    const freshOver = st.freshInput > (policy.session.maxFreshInputM || DEFAULT_POLICY.session.maxFreshInputM) * 1_000_000;
    const weightedOver = st.weighted > (policy.session.maxSummedContextWeightedM || DEFAULT_POLICY.session.maxSummedContextWeightedM) * 1_000_000;
    const assistantFreshOver = classification.assistantTurns > (policy.session.maxAssistantTurnsObserve || DEFAULT_POLICY.session.maxAssistantTurnsObserve)
      && (freshOver || weightedOver);
    if (overHour || overSession || assistantFreshOver) {
      if (policy.orchControl.terminalHandoffAllowed && isTerminalHandoffTurn(classification)
          && st.postCapHandoffTurns < (policy.orchControl.terminalHandoffMaxTurns || DEFAULT_POLICY.orchControl.terminalHandoffMaxTurns)) {
        st.postCapHandoffTurns += 1;
        return null;
      }
      if (isInboundBradTurn(classification)
          && st.inboundBradReplyTurns < (policy.orchControl.inboundBradReplyMaxTurns || DEFAULT_POLICY.orchControl.inboundBradReplyMaxTurns)) {
        st.inboundBradReplyTurns += 1;
        return null;
      }
      return maybeBlock(project, panel, policy, classification, state, guardDeps,
        'orch-control-budget',
        'miser: ORCH control-loop budget exceeded; write handoff or use a zero-LLM watcher artifact before continuing',
        600);
    }
  }

  const recentPollRatio = st.totalRequests > 0 ? st.likelyPollRequests / st.totalRequests : 0;
  if (classification.assistantTurns >= (policy.session.minTurnsForRatioGate || DEFAULT_POLICY.session.minTurnsForRatioGate)
      && recentPollRatio > (policy.session.maxPollTurnRatio || DEFAULT_POLICY.session.maxPollTurnRatio)
      && classification.pollClass === 'likely'
      && canaryPollThrottleApplies(project, classification)) {
    return maybeBlock(project, panel, policy, classification, state, guardDeps,
      'poll-ratio-budget',
      'miser: poll-heavy session exceeded allowed ratio; move monitoring to an artifact',
      600);
  }

  return null;
}

function recordEnforcementUsage(project, panel, usage, weights, guardDeps = {}) {
  const state = guardDeps.enforcementState || defaultState;
  return state.recordUsage(project, panel, usage || {}, weights || {});
}

module.exports = {
  DEFAULT_POLICY,
  parseEnforcement,
  resolvePolicy,
  classifyRequest,
  createEnforcementState,
  checkEnforcement,
  recordEnforcementUsage,
  __test: {
    textFromContent,
    latestToolResultStats,
    weightedFromUsage,
    canaryPollThrottleApplies,
  },
};
