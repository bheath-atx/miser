'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { isValidProjectName } = require('./routing.js');

const VALID_MODES = new Set(['observe', 'alert', 'throttle', 'block']);
const VALID_REDIRECT_MODES = new Set(['off', 'shadow', 'warn', 'enforce']);
const ACTIVE_REDIRECT_COMMAND_CLASSES = new Set([
  'POLL_CI',
  'POLL_TERMDECK',
  'POLL_MISER',
  'POLL_HEALTH',
  'SWEEP_REPO',
  'LOOP_SHELL',
]);
const REDIRECT_ARTIFACT_CANDIDATES = Object.freeze({
  POLL_CI: Object.freeze(['ci']),
  POLL_TERMDECK: Object.freeze(['termdeck', 'sessions']),
  POLL_MISER: Object.freeze(['miser', 'miser-stats', 'stats']),
  POLL_HEALTH: Object.freeze(['health']),
  SWEEP_REPO: Object.freeze(['repo-sweep', 'repos', 'repo']),
  LOOP_SHELL: Object.freeze(['loop-shell', 'watch']),
});
const DEFAULT_POLICY = Object.freeze({
  mode: 'observe',
  scarceModeUsedWeeklyPct: 80,
  redirect: Object.freeze({
    mode: 'off',
  }),
  poll: Object.freeze({
    maxLikelyPollsPer10Min: 1,
    maxLikelyPollsPerHour: 6,
    minIdlePollSpacingSec: 600,
  }),
  orchControl: Object.freeze({
    enabled: false,
    panels: Object.freeze([]),
    controlClasses: Object.freeze([
      'panel_lifecycle',
      'audit_monitor',
      'usage_monitor',
      'repo_status',
    ]),
    countUnclassifiedManagement: true,
    warnManagementTurnsPerAssignment: 2,
    maxManagementTurnsPerAssignment: 3,
    maxControlTurnsPerHour: 6,
    maxControlTurnsPerSession: 12,
    maxRevisionCycles: 2,
    warnSelfWorkTurnsPerAssignment: 1,
    maxSelfWorkTurnsPerAssignment: 1,
    duplicateDebounceMs: 2000,
    newConversationAssistantTurnDrop: 4,
    assignmentIdHeader: 'x-miser-assignment-id',
    assignmentIdMarker: 'MISER_ASSIGNMENT=',
    approvalHeader: 'x-miser-brad-approval',
    approvalMarkers: Object.freeze(['BRAD_APPROVED_CONTINUE']),
    completionMarkers: Object.freeze(['ORCH-RESULT', 'TASK-COMPLETE', 'VERDICT=APPROVE']),
    handoffMarkers: Object.freeze(['COMPACT-STATE', 'HANDOFF-WRITTEN']),
    revisionMarkers: Object.freeze(['PROPOSAL_REVISION', 'REVISION_BRIEFING', 'REVISION_CYCLE', 'REVISE_PROPOSAL']),
    dispatchFinalizeMarker: 'DISPATCH_FINALIZE',
    dispatchSessionHeader: 'x-miser-dispatch-session',
    dispatchSessionMarkers: Object.freeze(['CHILD_SESSION=', 'SESSION_ID=', 'TERMDECK_SESSION=']),
    terminalHandoffAllowed: true,
    terminalHandoffMaxTurns: 2,
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
  out.redirect = cleanSubobject(raw.redirect, DEFAULT_POLICY.redirect, {}, partial);
  if (out.redirect.mode && !VALID_REDIRECT_MODES.has(out.redirect.mode)) {
    console.warn(`[miser/enforcement] WARN ${project}: invalid redirect.mode ${JSON.stringify(out.redirect.mode)}; using off`);
    out.redirect.mode = DEFAULT_POLICY.redirect.mode;
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
    redirect: { ...(src.redirect || {}), ...(over.redirect || {}) },
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

function firstUserMessage(messages) {
  for (const msg of messages) {
    if (msg && msg.role === 'user') return msg;
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

function collectRecentToolText(body, window = 2) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const parts = [];
  for (let i = Math.max(0, messages.length - window); i < messages.length; i++) {
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

function getHeader(headers = {}, name = '') {
  const needle = String(name || '').toLowerCase();
  if (!needle) return '';
  for (const [k, v] of Object.entries(headers || {})) {
    if (String(k).toLowerCase() === needle) {
      const value = Array.isArray(v) ? v[0] : v;
      return String(value == null ? '' : value).trim();
    }
  }
  return '';
}

function latestUserText(body) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const latest = latestUserMessage(messages);
  return latest ? textFromContent(latest.content) : '';
}

function promptTextFromContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    return typeof content.text === 'string' ? content.text : '';
  }
  return content.map(block => {
    if (block == null) return '';
    if (typeof block === 'string') return block;
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    if (!block.type && typeof block.text === 'string') return block.text;
    return '';
  }).filter(Boolean).join('\n');
}

function latestUserPromptText(body) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const latest = latestUserMessage(messages);
  return latest ? promptTextFromContent(latest.content) : '';
}

function systemPromptHead(body, maxBytes = 2048) {
  const parts = [];
  const top = body && body.system;
  if (typeof top === 'string') parts.push(top);
  else if (Array.isArray(top)) parts.push(promptTextFromContent(top));

  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  for (const msg of messages) {
    if (msg && msg.role === 'system') parts.push(promptTextFromContent(msg.content));
  }
  return parts.filter(Boolean).join('\n').slice(0, maxBytes);
}

function firstUserPromptText(body, maxBytes = 4096) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const first = firstUserMessage(messages);
  if (!first) return '';
  const prompt = promptTextFromContent(first.content) || textFromContent(first.content);
  return prompt.slice(0, maxBytes);
}

function conversationFingerprint(body) {
  const features = {
    system_head: systemPromptHead(body),
    first_user: firstUserPromptText(body),
  };
  return crypto.createHash('sha256').update(JSON.stringify(features)).digest('hex');
}

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function terminalMessageShape(body) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const latestIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'user') return i;
    }
    return -1;
  })();
  if (latestIndex < 0) return { kind: 'none', text: '', toolUse: null };
  const latest = messages[latestIndex];
  const blocks = Array.isArray(latest.content) ? latest.content : [];
  const toolResult = blocks.find(block => block && block.type === 'tool_result');
  if (!toolResult) {
    const text = promptTextFromContent(latest.content) || textFromContent(latest.content);
    const lower = text.toLowerCase();
    if (lower.includes('<task-notification>')
        || lower.includes('stop-hook')
        || lower.includes('stop_hook')
        || lower.includes('monitor callback')) {
      return { kind: 'notification', text, toolUse: null };
    }
    return { kind: 'real_user_text', text, toolUse: null };
  }

  const id = toolResult.tool_use_id || toolResult.id || '';
  for (let i = latestIndex - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const match = msg.content.find(block => block && block.type === 'tool_use' && (!id || block.id === id));
    if (match) return { kind: 'tool_result', text: textFromContent(toolResult.content), toolUse: match };
  }
  return { kind: 'tool_result', text: textFromContent(toolResult.content), toolUse: null };
}

function extractToolCommand(toolUse) {
  if (!toolUse || typeof toolUse !== 'object') return { name: '', command: '', filePath: '' };
  const name = String(toolUse.name || '');
  const input = toolUse.input && typeof toolUse.input === 'object' ? toolUse.input : {};
  const command = typeof input.command === 'string'
    ? input.command
    : typeof input.cmd === 'string'
      ? input.cmd
      : '';
  const filePath = typeof input.file_path === 'string'
    ? input.file_path
    : typeof input.path === 'string'
      ? input.path
      : '';
  return { name, command, filePath };
}

function promptCommandCandidate(shape) {
  if (!shape || (shape.kind !== 'real_user_text' && shape.kind !== 'notification')) return '';
  const text = normalizedText(shape.text);
  const lower = text.toLowerCase();
  if (!text) return '';
  if (/\bdo\s+not\s+(?:poll|run|execute|check)\b/.test(lower)) return '';
  if (/\bdon't\s+(?:poll|run|execute|check)\b/.test(lower)) return '';
  return text;
}

function deriveRole(body, project, panel) {
  const haystack = [
    project || '',
    panel || '',
    systemPromptHead(body, 4096),
    latestUserPromptText(body),
  ].join('\n').toLowerCase();
  if (/\borch\b/.test(haystack)
      || haystack.includes('orchestrator')
      || haystack.includes('miser_assignment=')
      || haystack.includes('orch-control')
      || haystack.includes('architect lane')) {
    return 'ORCH';
  }
  if (haystack.includes('builder') || haystack.includes('codex builder') || haystack.includes('implementation lane')) {
    return 'builder';
  }
  return 'unknown';
}

function commandMatches(command, patterns) {
  return patterns.some(pattern => pattern.test(command));
}

const DISPATCH_OK_PATTERNS = [
  /\bspawn-lane\.sh\b/,
  /\bsafe-reap\.sh\b/,
  /\btd-inject\b/,
  /\bpost\b.*:(?:8001)\/v1\/orch\/[^/\s]+\/reply\b/i,
  /\bcurl\b.*(?:-x\s+)?post\b.*\/v1\/orch\/[^/\s]+\/reply\b/i,
  /^\s*git\s+fetch(?:\s+--[^\s]+|\s+\S+){0,2}\s*$/i,
  /^\s*date(?:\s+[^\n;&|]+)?\s*$/i,
];

const POLL_CI_PATTERNS = [
  /\bgh\s+run\s+(?:view|watch|list)\b/i,
  /\bgh\s+pr\s+checks\b/i,
  /\bgh\s+pr\s+view\b.*--json\b.*(?:state|statusCheckRollup)/i,
  /\bgh\s+api\b.*check-runs\b/i,
];

const POLL_TERMDECK_PATTERNS = [
  /\bcurl\b.*:(?:3100|3200)\/api\/sessions\b/i,
  /\b(?:replyCount|lastActivity)\b/i,
  /\/api\/sessions\/[A-Za-z0-9._:-]+/i,
];

const POLL_MISER_PATTERNS = [
  /\bcurl\b.*:20128\/(?:health|stats|events)\b/i,
  /\/api\/miser\b/i,
  /\bmiser\b.*\b(?:logs?|tail)\b/i,
];

const POLL_HEALTH_PATTERNS = [
  /\bsystemctl\s+(?:--user\s+)?status\b/i,
  /(?:^|\s)~?\/?morning-health-check\.sh\b/i,
  /\bnvidia-smi\b/i,
  /\b(?:nc|lsof|ss)\b.*(?:-z|listen|sport|:)\b/i,
];

const SWEEP_REPO_PATTERNS = [
  /\bgh\s+pr\s+list\b/i,
  /\bfor\s+repo\s+in\b/i,
  /\bmirror-[\w.-]*sweep\b/i,
  /\bsweep\b.*\brepos?\b/i,
];

const LOOP_SHELL_PATTERNS = [
  /\bwhile\b[\s\S]*\bsleep\b/i,
  /(^|\s)watch\s+/i,
  /\bsleep\s+\d+(?:\.\d+)?\s*&&/i,
];

const SELF_WORK_PATTERNS = [
  /\bnpm\s+test\b/i,
  /\bpytest\b/i,
  /\bnode\s+--test\b/i,
  /\b(?:cargo|go)\s+test\b/i,
  /\bbenchmark\b/i,
];

function isDispatchArtifactPath(filePath) {
  const s = String(filePath || '').toLowerCase();
  return !!s && (
    s.includes('/.sprint/')
    || s.includes('/sprints/')
    || s.includes('briefing')
    || s.includes('dispatch')
    || s.includes('handoff')
    || s.includes('result')
    || s.includes('status')
  );
}

function isCodeOrTestPath(filePath) {
  const s = String(filePath || '').toLowerCase();
  if (!s || isDispatchArtifactPath(s)) return false;
  return /(?:^|\/)(?:src|lib|app|server|test|tests|spec)\//.test(s)
    || /\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|rb|java|c|cc|cpp|h|hpp|sh|json|ya?ml|toml)$/.test(s);
}

function classifyCommandClass(body, project, panel, role) {
  const shape = terminalMessageShape(body);
  const tool = extractToolCommand(shape.toolUse);
  const name = tool.name.toLowerCase();
  const command = normalizedText(tool.command || promptCommandCandidate(shape));
  const filePath = tool.filePath;

  if (command && commandMatches(command, DISPATCH_OK_PATTERNS)) return { commandClass: 'DISPATCH_OK', terminalShape: shape.kind };
  if (filePath && isDispatchArtifactPath(filePath)) return { commandClass: 'DISPATCH_OK', terminalShape: shape.kind };
  if (command && commandMatches(command, POLL_CI_PATTERNS)) return { commandClass: 'POLL_CI', terminalShape: shape.kind };
  if (command && commandMatches(command, POLL_TERMDECK_PATTERNS)) return { commandClass: 'POLL_TERMDECK', terminalShape: shape.kind };
  if (command && commandMatches(command, POLL_MISER_PATTERNS)) return { commandClass: 'POLL_MISER', terminalShape: shape.kind };
  if (command && commandMatches(command, POLL_HEALTH_PATTERNS)) return { commandClass: 'POLL_HEALTH', terminalShape: shape.kind };
  if (command && commandMatches(command, SWEEP_REPO_PATTERNS)) return { commandClass: 'SWEEP_REPO', terminalShape: shape.kind };
  if (command && commandMatches(command, LOOP_SHELL_PATTERNS)) return { commandClass: 'LOOP_SHELL', terminalShape: shape.kind };
  if (role === 'ORCH') {
    if (command && commandMatches(command, SELF_WORK_PATTERNS)) return { commandClass: 'SELF_WORK', terminalShape: shape.kind };
    if (['edit', 'write', 'multiedit'].includes(name) && isCodeOrTestPath(filePath)) {
      return { commandClass: 'SELF_WORK', terminalShape: shape.kind };
    }
  }
  return { commandClass: 'NEUTRAL', terminalShape: shape.kind };
}

function isRedirectableCommandClass(commandClass) {
  return !['DISPATCH_OK', 'NEUTRAL'].includes(commandClass);
}

function hasTextMarker(text, markers) {
  if (!Array.isArray(markers) || !text) return false;
  return markers.some(marker => typeof marker === 'string' && marker.trim() && text.includes(marker));
}

function escapeRegExp(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function hasControlLineMarker(text, markers) {
  if (!Array.isArray(markers) || !text) return false;
  const lines = String(text).split(/\r?\n/);
  return markers.some(marker => {
    if (typeof marker !== 'string' || !marker.trim()) return false;
    const re = new RegExp(`^\\s*${escapeRegExp(marker.trim())}(?:\\s+[^\\r\\n]*)?\\s*$`);
    return lines.some(line => re.test(line));
  });
}

function valueAfterMarker(text, marker) {
  if (!text || typeof marker !== 'string' || !marker) return '';
  const idx = text.indexOf(marker);
  if (idx < 0) return '';
  const rest = text.slice(idx + marker.length).trimStart();
  const match = rest.match(/^([A-Za-z0-9._:@/-]+)/);
  return match ? match[1] : '';
}

function extractAssignmentId(policy, text, headers) {
  const orch = policy.orchControl || {};
  const fromHeader = getHeader(headers, orch.assignmentIdHeader);
  if (fromHeader) return fromHeader;
  const fromMarker = valueAfterMarker(text, orch.assignmentIdMarker);
  if (fromMarker) return fromMarker;
  return '';
}

function textLooksManagementLike(text) {
  const lower = String(text || '').toLowerCase();
  return includesAny(lower, [
    'proposal', 'revision briefing', 'revision cycle', 'revise proposal', 'architect review',
    'builder audit', 'review verdict', 'approval gate', 'brad approval', 'handoff',
    'assignment budget', 'orchestrator', 'orch management', 'panel handoff', 'lane owner',
    'status artifact', 'result artifact', 'compact result', 'cross-orch', 'route this',
  ]);
}

function textLooksRevisionLike(text, markers = []) {
  if (hasTextMarker(text, markers)) return true;
  const lower = String(text || '').toLowerCase();
  return includesAny(lower, [
    'proposal revision', 'revision briefing', 'revision cycle', 'revise the proposal',
    'revise proposal', 'automatic proposal', 'architect revision',
  ]);
}

function lineIsNegatedInstruction(line) {
  const lower = String(line || '').toLowerCase();
  return /\b(do not|don't|no|never|must not)\b/.test(lower)
    && /\b(poll|health|census|status|session|api\/sessions)\b/.test(lower);
}

function lineIsNegatedSelfWorkInstruction(line) {
  const lower = String(line || '').toLowerCase();
  return /\b(do not|don't|no|never|must not)\b/.test(lower)
    && /\b(run|use|call|poll|inspect|check|read|write|edit|build|code|implement|fix|audit)\b/.test(lower);
}

function textLooksPollingCommandLike(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lineIsNegatedInstruction(lower)) continue;
    if (includesAny(lower, [
      '/api/sessions',
      '/api/miser',
      'replycount',
      'lastactivity',
      'while true',
      'while sleep',
      'watch ',
      'tail -f',
      'health check',
      'morning-health-check',
      'census',
      'orch-token-gauge',
      'weekly-pace',
      'gh run',
      'gh pr view',
      'check status',
      'ci status',
    ])) return true;
    if (/\bpoll(?:ing)?\b/.test(lower) && /\b(termdeck|session|fleet|status|audit|result|health)\b/.test(lower)) {
      return true;
    }
  }
  return false;
}

function textLooksSelfWorkCommandLike(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lineIsNegatedSelfWorkInstruction(lower)) continue;

    const dispatchOnly = includesAny(lower, [
      'spawn-lane.sh',
      'td-inject.sh',
      'spawn-codex-audit.sh',
      'spawn-grok-audit.sh',
    ]) && !includesAny(lower, [
      'while ',
      ' sleep ',
      'gh run',
      'gh pr',
      'git ',
      'npm ',
      'pnpm ',
      'yarn ',
      '/api/sessions',
      '/api/miser',
    ]);
    if (dispatchOnly) continue;

    if (includesAny(lower, [
      'read {"file_path"',
      'write {"file_path"',
      'edit {"file_path"',
      'multiedit {"file_path"',
      'mcp__plugin_vercel',
      'mcp__claude_ai_vercel',
      'mcp__supabase',
      'plugin:vercel',
      'gh run',
      'gh pr',
      'git status',
      'git diff',
      'git show',
      'git log',
      'npm run',
      'pnpm ',
      'yarn ',
      'curl ',
      'sed -n',
      'nl -ba',
      'rg ',
      'cat ',
      'find ',
    ])) return true;
  }
  return false;
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
  const latestText = latestUserText(body);
  const latestPromptText = latestUserPromptText(body);
  const classifierText = collectClassifierText(body, project, panel);
  const selfWorkText = [latestText, collectRecentToolText(body)].join('\n');
  const controlClasses = classifyControl(body, project, panel);
  const pureBradComms = controlClasses.length === 1 && controlClasses[0] === 'brad_comms';
  const role = deriveRole(body, project, panel);
  const command = classifyCommandClass(body, project, panel, role);
  return {
    project: project || 'default',
    panel: panel || null,
    role,
    conversationFingerprint: conversationFingerprint(body),
    commandClass: command.commandClass,
    terminalShape: command.terminalShape,
    redirectable: isRedirectableCommandClass(command.commandClass),
    latestUserText: latestText,
    latestUserPromptText: latestPromptText,
    pollClass: compactHeaders['x-miser-poll-class'] || compactHeaders['X-Miser-Poll-Class'] || 'unknown',
    controlClasses,
    isControl: controlClasses.length > 0,
    managementLike: textLooksManagementLike(latestText),
    revisionLike: textLooksRevisionLike(latestText, DEFAULT_POLICY.orchControl.revisionMarkers),
    pollingCommandLike: textLooksPollingCommandLike(classifierText),
    selfWorkCommandLike: !pureBradComms && textLooksSelfWorkCommandLike(selfWorkText),
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
  const redirectStats = {
    wouldSynthesize: 0,
    byCommandClass: {},
    byRole: {},
    byMode: {},
    byFingerprint: {},
  };

  function get(project, panel) {
    const key = stateKey(project, panel);
    if (!sessions.has(key)) {
      sessions.set(key, {
        project: project || 'default',
        panel: panel || null,
        likelyPollAt: [],
        controlAt: [],
        selfWorkAt: [],
        totalRequests: 0,
        likelyPollRequests: 0,
        controlTurns: 0,
        selfWorkTurns: 0,
        postCapHandoffTurns: 0,
        inboundBradReplyTurns: 0,
        currentAssignmentId: null,
        assignmentStartedAt: null,
        assignmentManagementTurns: 0,
        assignmentWarningSent: false,
        selfWorkWarningSent: false,
        assignmentBlocked: false,
        assignmentRevisionCycles: 0,
        dispatchFinalizeUsed: false,
        lastSeenAt: null,
        lastAssistantTurns: 0,
        lastMessageCount: 0,
        lastCountedAt: null,
        lastCountedFingerprint: null,
        freshInput: 0,
        weighted: 0,
        blocks: 0,
        wouldBlocks: 0,
        alerts: 0,
      });
    }
    return sessions.get(key);
  }

  function resetAssignment(st, assignmentId, now, resetAllowances = false) {
    st.currentAssignmentId = assignmentId || st.currentAssignmentId || null;
    st.assignmentStartedAt = now;
    st.assignmentManagementTurns = 0;
    st.assignmentWarningSent = false;
    st.assignmentBlocked = false;
    st.assignmentRevisionCycles = 0;
    st.dispatchFinalizeUsed = false;
    if (resetAllowances) {
      st.postCapHandoffTurns = 0;
      st.inboundBradReplyTurns = 0;
    }
    return st;
  }

  function resetProtectedSessionWindow(st, now) {
    st.likelyPollAt = [];
    st.controlAt = [];
    st.selfWorkAt = [];
    st.totalRequests = 0;
    st.likelyPollRequests = 0;
    st.controlTurns = 0;
    st.selfWorkTurns = 0;
    st.postCapHandoffTurns = 0;
    st.inboundBradReplyTurns = 0;
    st.currentAssignmentId = null;
    st.assignmentStartedAt = now;
    st.assignmentManagementTurns = 0;
    st.assignmentWarningSent = false;
    st.selfWorkWarningSent = false;
    st.assignmentBlocked = false;
    st.assignmentRevisionCycles = 0;
    st.dispatchFinalizeUsed = false;
    st.lastCountedAt = null;
    st.lastCountedFingerprint = null;
    return st;
  }

  function looksLikeNewConversation(st, classification, opts = {}) {
    if (!opts.protectedPanel || st.totalRequests === 0) return false;
    const turnDrop = opts.newConversationAssistantTurnDrop ?? DEFAULT_POLICY.orchControl.newConversationAssistantTurnDrop;
    if (st.lastAssistantTurns >= turnDrop && classification.assistantTurns <= 1) return true;
    if (st.lastMessageCount >= 12 && classification.messageCount > 0 && classification.messageCount + 4 < st.lastMessageCount) return true;
    return false;
  }

  function countedFingerprint(classification) {
    return [
      classification.pollClass || '',
      classification.assistantTurns || 0,
      classification.messageCount || 0,
      classification.latestUserPromptText || classification.latestUserText || '',
      (classification.controlClasses || []).join(','),
    ].join('\u001f');
  }

  function isDuplicateCountedTurn(st, classification, now, opts = {}) {
    const debounceMs = opts.duplicateDebounceMs ?? DEFAULT_POLICY.orchControl.duplicateDebounceMs;
    if (!debounceMs || !st.lastCountedAt || now - st.lastCountedAt > debounceMs) return false;
    const fp = countedFingerprint(classification);
    return fp === st.lastCountedFingerprint;
  }

  function resetControlLoop(project, panel) {
    const st = get(project, panel);
    st.likelyPollAt = [];
    st.controlAt = [];
    st.totalRequests = 0;
    st.likelyPollRequests = 0;
    st.controlTurns = 0;
    st.postCapHandoffTurns = 0;
    st.inboundBradReplyTurns = 0;
    return st;
  }

  function recordRequest(project, panel, classification, opts = {}) {
    const now = nowMs();
    const st = get(project, panel);
    pruneTimes(st.likelyPollAt, now - 60 * 60 * 1000);
    pruneTimes(st.controlAt, now - 60 * 60 * 1000);
    pruneTimes(st.selfWorkAt, now - 60 * 60 * 1000);
    if (looksLikeNewConversation(st, classification, opts)) {
      resetProtectedSessionWindow(st, now);
    }
    if (opts.protectedPanel) {
      if (!st.currentAssignmentId && opts.assignmentId) {
        resetAssignment(st, opts.assignmentId, now, true);
      } else if (opts.assignmentId && st.currentAssignmentId !== opts.assignmentId) {
        resetAssignment(st, opts.assignmentId, now, true);
      } else if (opts.resetAssignment) {
        resetAssignment(st, opts.assignmentId || st.currentAssignmentId, now, opts.resetAllowances);
      }
    } else if (!classification.isControl) {
      resetControlLoop(project, panel);
    }
    st.totalRequests += 1;
    st.lastSeenAt = now;
    st.lastAssistantTurns = classification.assistantTurns;
    st.lastMessageCount = classification.messageCount;
    const duplicateCountedTurn = opts.countedManagement && isDuplicateCountedTurn(st, classification, now, opts);
    const countsForPoll = opts.protectedPanel ? opts.countedManagement : classification.isControl;
    const countsForControl = opts.protectedPanel ? opts.countedManagement && classification.isControl : classification.isControl;
    if (classification.pollClass === 'likely' && countsForPoll && classification.pollingCommandLike && !duplicateCountedTurn) {
      st.likelyPollRequests += 1;
      st.likelyPollAt.push(now);
    }
    if (countsForControl && !duplicateCountedTurn) {
      st.controlTurns += 1;
      st.controlAt.push(now);
    }
    if (opts.protectedPanel && opts.countedManagement && classification.selfWorkCommandLike && !duplicateCountedTurn) {
      st.selfWorkTurns += 1;
      st.selfWorkAt.push(now);
    }
    if (opts.protectedPanel && opts.countedManagement && !duplicateCountedTurn) {
      st.assignmentManagementTurns += 1;
      if (classification.revisionLike) st.assignmentRevisionCycles += 1;
      st.lastCountedAt = now;
      st.lastCountedFingerprint = countedFingerprint(classification);
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

  function recordRedirectDecision(project, panel, event) {
    const stamped = {
      ...event,
      project,
      panel: panel || null,
      at: new Date(nowMs()).toISOString(),
    };
    if (event.would_synthesize === true) {
      redirectStats.wouldSynthesize += 1;
      const commandClass = event.commandClass || 'NEUTRAL';
      const role = event.role || 'unknown';
      const mode = event.mode || 'off';
      const fingerprint = event.fingerprint || 'unknown';
      redirectStats.byCommandClass[commandClass] = (redirectStats.byCommandClass[commandClass] || 0) + 1;
      redirectStats.byRole[role] = (redirectStats.byRole[role] || 0) + 1;
      redirectStats.byMode[mode] = (redirectStats.byMode[mode] || 0) + 1;
      redirectStats.byFingerprint[fingerprint] = (redirectStats.byFingerprint[fingerprint] || 0) + 1;
    }
    events.push(stamped);
    while (events.length > 500) events.shift();
    return stamped;
  }

  function snapshot() {
    return {
      warm: sessions.size > 0,
      sessions: Array.from(sessions.values()).map(st => ({
        ...st,
        likelyPollAt: [...st.likelyPollAt],
        controlAt: [...st.controlAt],
        selfWorkAt: [...st.selfWorkAt],
      })),
      redirect: {
        wouldSynthesize: redirectStats.wouldSynthesize,
        byCommandClass: { ...redirectStats.byCommandClass },
        byRole: { ...redirectStats.byRole },
        byMode: { ...redirectStats.byMode },
        byFingerprint: { ...redirectStats.byFingerprint },
      },
      recentEvents: [...events],
    };
  }

  return { get, resetControlLoop, recordRequest, recordUsage, recordDecision, recordRedirectDecision, snapshot };
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

function orchControlApplies(panel, policy) {
  const orch = policy && policy.orchControl;
  if (!orch || !orch.enabled) return false;
  const panels = Array.isArray(orch.panels) ? orch.panels : [];
  if (panels.length > 0 && !panels.includes(panel || '')) return false;
  return true;
}

function isCountedOrchManagementTurn(policy, classification) {
  const orch = policy.orchControl || {};
  if (classification.selfWorkCommandLike) return true;
  if (classification.isControl) {
    const classes = Array.isArray(orch.controlClasses) ? orch.controlClasses : [];
    if (classes.length === 0) return true;
    return (classification.controlClasses || []).some(c => classes.includes(c));
  }
  return orch.countUnclassifiedManagement === true && classification.managementLike === true;
}

function isApprovalTurn(policy, text, headers) {
  const orch = policy.orchControl || {};
  return !!getHeader(headers, orch.approvalHeader)
    || (!!extractAssignmentId(policy, text, headers) && hasControlLineMarker(text, orch.approvalMarkers));
}

function isCompletionTurn(policy, text, headers) {
  return !!extractAssignmentId(policy, text, headers)
    && hasControlLineMarker(text, (policy.orchControl || {}).completionMarkers);
}

function isHandoffMarkedTurn(policy, text, headers) {
  return !!extractAssignmentId(policy, text, headers)
    && hasControlLineMarker(text, (policy.orchControl || {}).handoffMarkers);
}

function hasDispatchSessionMarker(policy, text, headers) {
  const orch = policy.orchControl || {};
  if (getHeader(headers, orch.dispatchSessionHeader)) return true;
  return hasTextMarker(text, orch.dispatchSessionMarkers);
}

function isDispatchFinalizeTurn(policy, classification, headers) {
  const orch = policy.orchControl || {};
  const text = classification.latestUserPromptText || '';
  return typeof orch.dispatchFinalizeMarker === 'string'
    && orch.dispatchFinalizeMarker
    && hasControlLineMarker(text, [orch.dispatchFinalizeMarker])
    && !!extractAssignmentId(policy, text, headers)
    && hasDispatchSessionMarker(policy, text, headers);
}

function isTerminalHandoffTurn(classification) {
  const classes = new Set(classification.controlClasses || []);
  return classes.has('handoff') && classification.handoffMarked === true;
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

function buildWarningResponse(reason, mode, message, model = 'miser-enforcement-warning') {
  return {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-miser-enforcement-warning': reason,
      'x-miser-enforcement-mode': mode,
    },
    body: {
      id: `miser_warning_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: model || 'miser-enforcement-warning',
      content: [{ type: 'text', text: message }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    },
    enforcement: { reason, mode, status: 200, warning: true },
  };
}

function syntheticText(text) {
  const body = String(text || '').trim();
  if (body.startsWith('[MISER-SYNTHETIC]')) return body;
  return `[MISER-SYNTHETIC]${body ? ` ${body}` : ''}`;
}

function zeroUsage() {
  return {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
}

function miserMessageId(prefix = 'msg_miser') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function buildSyntheticMessageResponse(originalBody = {}, text = '', opts = {}) {
  return {
    id: opts.id || miserMessageId(),
    type: 'message',
    role: 'assistant',
    model: opts.model || originalBody.model || 'miser-synthetic',
    content: [{ type: 'text', text: syntheticText(text) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: zeroUsage(),
  };
}

function anthropicSseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function buildSyntheticSseResponse(originalBody = {}, text = '', opts = {}) {
  const body = buildSyntheticMessageResponse(originalBody, text, opts);
  return [
    anthropicSseFrame('message_start', {
      type: 'message_start',
      message: {
        id: body.id,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: body.usage,
      },
    }),
    anthropicSseFrame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    anthropicSseFrame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: body.content[0].text },
    }),
    anthropicSseFrame('content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    }),
    anthropicSseFrame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 0 },
    }),
    anthropicSseFrame('message_stop', { type: 'message_stop' }),
  ].join('');
}

function forcedToolChoice(body) {
  const choice = body && body.tool_choice;
  if (choice == null) return false;
  if (typeof choice === 'string') return !['auto', 'none'].includes(choice.toLowerCase());
  if (typeof choice === 'object') {
    const type = String(choice.type || '').toLowerCase();
    if (!type) return true;
    return !['auto', 'none'].includes(type);
  }
  return true;
}

function safeForSyntheticRedirect(body, classification) {
  return !!(
    classification
    && classification.redirectable === true
    && ACTIVE_REDIRECT_COMMAND_CLASSES.has(classification.commandClass)
    && ['tool_result', 'real_user_text', 'notification'].includes(classification.terminalShape)
    && !forcedToolChoice(body)
  );
}

function artifactCandidates(commandClass) {
  const ids = REDIRECT_ARTIFACT_CANDIDATES[commandClass] || [];
  return ids.length ? ids : [String(commandClass || 'unknown').toLowerCase()];
}

function fallbackArtifactPath(id) {
  return path.join(os.homedir(), '.miser', 'watch', `${id}.md`);
}

function watcherCompactPath(watcher, id) {
  if (watcher && typeof watcher.pathsFor === 'function') {
    try {
      const paths = watcher.pathsFor(id);
      if (paths && typeof paths.compact === 'string') return paths.compact;
    } catch (_) {}
  }
  return fallbackArtifactPath(id);
}

function readWatcherArtifact(commandClass, guardDeps = {}) {
  const watcher = guardDeps.watcher || null;
  for (const id of artifactCandidates(commandClass)) {
    const compactPath = watcherCompactPath(watcher, id);
    try {
      const text = fs.readFileSync(compactPath, 'utf8');
      if (String(text || '').trim()) {
        return { id, path: compactPath, text, missing: false };
      }
    } catch (_) {}
  }
  const missingId = artifactCandidates(commandClass)[0];
  return {
    id: missingId,
    path: watcherCompactPath(watcher, missingId),
    text: '',
    missing: true,
  };
}

function trimSyntheticArtifactText(text, maxBytes = 16 * 1024) {
  let out = String(text || '').trim();
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, Math.max(0, out.length - 1));
  return out;
}

function redirectInstructionText(mode, classification, artifact) {
  const commandClass = classification.commandClass || 'UNKNOWN';
  const artifactPath = artifact && artifact.path ? artifact.path : fallbackArtifactPath((artifactCandidates(commandClass)[0]));
  if (mode === 'warn') {
    return [
      `miser warning: ${commandClass} is a zero-LLM watcher redirect class.`,
      `Do not poll live from Claude. Use watcher artifact ${artifactPath} instead.`,
      artifact && artifact.missing
        ? `Missing artifact: ${artifactPath}. Refresh or repair the watcher out-of-band before asking again.`
        : 'If fresher data is required, refresh the watcher out-of-band and read the artifact path.',
    ].join('\n');
  }
  if (!artifact || artifact.missing) {
    return [
      `miser: watcher artifact missing for ${commandClass}: ${artifactPath}.`,
      'Do not poll live from Claude.',
      `Refresh or repair the watcher out-of-band, then read ${artifactPath}.`,
    ].join('\n');
  }
  return [
    `miser: ${commandClass} redirected to zero-LLM watcher artifact ${artifactPath}.`,
    '',
    trimSyntheticArtifactText(artifact.text),
  ].join('\n');
}

function buildRedirectResponse(project, panel, policy, classification, state, guardDeps, body) {
  const redirectMode = policy.redirect && policy.redirect.mode ? policy.redirect.mode : DEFAULT_POLICY.redirect.mode;
  if (!['warn', 'enforce'].includes(redirectMode)) return null;
  if (!safeForSyntheticRedirect(body, classification)) return null;

  const artifact = readWatcherArtifact(classification.commandClass, guardDeps);
  const text = redirectInstructionText(redirectMode, classification, artifact);
  const reason = 'zero-llm-redirect';
  const responseBody = buildSyntheticMessageResponse(body, text, {
    model: body && body.model,
  });
  const event = {
    decision: redirectMode === 'warn' ? 'synthesize_warning' : 'synthesize',
    reason,
    mode: redirectMode,
    would_synthesize: true,
    commandClass: classification.commandClass,
    role: classification.role,
    fingerprint: classification.conversationFingerprint,
    terminalShape: classification.terminalShape,
    artifactId: artifact.id,
    artifactPath: artifact.path,
    artifactMissing: artifact.missing === true,
  };
  if (typeof state.recordRedirectDecision === 'function') {
    state.recordRedirectDecision(project, panel, event);
  } else {
    state.recordDecision(project, panel, event);
  }
  if (guardDeps.recordEnforcementEvent) {
    guardDeps.recordEnforcementEvent(project, event, guardDeps.nowFn || (() => new Date()));
  }
  const headers = {
    'content-type': 'application/json',
    'x-miser-redirect': reason,
    'x-miser-redirect-mode': redirectMode,
    'x-miser-redirect-class': classification.commandClass,
    'x-miser-watch-artifact': artifact.path,
  };
  if (redirectMode === 'warn') headers['x-miser-enforcement-warning'] = reason;
  else headers['x-miser-enforcement'] = reason;
  return {
    status: 200,
    headers,
    body: responseBody,
    enforcement: {
      reason,
      mode: redirectMode,
      status: 200,
      warning: redirectMode === 'warn',
      synthetic: true,
      redirect: true,
      commandClass: classification.commandClass,
      artifactPath: artifact.path,
      artifactMissing: artifact.missing === true,
    },
  };
}

function maybeRecordRedirectShadow(project, panel, policy, classification, state, guardDeps) {
  const redirectMode = policy.redirect && policy.redirect.mode ? policy.redirect.mode : DEFAULT_POLICY.redirect.mode;
  if (redirectMode !== 'shadow') return;
  const event = {
    decision: 'would_synthesize',
    reason: 'zero-llm-redirect-shadow',
    mode: redirectMode,
    would_synthesize: classification.redirectable === true,
    commandClass: classification.commandClass,
    role: classification.role,
    fingerprint: classification.conversationFingerprint,
    terminalShape: classification.terminalShape,
  };
  if (typeof state.recordRedirectDecision === 'function') {
    state.recordRedirectDecision(project, panel, event);
  } else {
    state.recordDecision(project, panel, event);
  }
  if (guardDeps.recordEnforcementEvent) {
    guardDeps.recordEnforcementEvent(project, event, guardDeps.nowFn || (() => new Date()));
  }
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

function maybeWarn(project, panel, policy, classification, state, guardDeps, reason, message, model) {
  const mode = policy.mode || 'observe';
  if (!['throttle', 'block'].includes(mode)) return null;
  const event = state.recordDecision(project, panel, {
    decision: 'alert',
    reason,
    mode,
    controlClasses: classification.controlClasses,
    pollClass: classification.pollClass,
    assistantTurns: classification.assistantTurns,
  });
  if (guardDeps.recordEnforcementEvent) {
    guardDeps.recordEnforcementEvent(project, event, guardDeps.nowFn || (() => new Date()));
  }
  return buildWarningResponse(reason, mode, message, model);
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
  const overrideActive = hasOverride(project, policy, requestHeaders);

  const state = guardDeps.enforcementState || defaultState;
  const classification = classifyRequest(project, panel, body, compactHeaders, rawTokens);
  maybeRecordRedirectShadow(project, panel, policy, classification, state, guardDeps);
  const promptText = classification.latestUserPromptText || '';
  classification.revisionLike = textLooksRevisionLike(promptText, policy.orchControl && policy.orchControl.revisionMarkers);
  classification.handoffMarked = isHandoffMarkedTurn(policy, promptText, requestHeaders);
  const protectedPanel = orchControlApplies(panel, policy);
  const countedManagement = protectedPanel && isCountedOrchManagementTurn(policy, classification);
  const assignmentId = protectedPanel ? extractAssignmentId(policy, promptText, requestHeaders) : '';
  const resetAssignment = protectedPanel && (
    overrideActive
    || isApprovalTurn(policy, promptText, requestHeaders)
    || isCompletionTurn(policy, promptText, requestHeaders)
    || classification.handoffMarked
  );
  const resetAllowances = protectedPanel && (
    overrideActive
    || isApprovalTurn(policy, promptText, requestHeaders)
    || isCompletionTurn(policy, promptText, requestHeaders)
  );
  const st = state.recordRequest(project, panel, classification, {
    protectedPanel,
    countedManagement,
    assignmentId,
    resetAssignment,
    resetAllowances,
    duplicateDebounceMs: policy.orchControl.duplicateDebounceMs,
    newConversationAssistantTurnDrop: policy.orchControl.newConversationAssistantTurnDrop,
  });
  const now = guardDeps.nowFn ? guardDeps.nowFn().getTime() : Date.now();
  pruneTimes(st.likelyPollAt, now - 60 * 60 * 1000);
  pruneTimes(st.controlAt, now - 60 * 60 * 1000);
  if (overrideActive) return null;

  const toolMode = policy.toolResults && policy.toolResults.mode;
  if (classification.maxLatestToolResultBytes > (policy.toolResults.maxToolResultBytes || Infinity)
      && toolMode === 'block' && policy.mode === 'block') {
    return maybeBlock(project, panel, policy, classification, state, guardDeps,
      'tool-result-budget',
      'miser: latest tool_result too large; write large output to an artifact and summarize the path',
      null);
  }

  if (classification.pollClass === 'likely' && protectedPanel && countedManagement && classification.pollingCommandLike) {
    const counts = pollCounts(st, now);
    const tenMinLimit = policy.poll.maxLikelyPollsPer10Min || DEFAULT_POLICY.poll.maxLikelyPollsPer10Min;
    const hourLimit = policy.poll.maxLikelyPollsPerHour || DEFAULT_POLICY.poll.maxLikelyPollsPerHour;
    if (counts.tenMin > (policy.poll.maxLikelyPollsPer10Min || DEFAULT_POLICY.poll.maxLikelyPollsPer10Min)
        || counts.hour > (policy.poll.maxLikelyPollsPerHour || DEFAULT_POLICY.poll.maxLikelyPollsPerHour)) {
      return maybeBlock(project, panel, policy, classification, state, guardDeps,
        'poll-budget',
        'miser: poll budget exceeded; use a zero-LLM watcher artifact before polling again',
        policy.poll.minIdlePollSpacingSec || 600);
    }
    if (counts.tenMin >= tenMinLimit || counts.hour >= hourLimit) {
      return maybeWarn(project, panel, policy, classification, state, guardDeps,
        'poll-budget-edge',
        'miser warning: this session is at the poll budget edge; the next similar nonzero-LLM poll/control turn will be blocked. Stop now and use a zero-LLM watcher artifact or explicit approved boundary marker.',
        body && body.model);
    }
  }

  if (protectedPanel && countedManagement) {
    const overRevisions = st.assignmentRevisionCycles > (policy.orchControl.maxRevisionCycles ?? DEFAULT_POLICY.orchControl.maxRevisionCycles);
    if (overRevisions) {
      return maybeBlock(project, panel, policy, classification, state, guardDeps,
        'architect-revision-budget',
        'miser: architect/proposal revision budget exceeded; Brad approval is required before another automatic revision cycle',
        600);
    }

    const selfWorkWarnAt = policy.orchControl.warnSelfWorkTurnsPerAssignment ?? DEFAULT_POLICY.orchControl.warnSelfWorkTurnsPerAssignment;
    const maxSelfWork = policy.orchControl.maxSelfWorkTurnsPerAssignment ?? DEFAULT_POLICY.orchControl.maxSelfWorkTurnsPerAssignment;
    if (classification.selfWorkCommandLike && st.selfWorkTurns > maxSelfWork) {
      if (isDispatchFinalizeTurn(policy, classification, requestHeaders) && !st.dispatchFinalizeUsed) {
        st.dispatchFinalizeUsed = true;
        return null;
      }
      if (policy.orchControl.terminalHandoffAllowed && isTerminalHandoffTurn(classification)
          && st.postCapHandoffTurns < (policy.orchControl.terminalHandoffMaxTurns ?? DEFAULT_POLICY.orchControl.terminalHandoffMaxTurns)) {
        st.postCapHandoffTurns += 1;
        return null;
      }
      if (isInboundBradTurn(classification)
          && st.inboundBradReplyTurns < (policy.orchControl.inboundBradReplyMaxTurns ?? DEFAULT_POLICY.orchControl.inboundBradReplyMaxTurns)) {
        st.inboundBradReplyTurns += 1;
        return null;
      }
      return maybeBlock(project, panel, policy, classification, state, guardDeps,
        'orch-self-work-budget',
        'miser: ORCH self-work budget exceeded; dispatch to a builder/auditor, write a compact handoff, or get explicit Brad approval before more repo/CI/file/plugin work',
        600);
    }
    if (classification.selfWorkCommandLike && st.selfWorkTurns === selfWorkWarnAt && !st.selfWorkWarningSent) {
      st.selfWorkWarningSent = true;
      return maybeWarn(project, panel, policy, classification, state, guardDeps,
        'orch-self-work-budget-edge',
        'miser warning: this ORCH has used its self-work allowance; the next repo/CI/file/plugin work continuation will be blocked. Dispatch to a builder/auditor or finish with a compact handoff.',
        body && body.model);
    }

    const warnAt = policy.orchControl.warnManagementTurnsPerAssignment ?? DEFAULT_POLICY.orchControl.warnManagementTurnsPerAssignment;
    const maxTurns = policy.orchControl.maxManagementTurnsPerAssignment ?? DEFAULT_POLICY.orchControl.maxManagementTurnsPerAssignment;
    if (st.assignmentManagementTurns > maxTurns) {
      if (isDispatchFinalizeTurn(policy, classification, requestHeaders) && !st.dispatchFinalizeUsed) {
        st.dispatchFinalizeUsed = true;
        return null;
      }
      if (policy.orchControl.terminalHandoffAllowed && isTerminalHandoffTurn(classification)
          && st.postCapHandoffTurns < (policy.orchControl.terminalHandoffMaxTurns ?? DEFAULT_POLICY.orchControl.terminalHandoffMaxTurns)) {
        st.postCapHandoffTurns += 1;
        return null;
      }
      if (isInboundBradTurn(classification)
          && st.inboundBradReplyTurns < (policy.orchControl.inboundBradReplyMaxTurns ?? DEFAULT_POLICY.orchControl.inboundBradReplyMaxTurns)) {
        st.inboundBradReplyTurns += 1;
        return null;
      }
      st.assignmentBlocked = true;
      return maybeBlock(project, panel, policy, classification, state, guardDeps,
        'orch-assignment-budget',
        'miser: ORCH assignment management budget exceeded; Brad approval, durable completion, handoff, or a one-shot final dispatch marker is required before continuing',
        600);
    }
    if (st.assignmentManagementTurns === warnAt && !st.assignmentWarningSent) {
      st.assignmentWarningSent = true;
      return maybeWarn(project, panel, policy, classification, state, guardDeps,
        'orch-assignment-budget-edge',
        'miser warning: this assignment is at the ORCH management budget edge; finish with a durable result, approved continuation, handoff, or one-shot final dispatch instead of spending more management turns.',
        body && body.model);
    }
  }

  if (classification.isControl && protectedPanel && countedManagement) {
    const overHour = st.controlAt.length > (policy.orchControl.maxControlTurnsPerHour ?? DEFAULT_POLICY.orchControl.maxControlTurnsPerHour);
    const overSession = st.controlTurns > (policy.orchControl.maxControlTurnsPerSession ?? DEFAULT_POLICY.orchControl.maxControlTurnsPerSession);
    const freshOver = st.freshInput > (policy.session.maxFreshInputM || DEFAULT_POLICY.session.maxFreshInputM) * 1_000_000;
    const weightedOver = st.weighted > (policy.session.maxSummedContextWeightedM || DEFAULT_POLICY.session.maxSummedContextWeightedM) * 1_000_000;
    const assistantFreshOver = classification.assistantTurns > (policy.session.maxAssistantTurnsObserve || DEFAULT_POLICY.session.maxAssistantTurnsObserve)
      && (freshOver || weightedOver);
    if (overHour || overSession || assistantFreshOver) {
      if (policy.orchControl.terminalHandoffAllowed && isTerminalHandoffTurn(classification)
          && st.postCapHandoffTurns < (policy.orchControl.terminalHandoffMaxTurns ?? DEFAULT_POLICY.orchControl.terminalHandoffMaxTurns)) {
        st.postCapHandoffTurns += 1;
        return null;
      }
      if (isInboundBradTurn(classification)
          && st.inboundBradReplyTurns < (policy.orchControl.inboundBradReplyMaxTurns ?? DEFAULT_POLICY.orchControl.inboundBradReplyMaxTurns)) {
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
      && protectedPanel
      && countedManagement) {
    return maybeBlock(project, panel, policy, classification, state, guardDeps,
      'poll-ratio-budget',
      'miser: poll-heavy session exceeded allowed ratio; move monitoring to an artifact',
      600);
  }

  const redirect = buildRedirectResponse(project, panel, policy, classification, state, guardDeps, body);
  if (redirect) return redirect;

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
  conversationFingerprint,
  buildSyntheticMessageResponse,
  buildSyntheticSseResponse,
  createEnforcementState,
  checkEnforcement,
  recordEnforcementUsage,
  __test: {
    textFromContent,
    latestToolResultStats,
    weightedFromUsage,
    orchControlApplies,
    isCountedOrchManagementTurn,
    extractAssignmentId,
    safeForSyntheticRedirect,
    readWatcherArtifact,
  },
};
