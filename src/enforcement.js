'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { isValidProjectName } = require('./routing.js');
const { readonlyAction } = require('./orch-readonly-action.js');
const { validateAdvisorJson } = require('./orch-intent-classifier.js');

// Private capability: request headers, prompt text and tool output cannot set it.
const ADVISOR_ALLOWANCE = Symbol('advisor-verified-readonly');

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
const CONTROL_PLANE_STATUS = 200;
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
    bootSetupMarkers: Object.freeze(['MISER_BOOT_SETUP', 'ORCH_BOOT', 'PANEL_BOOT']),
    bootSetupMaxAssistantTurns: 1,
    bootSetupMaxMessages: 3,
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
  if (latestUser) parts.push(stripClaudeCodeInjectedContext(textFromContent(latestUser.content)));
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

const INJECTED_CONTEXT_WRAPPERS = new Set(['system-reminder', 'local-command-caveat']);
const ROLE_CONTEXT_WRAPPERS = new Set([
  ...INJECTED_CONTEXT_WRAPPERS, 'task-notification', 'blockquote', 'pre', 'code',
]);

function topLevelContextText(text, wrappers) {
  const input = String(text || '');
  const chunks = [];
  const stack = [];
  const tags = /<\s*(\/?)\s*([a-z][a-z0-9:-]*)\b/gi;
  let cursor = 0;
  let tag;
  while ((tag = tags.exec(input))) {
    const name = tag[2].toLowerCase();
    if (!wrappers.has(name)) continue;
    // Find the tag boundary without treating > inside an attribute as a close.
    let end = tags.lastIndex;
    let quote = '';
    for (; end < input.length; end++) {
      const char = input[end];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>' || char === '<') break;
    }
    const outside = stack.length === 0;
    if (outside) chunks.push(input.slice(cursor, tag.index));
    // An incomplete opening/tag is not a source of trusted trailing text.
    if (input[end] !== '>') { cursor = input.length; break; }
    if (tag[1]) {
      // Crossed/unbalanced wrappers stay suppressed until properly closed.
      if (stack[stack.length - 1] === name) stack.pop();
    } else if (!input.slice(tag.index, end).trimEnd().endsWith('/')) {
      stack.push(name);
    }
    // Never join two fragments across a wrapper into a new declaration.
    if (outside || stack.length === 0) chunks.push('\n');
    cursor = end + 1;
    tags.lastIndex = cursor;
  }
  if (stack.length === 0) chunks.push(input.slice(cursor));
  return chunks.join('');
}

function stripClaudeCodeInjectedContext(text, trim = true) {
  const stripped = topLevelContextText(text, INJECTED_CONTEXT_WRAPPERS);
  return trim ? stripped.trim() : stripped;
}

function latestUserPromptText(body) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const latest = latestUserMessage(messages);
  return latest ? stripClaudeCodeInjectedContext(promptTextFromContent(latest.content)) : '';
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
  return stripClaudeCodeInjectedContext(parts.filter(Boolean).join('\n')).slice(0, maxBytes);
}

function firstUserPromptText(body, maxBytes = 4096) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const first = firstUserMessage(messages);
  if (!first) return '';
  const prompt = promptTextFromContent(first.content) || textFromContent(first.content);
  return stripClaudeCodeInjectedContext(prompt).slice(0, maxBytes);
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

function terminalMessageShapes(body) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const latestIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'user') return i;
    }
    return -1;
  })();
  if (latestIndex < 0) return [{ kind: 'none', text: '', toolUse: null }];
  const latest = messages[latestIndex];
  const blocks = Array.isArray(latest.content) ? latest.content : [];
  const toolResults = blocks.filter(block => block && block.type === 'tool_result');
  if (!toolResults.length) {
    const text = stripClaudeCodeInjectedContext(promptTextFromContent(latest.content) || textFromContent(latest.content));
    const lower = text.toLowerCase();
    if (lower.includes('<task-notification>')
        || lower.includes('stop-hook')
        || lower.includes('stop_hook')
        || lower.includes('monitor callback')) {
      return [{ kind: 'notification', text, toolUse: null }];
    }
    return [{ kind: 'real_user_text', text, toolUse: null }];
  }

  return toolResults.map(toolResult => {
    const id = toolResult.tool_use_id || toolResult.id || '';
    for (let i = latestIndex - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
      const match = msg.content.find(block => block && block.type === 'tool_use' && (!id || block.id === id));
      if (match) return { kind: 'tool_result', text: textFromContent(toolResult.content), toolUse: match };
    }
    return { kind: 'tool_result', text: textFromContent(toolResult.content), toolUse: null };
  });
}

function terminalMessageShape(body) {
  return terminalMessageShapes(body)[0];
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

const NON_ORCH_ROLE = '(?:architect|ux|researcher|builder|evaluator|reviewer|auditor|audit|implementation[-_\\s]+lane)';
const NON_ORCH_ROLE_LABEL = new RegExp(`(?:^|[^a-z0-9])${NON_ORCH_ROLE}(?=$|[^a-z0-9])`, 'i');
const NON_ORCH_ROLE_DECLARATION = new RegExp(
  `^\\s*(?:you are\\s+|role\\s*:\\s*)(?:(?:a|an|the|now|bounded|temporary|general|senior|lead|claude|codex|grok|architecture)\\s+)*${NON_ORCH_ROLE}(?=$|[^a-z0-9])`,
  'i',
);

function textHasExplicitNonOrchRole(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower) return false;
  return /\bnon[-_\s]?orch\b/.test(lower)
    || /\bnot\s+(?:an?\s+)?orch\b/.test(lower)
    || /\bdo\s+not\s+use\s+orch\s+behavior\b/.test(lower)
    || /\bdo\s+not\s+coordinate\s+other\s+panels\b/.test(lower);
}

function unquotedRoleLines(text) {
  const lines = [];
  let fence = '';
  let quoted = false;
  for (const line of topLevelContextText(text, ROLE_CONTEXT_WRAPPERS).split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = '';
      continue;
    }
    if (/^\s*>/.test(line)) { quoted = true; continue; }
    if (!line.trim()) { quoted = false; continue; }
    // Include Markdown's lazy blockquote continuation and indented code.
    if (quoted || /^(?: {4}|\t)/.test(line)) continue;
    if (marker) { fence = marker[1]; continue; }
    lines.push(line.trim());
  }
  return lines;
}

function declaredRole(line) {
  const label = line.match(/^role_label\s*:\s*(\S+)/i);
  if (label) {
    if (NON_ORCH_ROLE_LABEL.test(label[1]) || textHasExplicitNonOrchRole(label[1])) return 'worker';
    if (/(?:^|[^a-z0-9])(?:orch|orchestrator)(?=$|[^a-z0-9])/i.test(label[1])) return 'ORCH';
  }
  if (NON_ORCH_ROLE_DECLARATION.test(line)) return 'worker';
  if (/^(?:you are\b|role\s*:)/i.test(line)) {
    if (textHasExplicitNonOrchRole(line)) return 'worker';
    if (/\b(?:orch|orchestrator)\b/i.test(line)) return 'ORCH';
  }
  if (/^(?:non[-_\s]?orch\b|not\s+(?:an?\s+)?orch\b|do\s+not\s+(?:use\s+orch\s+behavior|coordinate\s+other\s+panels)\b)/i.test(line)) return 'worker';
  return '';
}

function roleAssignmentText(content) {
  if (typeof content === 'string') return content;
  // A tool continuation is never the initial role assignment, even if it
  // carries adjacent text blocks. Only protocol text blocks are role sources.
  if (!Array.isArray(content) || content.some(block => block && block.type === 'tool_result')) return '';
  return content.filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n');
}

function deriveRole(body, project, panel) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const sources = [roleAssignmentText(body && body.system)];
  for (const message of messages) {
    if (!message || message.role !== 'system') break;
    sources.push(roleAssignmentText(message.content));
  }
  const firstUser = firstUserMessage(messages);
  if (firstUser) sources.push(roleAssignmentText(firstUser.content));
  // Authority is limited to the initial system/first-user assignment. The
  // latest declaration within that assignment wins; later dialogue cannot
  // reassign identity, nor can notifications, tool results or task markers.
  const lines = sources.flatMap(unquotedRoleLines);
  let explicitRole = '';
  for (const line of lines) explicitRole = declaredRole(line) || explicitRole;
  if (explicitRole) return explicitRole;
  if (NON_ORCH_ROLE_LABEL.test(String(panel || ''))) return 'worker';
  const panelLower = String(panel || '').toLowerCase();
  if (['orch', 'sprints'].includes(panelLower)) return 'ORCH';
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
  const latestText = stripClaudeCodeInjectedContext(latestUserText(body));
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
    explicitNonOrchRole: role === 'worker',
    firstUserPromptText: firstUserPromptText(body),
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
    controlErrors: 0,
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
        lastConversationFingerprint: null,
        lastTerminalShape: null,
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
    if (st.lastConversationFingerprint
        && classification.conversationFingerprint
        && st.lastConversationFingerprint !== classification.conversationFingerprint
        && st.lastTerminalShape !== 'tool_result'
        && (st.lastAssistantTurns > 0 || st.lastMessageCount > 1)
        && classification.assistantTurns <= 1
        && classification.messageCount > 0
        && classification.messageCount <= 3) {
      return true;
    }
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
    st.lastConversationFingerprint = classification.conversationFingerprint || st.lastConversationFingerprint;
    st.lastTerminalShape = classification.terminalShape || st.lastTerminalShape;
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
    const selfWorkTurn = classification.selfWorkCommandLike || classification.commandClass === 'SELF_WORK';
    if (opts.protectedPanel && opts.countedManagement && selfWorkTurn && !duplicateCountedTurn) {
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
    }
    if (event.control_error === true) {
      redirectStats.controlErrors += 1;
    }
    if (event.would_synthesize === true || event.control_error === true) {
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
        controlErrors: redirectStats.controlErrors,
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
  if (classification.selfWorkCommandLike || classification.commandClass === 'SELF_WORK') return true;
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

function isBootSetupMarkedTurn(policy, text) {
  return hasControlLineMarker(text, (policy.orchControl || {}).bootSetupMarkers);
}

function textLooksBootSetupLike(policy, classification) {
  const text = classification.latestUserPromptText || '';
  if (isBootSetupMarkedTurn(policy, text)) return true;
  const lower = text.toLowerCase();
  if (!lower) return false;
  const bootOrHandoff = /\b(boot|handoff|compact-state|rotation|successor|predecessor)\b/.test(lower)
    || /read\s+\S*(?:handoff|boot|compact)/.test(lower);
  if (!bootOrHandoff) return false;
  const setupOrAck = lower.includes('reply in one short sentence')
    || lower.includes('then wait')
    || lower.includes('waiting for operator')
    || lower.includes('coordinate only')
    || lower.includes('do not run tools')
    || lower.includes('do not run local')
    || /\b(read|load|resume|start|online)\b/.test(lower);
  const panelIdentity = /\b(you are|orch|orchestrator|architect|builder|auditor|canary|panel)\b/.test(lower);
  return setupOrAck && panelIdentity;
}

function isBootSetupTurn(policy, classification) {
  const orch = policy.orchControl || {};
  const maxAssistantTurns = orch.bootSetupMaxAssistantTurns ?? DEFAULT_POLICY.orchControl.bootSetupMaxAssistantTurns;
  const maxMessages = orch.bootSetupMaxMessages ?? DEFAULT_POLICY.orchControl.bootSetupMaxMessages;
  if (!['real_user_text', 'notification'].includes(classification.terminalShape)) return false;
  if (classification.assistantTurns > maxAssistantTurns) return false;
  if (classification.messageCount > maxMessages) return false;
  if (classification.pollingCommandLike || classification.selfWorkCommandLike || classification.commandClass === 'SELF_WORK') return false;
  return textLooksBootSetupLike(policy, classification);
}

const SAFE_BOOT_SETUP_READ_BASENAMES = new Set([
  'spawn-lane.sh',
  'boot-inject.sh',
  'make-lane-prompt.js',
  'orch-dispatch.sh',
  'orch-followup.sh',
  'CLAUDE.md',
  'README.md',
]);

function safeBootSetupReadPath(filePath) {
  const s = String(filePath || '');
  if (!s || s.includes('\0')) return false;
  const lower = s.toLowerCase();
  if (/(?:^|\/)\.(?:ssh|termdeck|config|gnupg|aws|claude)(?:\/|$)/.test(lower)) return false;
  return SAFE_BOOT_SETUP_READ_BASENAMES.has(path.basename(s));
}

function firstPromptLooksManualBootSetup(classification) {
  const lower = String(classification.firstUserPromptText || '').toLowerCase();
  if (!lower) return false;
  if (!/\b(you are|role:|temporary|coordinator|orchestrator|orch)\b/.test(lower)) return false;
  if (!/\borch\b|orchestrator/.test(lower)) return false;
  const setup = /\b(boot|setup|manual|spawn|launcher|launch|first response|first response format|read only the minimal|minimal launcher)\b/.test(lower);
  const bounded = /\b(coordinate|not the builder|do not edit|do not run inline|do not inspect secrets|do not poll|read only the minimal|propose|wait)\b/.test(lower);
  return setup && bounded;
}

function isFreshBootSetupRead(policy, classification, body) {
  const orch = policy.orchControl || {};
  const maxAssistantTurns = Math.max(2, orch.bootSetupMaxAssistantTurns ?? DEFAULT_POLICY.orchControl.bootSetupMaxAssistantTurns);
  const maxMessages = Math.max(4, orch.bootSetupMaxMessages ?? DEFAULT_POLICY.orchControl.bootSetupMaxMessages);
  if (classification.assistantTurns > maxAssistantTurns) return false;
  if (classification.messageCount > maxMessages) return false;
  const shape = terminalMessageShape(body);
  const tool = extractToolCommand(shape.toolUse);
  if (shape.kind !== 'tool_result') return false;
  const marked = isBootSetupMarkedTurn(policy, classification.firstUserPromptText)
    || isBootSetupMarkedTurn(policy, classification.latestUserPromptText);
  if (String(tool.name || '').toLowerCase() === 'read') {
    return safeBootSetupReadPath(tool.filePath) && (marked || firstPromptLooksManualBootSetup(classification));
  }
  if (!marked || tool.name !== 'Bash') return false;
  const messages = body.messages || [];
  const results = messages.at(-1)?.content;
  const uses = messages.at(-2)?.content;
  if (!Array.isArray(results) || results.length !== 1 || !Array.isArray(uses)
      || uses.filter(b => b?.type === 'tool_use').length !== 1) return false;
  const boundedHead = tool.command.match(/^head -n ([1-9][0-9]{0,2}) ([A-Za-z0-9_~./-]+)$/);
  return !!(boundedHead && Number(boundedHead[1]) <= 200 && safeBootSetupReadPath(boundedHead[2]));
}

function hardSafetyReason(classification, body = null) {
  // Inspect the entire result batch before any role, boot or advisor exemption.
  const shapes = body ? terminalMessageShapes(body) : [null];
  for (const shape of shapes) {
    const tool = shape ? extractToolCommand(shape.toolUse) : { name: '', command: '', filePath: '' };
    const prompt = shape ? promptCommandCandidate(shape) : (classification.latestUserPromptText || '');
    const commandish = normalizedText(tool.command || prompt).toLowerCase();
    const filePath = String(tool.filePath || '').toLowerCase();
    if (filePath && /(?:^|\/)\.(?:ssh|termdeck)(?:\/|$)|(?:^|\/)\.claude\.json$|(?:^|\/)\.gitconfig$/.test(filePath)) {
      return 'sensitive-file-read';
    }
    if (/(^|\s)(env|printenv|export|set)(\s|$)/.test(commandish)
        && /(secret|token|key|password|credential|anthropic|openai|termdeck)/.test(commandish)) return 'sensitive-env';
    if (/\b(?:cat|head|tail|sed|nl|rg|grep|find|ls)\b[\s\S]*(?:~\/\.ssh|\/home\/[^/\s]+\/\.ssh|~\/\.termdeck|\/home\/[^/\s]+\/\.termdeck|~\/\.claude\.json|\/\.claude\.json|~\/\.gitconfig|\/\.gitconfig)/.test(commandish)) return 'sensitive-file-read';
    if (/\brg\b[\s\S]*(?:secret|token|password|credential)[\s\S]*\/home\/nacho\b/.test(commandish)) return 'broad-secret-search';
    if (/\bgit\s+branch\b[\s\S]*(?:-d|-D|--delete)\b/.test(commandish)) return 'destructive-git-branch';
    if (/\bgit\s+(?:commit|push|merge)\b/.test(commandish)) return 'git-write-operation';
    if (/\bgh\s+pr\s+(?:create|merge)\b/.test(commandish)) return 'pr-write-operation';
    if (/\bsystemctl\b[\s\S]*(?:restart|stop|start|reload)\b/.test(commandish)) return 'service-mutation';
    if (/\bcodex\s+exec\b/.test(commandish)) return 'direct-codex-exec';
  }
  return '';
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

function consumeExplicitOperatorBoundary(policy, classification, headers, st) {
  if (isDispatchFinalizeTurn(policy, classification, headers) && !st.dispatchFinalizeUsed) {
    st.dispatchFinalizeUsed = true;
    return true;
  }
  const text = classification.latestUserPromptText || '';
  if (isApprovalTurn(policy, text, headers) || isCompletionTurn(policy, text, headers)) {
    return true;
  }
  if (classification.pollingCommandLike) return false;
  return false;
}

function consumePostCapBoundaryAllowance(policy, classification, headers, st) {
  if (consumeExplicitOperatorBoundary(policy, classification, headers, st)) return true;
  if (policy.orchControl.terminalHandoffAllowed && isTerminalHandoffTurn(classification)
      && st.postCapHandoffTurns < (policy.orchControl.terminalHandoffMaxTurns ?? DEFAULT_POLICY.orchControl.terminalHandoffMaxTurns)) {
    st.postCapHandoffTurns += 1;
    return true;
  }
  if (isInboundBradTurn(classification)
      && st.inboundBradReplyTurns < (policy.orchControl.inboundBradReplyMaxTurns ?? DEFAULT_POLICY.orchControl.inboundBradReplyMaxTurns)) {
    st.inboundBradReplyTurns += 1;
    return true;
  }
  return false;
}

function responseStatusFor(mode, reason) {
  return CONTROL_PLANE_STATUS;
}

function buildEnforcementResponse(reason, mode, message, retryAfter = null) {
  const status = responseStatusFor(mode, reason);
  const headers = {
    'content-type': 'application/json',
    'x-miser-control-plane': reason,
    'x-miser-enforcement': reason,
    'x-miser-enforcement-mode': mode,
  };
  if (status === 429 && retryAfter) headers['retry-after'] = String(retryAfter);
  if (status !== 429) {
    return buildControlPlaneSyntheticResponse({
      reason,
      mode,
      message,
      headers,
      operatorAction: 'operator_boundary_or_out_of_band_control_required',
      panelAction: 'Do not retry this request from this panel; stop the control-loop and wait for operator/control-plane input.',
      enforcement: { reason, mode, status, control: true },
    });
  }
  return {
    status: 429,
    headers,
    body: {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message,
      },
    },
    enforcement: { reason, mode, status: 429 },
  };
}

function buildWarningResponse(reason, mode, message) {
  const panelAction = 'Do not retry this request from this panel; stop the control-loop and wait for an operator/out-of-band dispatch.';
  return buildControlPlaneSyntheticResponse({
    reason,
    mode,
    message: `${message}; ${panelAction}`,
    headers: {
      'content-type': 'application/json',
      'x-miser-control-plane': reason,
      'x-miser-enforcement': reason,
      'x-miser-enforcement-warning': reason,
      'x-miser-enforcement-mode': mode,
    },
    operatorAction: 'operator_boundary_or_out_of_band_control_required',
    panelAction,
    enforcement: { reason, mode, status: CONTROL_PLANE_STATUS, warning: false, control: true },
  });
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

function buildControlPlaneText(fields) {
  const lines = [
    `[MISER-CONTROL] error.type=miser_control_plane_error; reason=${fields.reason}; mode=${fields.mode}; retryable=false.`,
    `message: ${fields.message}`,
  ];
  if (fields.commandClass) lines.push(`command_class: ${fields.commandClass}`);
  if (fields.artifact) {
    lines.push(`artifact: ${fields.artifact.path} (${fields.artifact.state || 'unknown'})`);
  }
  if (fields.operatorAction) lines.push(`operator_action: ${fields.operatorAction}`);
  if (fields.operatorMessage) lines.push(`operator_message: ${fields.operatorMessage}`);
  if (fields.panelAction) lines.push(`panel_action: ${fields.panelAction}`);
  return lines.join('\n');
}

function buildControlPlaneSyntheticResponse(opts) {
  const headers = {
    'content-type': 'application/json',
    ...opts.headers,
  };
  const body = buildSyntheticMessageResponse(opts.originalBody || {}, buildControlPlaneText(opts), opts.messageOpts || {});
  return {
    status: CONTROL_PLANE_STATUS,
    headers,
    body,
    enforcement: {
      ...(opts.enforcement || {}),
      status: CONTROL_PLANE_STATUS,
      control: true,
      synthetic: true,
    },
  };
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

function watchDirCompactPath(watchConfig, id) {
  const watchDir = watchConfig && typeof watchConfig.watchDir === 'string' && watchConfig.watchDir.trim()
    ? expandHome(watchConfig.watchDir)
    : path.join(os.homedir(), '.miser', 'watch');
  return path.join(watchDir, `${id}.md`);
}

function artifactJsonPath(compactPath) {
  return compactPath.endsWith('.md') ? `${compactPath.slice(0, -3)}.json` : `${compactPath}.json`;
}

function artifactState(artifact, nowMs = Date.now()) {
  if (!artifact || !artifact.generated_at || !Number.isFinite(artifact.ttl_s)) return 'missing';
  const generated = Date.parse(artifact.generated_at);
  if (!Number.isFinite(generated)) return 'missing';
  return Math.max(0, nowMs - generated) <= artifact.ttl_s * 1000 ? 'fresh' : 'stale';
}

function readWatcherArtifact(commandClass, guardDeps = {}) {
  const watcher = guardDeps.watcher || null;
  for (const id of artifactCandidates(commandClass)) {
    const compactPath = watcher
      ? watcherCompactPath(watcher, id)
      : watchDirCompactPath(guardDeps.watchConfig || {}, id);
    let artifact = null;
    if (watcher && typeof watcher.readArtifact === 'function') {
      try { artifact = watcher.readArtifact(id); } catch (_) {}
    }
    if (!artifact) {
      try { artifact = JSON.parse(fs.readFileSync(artifactJsonPath(compactPath), 'utf8')); } catch (_) {}
    }
    const state = artifactState(artifact, guardDeps.nowFn ? guardDeps.nowFn().getTime() : Date.now());
    try {
      const text = fs.readFileSync(compactPath, 'utf8');
      if (String(text || '').trim()) {
        return {
          id,
          path: compactPath,
          text,
          missing: false,
          stale: state === 'stale',
          state: state === 'missing' ? 'unknown' : state,
          artifact,
        };
      }
    } catch (_) {}
  }
  const missingId = artifactCandidates(commandClass)[0];
  return {
    id: missingId,
    path: watcher
      ? watcherCompactPath(watcher, missingId)
      : watchDirCompactPath(guardDeps.watchConfig || {}, missingId),
    text: '',
    missing: true,
    stale: false,
    state: 'missing',
    artifact: null,
  };
}

function trimSyntheticArtifactText(text, maxBytes = 16 * 1024) {
  let out = String(text || '').trim();
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, Math.max(0, out.length - 1));
  return out;
}

function redirectControlMessage(mode, classification, artifact) {
  const commandClass = classification.commandClass || 'UNKNOWN';
  const artifactPath = artifact && artifact.path ? artifact.path : fallbackArtifactPath((artifactCandidates(commandClass)[0]));
  const prefix = `miser control-plane redirect blocked ${commandClass}`;
  if (!artifact || artifact.missing) {
    return `${prefix}: watcher artifact missing at ${artifactPath}; do not retry from this panel`;
  }
  if (artifact.stale || artifact.state === 'stale') {
    return `${prefix}: watcher artifact stale at ${artifactPath}; do not retry from this panel`;
  }
  return `${prefix}: read watcher artifact outside the model transcript at ${artifactPath}; do not retry from this panel`;
}

function redirectOperatorMessage(classification, artifact) {
  const commandClass = classification.commandClass || 'UNKNOWN';
  if (!artifact || artifact.missing || artifact.stale || artifact.state === 'stale') {
    return `Refresh or repair the ${artifact && artifact.id ? artifact.id : commandClass} watcher artifact out-of-band, then inject a compact result or next assignment.`;
  }
  return `Read ${artifact.path} out-of-band, then inject a compact result or next assignment; the model panel should not run ${commandClass}.`;
}

function redirectPanelAction(classification) {
  const commandClass = classification.commandClass || 'UNKNOWN';
  return `Stop. Do not retry or run ${commandClass} from this panel; wait for operator/control-plane input.`;
}

function buildRedirectResponse(project, panel, policy, classification, state, guardDeps, body) {
  const redirectMode = policy.redirect && policy.redirect.mode ? policy.redirect.mode : DEFAULT_POLICY.redirect.mode;
  if (!['warn', 'enforce'].includes(redirectMode)) return null;
  if (!safeForSyntheticRedirect(body, classification)) return null;

  const artifact = readWatcherArtifact(classification.commandClass, guardDeps);
  const reason = 'zero-llm-redirect';
  const artifactStateValue = artifact.state || (artifact.missing ? 'missing' : 'unknown');
  const message = redirectControlMessage(redirectMode, classification, artifact);
  const operatorMessage = redirectOperatorMessage(classification, artifact);
  const panelAction = redirectPanelAction(classification);
  const event = {
    decision: 'control_error',
    reason,
    mode: redirectMode,
    would_synthesize: false,
    control_error: true,
    commandClass: classification.commandClass,
    role: classification.role,
    fingerprint: classification.conversationFingerprint,
    terminalShape: classification.terminalShape,
    artifactId: artifact.id,
    artifactPath: artifact.path,
    artifactMissing: artifact.missing === true,
    artifactState: artifactStateValue,
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
    'x-miser-control-plane': reason,
    'x-miser-redirect': reason,
    'x-miser-redirect-mode': redirectMode,
    'x-miser-redirect-class': classification.commandClass,
    'x-miser-watch-artifact': artifact.path,
    'x-miser-watch-artifact-state': artifactStateValue,
    'x-miser-enforcement': reason,
    'x-miser-enforcement-reason': reason,
  };
  return buildControlPlaneSyntheticResponse({
    reason,
    mode: redirectMode,
    message,
    headers,
    originalBody: body,
    commandClass: classification.commandClass,
    artifact: {
      id: artifact.id,
      path: artifact.path,
      state: artifactStateValue,
      missing: artifact.missing === true,
      stale: artifact.stale === true,
    },
    operatorAction: artifact.missing || artifact.stale
      ? 'refresh_or_repair_watcher_out_of_band'
      : 'read_watcher_artifact_out_of_band',
    operatorMessage,
    panelAction,
    enforcement: {
      reason,
      mode: redirectMode,
      status: CONTROL_PLANE_STATUS,
      warning: false,
      synthetic: true,
      redirect: true,
      commandClass: classification.commandClass,
      artifactPath: artifact.path,
      artifactMissing: artifact.missing === true,
      artifactState: artifactStateValue,
    },
  });
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
  const promptText = classification.latestUserPromptText || '';
  classification.revisionLike = textLooksRevisionLike(promptText, policy.orchControl && policy.orchControl.revisionMarkers);
  classification.handoffMarked = isHandoffMarkedTurn(policy, promptText, requestHeaders);
  const protectedPanel = orchControlApplies(panel, policy) && classification.explicitNonOrchRole !== true;
  const redirectEligible = classification.explicitNonOrchRole !== true && classification.role === 'ORCH';
  // Detect hard-safety findings for every role; only ORCH can be blocked.
  const hardReason = hardSafetyReason(classification, body);
  if (hardReason && classification.role === 'ORCH' && !overrideActive) {
    const hardBlock = maybeBlock(project, panel, policy, classification, state, guardDeps,
      'orch-hard-safety',
      `miser: deterministic ORCH hard safety block (${hardReason}); use an approved out-of-band lane or operator action`,
      600);
    if (hardBlock) return hardBlock;
  } else if (hardReason) {
    // Reuse the observation decision so stats retain findings without blocks or alerts.
    const event = state.recordDecision(project, panel, {
      decision: 'would_block',
      reason: 'orch-hard-safety',
      hardSafetyReason: hardReason,
      role: classification.role,
      mode: policy.mode || 'observe',
      overrideActive,
      controlClasses: classification.controlClasses,
      pollClass: classification.pollClass,
      assistantTurns: classification.assistantTurns,
    });
    if (guardDeps.recordEnforcementEvent) {
      guardDeps.recordEnforcementEvent(project, event, guardDeps.nowFn || (() => new Date()));
    }
  }
  const advisorAllowance = guardDeps[ADVISOR_ALLOWANCE];
  if (advisorAllowance && advisorCandidate(policy, classification, body, requestHeaders)) {
    classification.commandClass = 'EXTERNAL_VERIFICATION';
    classification.redirectable = false;
    classification.selfWorkCommandLike = false;
    classification.managementLike = false;
    classification.pollingCommandLike = false;
    classification.isControl = false;
    classification.controlClasses = [];
    classification.advisorExempt = true;
    const event = { decision: 'advisor_allow', reason: 'bounded-external-verification',
      commandClass: classification.commandClass, role: classification.role,
      target: advisorAllowance.target, confidence: advisorAllowance.confidence };
    state.recordDecision(project, panel, event);
    if (guardDeps.recordEnforcementEvent) guardDeps.recordEnforcementEvent(project, event, guardDeps.nowFn);
  }
  if (redirectEligible) maybeRecordRedirectShadow(project, panel, policy, classification, state, guardDeps);
  classification.bootSetupTurn = protectedPanel && isBootSetupTurn(policy, classification);
  if (protectedPanel && !classification.bootSetupTurn && isFreshBootSetupRead(policy, classification, body)) {
    classification.bootSetupTurn = true;
    classification.selfWorkCommandLike = false;
    classification.managementLike = false;
    classification.pollingCommandLike = false;
    classification.isControl = false;
    classification.controlClasses = [];
  }
  const countedManagement = protectedPanel && !classification.bootSetupTurn && !classification.advisorExempt && isCountedOrchManagementTurn(policy, classification);
  const assignmentId = protectedPanel ? extractAssignmentId(policy, promptText, requestHeaders) : '';
  const resetAssignment = protectedPanel && (
    overrideActive
    || isApprovalTurn(policy, promptText, requestHeaders)
    || isCompletionTurn(policy, promptText, requestHeaders)
    || classification.handoffMarked
    || classification.bootSetupTurn
  );
  const resetAllowances = protectedPanel && (
    overrideActive
    || isApprovalTurn(policy, promptText, requestHeaders)
    || isCompletionTurn(policy, promptText, requestHeaders)
    || classification.bootSetupTurn
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

  const redirect = redirectEligible ? buildRedirectResponse(project, panel, policy, classification, state, guardDeps, body) : null;
  if (redirect) return redirect;

  if (overrideActive) return null;

  const boundaryAllowanceConsumed = protectedPanel && countedManagement
    && consumeExplicitOperatorBoundary(policy, classification, requestHeaders, st);
  if (boundaryAllowanceConsumed) return null;

  const toolMode = policy.toolResults && policy.toolResults.mode;
  if (classification.maxLatestToolResultBytes > (policy.toolResults.maxToolResultBytes || Infinity)
      && toolMode === 'block' && policy.mode === 'block') {
    return maybeBlock(project, panel, policy, classification, state, guardDeps,
      'tool-result-budget',
      'miser: latest tool_result too large; write large output to an artifact and summarize the path',
      null);
  }

  // null allows upstream processing. General tool-result limits still apply,
  // but known worker roles never enter ORCH poll/assignment enforcement.
  if (classification.explicitNonOrchRole) return null;

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
    const selfWorkTurn = classification.selfWorkCommandLike || classification.commandClass === 'SELF_WORK';
    if (selfWorkTurn && st.selfWorkTurns > maxSelfWork) {
      if (consumePostCapBoundaryAllowance(policy, classification, requestHeaders, st)) return null;
      return maybeBlock(project, panel, policy, classification, state, guardDeps,
        'orch-self-work-budget',
        'miser: ORCH self-work budget exceeded; dispatch to a builder/auditor, write a compact handoff, or get explicit Brad approval before more repo/CI/file/plugin work',
        600);
    }
    if (selfWorkTurn && st.selfWorkTurns === selfWorkWarnAt && !st.selfWorkWarningSent) {
      st.selfWorkWarningSent = true;
      return maybeWarn(project, panel, policy, classification, state, guardDeps,
        'orch-self-work-budget-edge',
        'miser warning: this ORCH has used its self-work allowance; the next repo/CI/file/plugin work continuation will be blocked. Dispatch to a builder/auditor or finish with a compact handoff.',
        body && body.model);
    }

    const warnAt = policy.orchControl.warnManagementTurnsPerAssignment ?? DEFAULT_POLICY.orchControl.warnManagementTurnsPerAssignment;
    const maxTurns = policy.orchControl.maxManagementTurnsPerAssignment ?? DEFAULT_POLICY.orchControl.maxManagementTurnsPerAssignment;
    if (st.assignmentManagementTurns > maxTurns) {
      if (consumePostCapBoundaryAllowance(policy, classification, requestHeaders, st)) return null;
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
      if (consumePostCapBoundaryAllowance(policy, classification, requestHeaders, st)) return null;
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

  return null;
}

function advisorCandidate(policy, classification, body, requestHeaders) {
  if (!policy || classification.role !== 'ORCH' || classification.explicitNonOrchRole
      || classification.commandClass !== 'SWEEP_REPO' || hardSafetyReason(classification, body)
      || !['warn', 'enforce'].includes(policy.redirect?.mode)
      || !safeForSyntheticRedirect(body, classification) || hasOverride(classification.project, policy, requestHeaders)) return null;
  // The advisor cannot override the independent tool-output size cap.
  if (policy.mode === 'block' && policy.toolResults?.mode === 'block'
      && classification.maxLatestToolResultBytes > policy.toolResults.maxToolResultBytes) return null;
  return readonlyAction(body);
}

async function checkEnforcementAsync(project, panel, body, compactHeaders = {}, rawTokens = 0, guardDeps = {}, requestHeaders = {}) {
  const advisor = guardDeps.pairAdvisor;
  let allowance = null;
  let fallbackReason = '';
  if (advisor && guardDeps.enforcementConfig && !guardDeps.advisorSignal?.aborted) {
    const policy = resolvePolicy(guardDeps.enforcementConfig, project);
    const classification = classifyRequest(project, panel, body, compactHeaders, rawTokens);
    const candidate = advisorCandidate(policy, classification, body, requestHeaders);
    if (candidate) {
      // Only bounded user context and validated command scope leave Miser.
      // Raw tool output, provider headers and process environment are omitted.
      const firstUser = firstUserMessage(body.messages || []);
      const input = { project, panel, tool: candidate.tool,
        readonlyScope: { kind: candidate.kind, repos: candidate.repos, fields: candidate.fields },
        classification: { ...classification,
          firstUserPromptText: stripClaudeCodeInjectedContext(promptTextFromContent(firstUser?.content)).slice(0, 768),
          latestUserPromptText: classification.latestUserPromptText.slice(0, 768), latestUserText: '' } };
      let timer;
      let abort;
      try {
        const deadline = new Promise(resolve => {
          timer = setTimeout(() => resolve(null), Math.min(advisor.timeoutMs || 12000, 20000) + 25);
          abort = () => resolve(null);
          guardDeps.advisorSignal?.addEventListener('abort', abort, { once: true });
        });
        const result = await Promise.race([Promise.resolve().then(() => advisor.classify(input)), deadline]);
        // Validate again at the application boundary, even for injected callers.
        const validated = result?.ok ? validateAdvisorJson(JSON.stringify(result.advisor)) : null;
        if (validated?.ok && validated.value.intent === 'external_verification'
            && validated.value.action === 'allow' && validated.value.should_count === false) {
          allowance = { target: result.target, confidence: validated.value.confidence };
        } else {
          fallbackReason = validated?.reason || result?.reason || (result ? 'non_softening_verdict' : 'deadline');
        }
      } catch (_) { fallbackReason = 'advisor_error'; }
      finally {
        clearTimeout(timer);
        if (abort) guardDeps.advisorSignal?.removeEventListener('abort', abort);
      }
    }
  }
  if (guardDeps.advisorSignal?.aborted) return null;
  if (fallbackReason) {
    const event = { decision: 'advisor_fallback', reason: /^[a-z0-9_-]{1,60}$/.test(fallbackReason) ? fallbackReason : 'advisor_error' };
    (guardDeps.enforcementState || defaultState).recordDecision(project, panel, event);
    if (guardDeps.recordEnforcementEvent) guardDeps.recordEnforcementEvent(project, event, guardDeps.nowFn);
  }
  // State is recorded exactly once, after the wait, against current policy.
  // Existing assignment budgets are preserved; only this proven read is exempt.
  return checkEnforcement(project, panel, body, compactHeaders, rawTokens,
    allowance ? { ...guardDeps, [ADVISOR_ALLOWANCE]: allowance } : guardDeps, requestHeaders);
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
  checkEnforcementAsync,
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
