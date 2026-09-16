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
    boundedReadMaxAssistantTurns: 2,
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

function terminalOpenAIToolShapes(messages) {
  const latest = messages.at(-1);
  if (latest?.role === 'assistant' && Array.isArray(latest.tool_calls) && latest.tool_calls.length) {
    return latest.tool_calls.map(toolCall => ({ kind: 'tool_use', text: '', toolUse: null, toolCall }));
  }
  if (latest?.role !== 'tool') return null;

  // Chat Completions returns a batch as separate role:tool messages. Pair only
  // with the nearest assistant tool-call turn, never with stale conversation IDs.
  let firstResult = messages.length - 1;
  while (firstResult > 0 && messages[firstResult - 1]?.role === 'tool') firstResult--;
  let toolCalls = [];
  for (let i = firstResult - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'user') break;
    if (msg?.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      toolCalls = msg.tool_calls;
      break;
    }
  }
  return messages.slice(firstResult).map(result => {
    const id = result.tool_call_id;
    const toolCall = typeof id === 'string' && id
      ? toolCalls.find(call => call && call.id === id) || null
      : null;
    // An orphan result is still tool traffic; its output is not a user command.
    return { kind: 'tool_result', text: textFromContent(result.content), toolUse: null, toolCall };
  });
}

function terminalMessageShapes(body) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const openAIShapes = terminalOpenAIToolShapes(messages);
  if (openAIShapes) return openAIShapes;
  const terminal = messages.at(-1);
  if (terminal?.role === 'assistant' && Array.isArray(terminal.content)) {
    const toolUses = terminal.content.filter(block => block && block.type === 'tool_use');
    if (toolUses.length) return toolUses.map(toolUse => ({ kind: 'tool_use', text: '', toolUse }));
  }
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

function rawToolArgumentsText(value) {
  if (typeof value === 'string') return value;
  // Invalid non-string arguments still carry text. Walk iteratively so deep or
  // cyclic values cannot overflow JSON.stringify or hide nested command text.
  const chunks = [];
  const pending = [value];
  const seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (current && typeof current === 'object') {
      if (seen.has(current)) continue;
      seen.add(current);
      for (const [key, entry] of Object.entries(current)) {
        chunks.push(key);
        pending.push(entry);
      }
    } else if (current != null) {
      chunks.push(String(current));
    }
  }
  return chunks.join(' ');
}

function extractOpenAIToolCommand(toolCall) {
  const fn = toolCall && toolCall.function;
  const name = typeof fn?.name === 'string' ? fn.name : '';
  const args = fn?.arguments;
  let tool = { name, command: '', filePath: '' };
  if (typeof args === 'string') {
    try {
      const input = JSON.parse(args);
      if (isPlainObject(input)) {
        // Every supplied safety field must be usable, including aliases that
        // extraction precedence would otherwise hide. Absent aliases are fine.
        const fields = ['command', 'cmd', 'file_path', 'path'].filter(key => Object.hasOwn(input, key));
        const usable = fields.filter(key => typeof input[key] === 'string' && input[key].trim());
        // An empty primary alias must not discard a decoded, usable sibling.
        tool = extractToolCommand({ name, input: Object.fromEntries(usable.map(key => [key, input[key]])) });
        if (fields.length && usable.length === fields.length) return tool;
      }
    } catch { /* Scan malformed JSON below, without truncating or interpreting it. */ }
  }
  // Scan all raw text if any supplied field is unusable (or all are absent).
  // Keep decoded commands and paths too: JSON escapes can hide their syntax
  // from a raw scan, and paths still need the structural file-safety checks.
  return { ...tool, rawArguments: rawToolArgumentsText(args), argumentsUnvalidated: true };
}

const EXEC_CAPABLE_TOOL_NAME = /bash|shell|exec|terminal|command|run[-_]?cmd/i;
function looksExecCapableToolName(name) {
  return EXEC_CAPABLE_TOOL_NAME.test(String(name || ''));
}

function toolCommandForShape(shape) {
  return shape?.toolCall ? extractOpenAIToolCommand(shape.toolCall) : extractToolCommand(shape?.toolUse);
}

function promptCommandCandidate(shape, commandRequestOnly = false) {
  if (!shape || (shape.kind !== 'real_user_text' && shape.kind !== 'notification')) return '';
  const text = normalizedText(shape.text);
  if (!text) return '';
  if (commandRequestOnly) {
    // Collect requests independently: prose must neither shield a later command
    // nor add example text to an earlier command's hard-safety scan.
    const executionPrefix = /^(?:(?:can|could|would|will) you )?(?:please )?(?:run|execute)(?:\s*:\s*|\s+|$)/i;
    const commandHead = /^(?:bash|sh|zsh|sudo|env|printenv|export|set|cat|head|tail|sed|nl|rg|grep|find|ls|git|gh|systemctl|codex)(?:\s|$)/i;
    const followingPrefix = /^(?:(?:the )?following\b|(?:the )?(?:shell )?commands?\b)/i;
    const examplePrefix = /^(?:(?:can|could|would|will) you )?(?:please )?(?:explain|describe)\b.*\b(?:examples?|commands?)\b.*:$/i;
    const explanationPrefix = /^(?:(?:can|could|would|will) you )?(?:please )?(?:explain|describe)\b/i;
    const negatedPrefix = /\b(?:do\s+not|don['’]t|never|won['’]t)\s+(?:ever\s+)?(?:poll|run|execute|check)\b/i;
    function negatedRequest(line) {
      // A negation in an actual shell command, quoted argument or explanation
      // is not a prohibition introducing the next command block.
      if (executionPrefix.test(line) || commandHead.test(line) || explanationPrefix.test(line)) return null;
      const match = line.match(negatedPrefix);
      if (!match) return null;
      let quote = '';
      for (let i = 0; i < match.index; i++) {
        const char = line[i];
        if (char === '\\' && quote) { i++; continue; }
        if (quote) { if (char === quote) quote = ''; }
        else if (char === '`' || char === '"'
            || (char === "'" && !/[a-z0-9]/i.test(line[i - 1] || ''))) quote = char;
      }
      return quote ? null : match;
    }
    const commands = [];
    let blockIntent = '';
    let blockStarted = false;
    let fence = '';
    let executionIntent = false;
    let fenceIntent = false;
    let negatedBlock = false;
    let clauseIntent = false;
    let quoted = false;

    // Read lazily so HTML presentation follows the current execution context.
    // Injected context remains suppressed; decorative wrappers are inert until
    // an outside instruction requests their contents. Quotes keep shell
    // semicolons inside one clause, including explicitly prohibited commands.
    function* commandClauses() {
      const input = topLevelContextText(shape.text, INJECTED_CONTEXT_WRAPPERS);
      const wrappers = [];
      let includeWrapper = false;
      let negatedWrapper = false;
      let line = '';
      let quote = '';
      let afterSemicolon = false;
      for (let i = 0; i < input.length; i++) {
        const char = input[i];
        const tag = char === '<' && input.slice(i).match(/^<\s*(\/?)\s*([a-z][a-z0-9:-]*)\b/i);
        if (tag && ROLE_CONTEXT_WRAPPERS.has(tag[2].toLowerCase())) {
          let end = i + tag[0].length;
          let attributeQuote = '';
          for (; end < input.length; end++) {
            const next = input[end];
            if (attributeQuote) { if (next === attributeQuote) attributeQuote = ''; }
            else if (next === '"' || next === "'") attributeQuote = next;
            else if (next === '>' || next === '<') break;
          }
          if (input[end] !== '>') break;
          if (!wrappers.length) {
            const prefix = normalizedText(line);
            negatedWrapper = negatedBlock || !!negatedRequest(prefix);
            includeWrapper = (executionPrefix.test(prefix) || executionIntent || clauseIntent)
              && !explanationPrefix.test(prefix) && !negatedWrapper;
          }
          const name = tag[2].toLowerCase();
          if (tag[1]) {
            if (wrappers.at(-1) === name) wrappers.pop();
          } else if (!input.slice(i, end).trimEnd().endsWith('/')) {
            wrappers.push(name);
          }
          // Treat every removed tag as a clause separator, preserving both
          // word boundaries and independent negation in adjacent wrappers.
          yield line;
          line = '';
          quote = '';
          if (!wrappers.length && negatedWrapper) {
            negatedBlock = false;
            blockIntent = '';
            blockStarted = false;
            negatedWrapper = false;
          }
          i = end;
          continue;
        }
        if (wrappers.length && !includeWrapper) continue;
        if (char === '\n' || (char === ';' && !quote)) {
          yield line;
          if (char === '\n') clauseIntent = false;
          line = '';
          quote = '';
          afterSemicolon = char === ';';
          continue;
        }
        if (afterSemicolon && !line && (char === ' ' || char === '\t')) continue;
        line += char;
        if (char === '\\' && quote && i + 1 < input.length) { line += input[++i]; continue; }
        if (quote) { if (char === quote) quote = ''; }
        else if (char === '`' || char === '"'
            || (char === "'" && !/[a-z0-9]/i.test(input[i - 1] || ''))) quote = char;
      }
      yield line;
    }

    for (const rawLine of commandClauses()) {
      const line = normalizedText(rawLine);
      const marker = rawLine.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
          fence = '';
          blockIntent = '';
          blockStarted = false;
        } else if (fenceIntent) commands.push(line);
        continue;
      }
      const negation = negatedRequest(line);
      if (negation) {
        const command = line.slice(negation.index + negation[0].length).trim()
          .replace(/^:\s*/, '').replace(/^[`'"]/, '');
        // An inline command consumes its own negation. Otherwise bind it to
        // the upcoming block, independently of how that block is described.
        negatedBlock = !commandHead.test(command);
        if (negatedBlock) {
          blockIntent = 'example';
          blockStarted = false;
        }
        continue;
      }
      if (explanationPrefix.test(line)) {
        executionIntent = false;
        clauseIntent = false;
        negatedBlock = false;
      }
      if (/^\s*>/.test(rawLine)) {
        quoted = true;
        blockStarted = true;
        if (blockIntent === 'run') commands.push(line.replace(/^(?:>\s*)+/, ''));
        continue;
      }
      if (!line) {
        quoted = false;
        if (blockStarted) blockIntent = '';
        blockStarted = false;
        continue;
      }
      const executionRequest = executionPrefix.test(line);
      const command = executionRequest ? line.replace(executionPrefix, '').replace(/^[`'"]/, '') : line;
      const followingCommands = executionRequest && followingPrefix.test(command);
      const explicitCommand = executionRequest && (commandHead.test(command) || followingCommands);
      // An unmarked execution request starts its own instruction, even directly
      // after a quoted example. Other lazy blockquote continuation stays quoted.
      if (quoted && !explicitCommand) {
        if (blockIntent === 'run') commands.push(line);
        continue;
      }
      quoted = false;
      if (marker) {
        fence = marker[1];
        fenceIntent = executionIntent && !negatedBlock;
        negatedBlock = false;
        blockStarted = true;
        continue;
      }
      if (negatedBlock) {
        negatedBlock = false;
        blockIntent = '';
        blockStarted = false;
        if (!explicitCommand) continue;
      }
      if (/^(?: {4}|\t)/.test(rawLine)) {
        blockStarted = true;
        if (blockIntent === 'run') commands.push(line);
        continue;
      }
      if (declaredRole(line)) continue;
      if (explicitCommand || clauseIntent) {
        commands.push(command);
        blockIntent = followingCommands ? 'run' : '';
        executionIntent = followingCommands || executionIntent;
        clauseIntent = true;
        blockStarted = false;
      } else if (examplePrefix.test(line)) {
        blockIntent = 'example';
        blockStarted = false;
      } else if (commandHead.test(command)) {
        blockStarted = true;
        if (blockIntent !== 'example') { commands.push(command); clauseIntent = true; }
      } else {
        blockIntent = '';
        blockStarted = false;
      }
    }
    return commands.join('\n');
  }
  const lower = text.toLowerCase();
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

// R12: DISPATCH_OK is decided from command TEXT, so `echo "run spawn-lane.sh"`
// classifies as DISPATCH_OK too. That is harmless for a class that is simply
// never redirected, but it must NOT be able to arm the post-dispatch
// confirmation allowance -- otherwise echoing a script name would buy a poll.
// Arming therefore requires a segment whose resolved HEAD really is a dispatch
// script, not a mention of one anywhere in the text.
const DISPATCH_ACTION_HEADS = new Set([
  'spawn-lane.sh', 'td-inject.sh', 'safe-reap.sh', 'spawn-codex-audit.sh', 'spawn-grok-audit.sh',
]);
// R13 BLOCKER 3a (CODEX-IQA-R12 enforcement.js:883): finding a dispatch head
// in ANY parsed segment ignores shell short-circuit semantics, so
// `false && ~/bin/spawn-lane.sh ...` and `true || ~/bin/spawn-lane.sh ...`
// armed the post-dispatch allowance for a dispatch that never ran. Arming is a
// permission grant, so it must reflect what actually EXECUTES. We only ever
// claim a segment is unreachable when that is statically PROVABLE -- its
// controlling predecessor is a literal `true`/`:`/`false` -- because treating
// every unknown predecessor as unreachable would refuse to arm the ordinary,
// legitimate `mkdir -p x && ~/bin/spawn-lane.sh ...`, reintroducing exactly the
// false-positive class this sprint exists to remove.
const SHELL_ALWAYS_TRUE_HEADS = new Set(['true', ':']);
const SHELL_ALWAYS_FALSE_HEADS = new Set(['false']);
function segmentStaticExit(segmentText) {
  const stages = pipeStages(segmentText);
  // In a pipeline the LAST stage supplies the exit status.
  const { head, args } = parseCommandSegment(stages[stages.length - 1]);
  if (args.length) return 'unknown'; // `true --help` etc: do not over-claim
  if (SHELL_ALWAYS_TRUE_HEADS.has(head)) return 'success';
  if (SHELL_ALWAYS_FALSE_HEADS.has(head)) return 'failure';
  return 'unknown';
}
// Returns one entry per top-level segment: { text, runs } where `runs` is false
// ONLY when non-execution is provable. `;`/newline/`&` segments are
// independent; `&&` is skipped after a provable failure; `||` after a provable
// success.
function reachableTopLevelSegments(command) {
  const parts = commandTopLevelSegmentsWithOps(command);
  const out = [];
  // Status of the AND-OR list accumulated so far. A skipped branch does not
  // change it, which is what makes `false && A || B` run B and
  // `true || A && B` run B -- both real shell behaviours a per-segment-only
  // model gets wrong.
  let listExit = 'unknown';
  for (let i = 0; i < parts.length; i++) {
    const { text, op } = parts[i];
    let runs;
    if (i === 0) runs = true;
    else if (op === '&&') runs = listExit !== 'failure';
    else if (op === '||') runs = listExit !== 'success';
    else runs = true; // ';' newline '&' start a new, unconditional list
    out.push({ text, runs });
    if (op === ';' || op === '\n' || op === '&' || i === 0) listExit = runs ? segmentStaticExit(text) : 'unknown';
    else if (runs) listExit = segmentStaticExit(text);
  }
  return out;
}
function commandRunsDispatchAction(commandText) {
  const raw = String(commandText || '');
  if (!raw.trim()) return false;
  return reachableTopLevelSegments(raw)
    .filter(segment => segment.runs)
    .some(segment => pipeStages(segment.text)
      .some(stage => DISPATCH_ACTION_HEADS.has(parseCommandSegment(stage).head)));
}

// R14 BLOCKER 6 (CODEX-IQA-R13 enforcement.js:941,945,1383): R13 answered the
// laundering question one TOP-LEVEL SEGMENT at a time, but a pipeline is a
// single top-level segment (`|` is deliberately not a boundary in
// commandPipelineSegments). So `echo "spawn-lane.sh" | curl .../sessions/<id>`
// put the echoed script name and the real poll in the SAME segment, the
// whole-segment text match said "this segment is a dispatch", and the poll rode
// in free -- every turn, forever, with no dispatch ever running. The unit of
// the question is therefore the pipe STAGE: each stage is its own process, so
// each one must answer for its own subject.
//
// Proof that a stage performs a dispatch is POSITIVE and anchored on the
// stage's HEAD -- the program that actually executes -- never on text a stage
// merely prints:
//   (a) the head is a dispatch script. The inherited script patterns are
//       re-applied to the HEAD TOKEN alone, so `~/bin/td-inject.sh` and bare
//       `td-inject` both still qualify (R13 behaviour preserved) while
//       `echo td-inject.sh` cannot, and
//   (b) the head is the client that performs a non-script dispatch pattern:
//       curl/wget for the pkachu reply POST, git for `git fetch`, date.
// Anything else -- echo, printf, grep, xargs, jq -- proves nothing, whatever it
// contains. This is deliberately NOT a denylist of text-emitting commands: an
// unrecognized head fails closed (not a dispatch), which costs at most one
// redirect, where failing open costs an unbounded poll.
const DISPATCH_SCRIPT_HEAD_PATTERNS = [
  /^spawn-lane\.sh$/,
  /^safe-reap\.sh$/,
  /^td-inject(?:\.sh)?$/,
];
const DISPATCH_CLIENT_ACTIONS = [
  { heads: new Set(['curl', 'wget']), pattern: /\bpost\b.*:(?:8001)\/v1\/orch\/[^/\s]+\/reply\b/i },
  { heads: new Set(['curl', 'wget']), pattern: /\bcurl\b.*(?:-x\s+)?post\b.*\/v1\/orch\/[^/\s]+\/reply\b/i },
  { heads: new Set(['git']), pattern: /^\s*git\s+fetch(?:\s+--[^\s]+|\s+\S+){0,2}\s*$/i },
  { heads: new Set(['date']), pattern: /^\s*date(?:\s+[^\n;&|]+)?\s*$/i },
];
function stageIsDispatchAction(stageText) {
  const head = parseCommandSegment(stageText).head;
  if (!head) return false;
  if (DISPATCH_ACTION_HEADS.has(head)) return true;
  if (DISPATCH_SCRIPT_HEAD_PATTERNS.some(pattern => pattern.test(head))) return true;
  const text = normalizedText(stageText);
  return DISPATCH_CLIENT_ACTIONS.some(({ heads, pattern }) => heads.has(head) && pattern.test(text));
}
function stageCarriesPollSubject(stageText) {
  return Object.keys(REDIRECT_CLASS_SUBJECT_TESTS)
    .some(cls => REDIRECT_CLASS_SUBJECT_TESTS[cls](stageText));
}
// True when some REACHABLE stage carries a protected poll subject and is not
// itself a dispatch action -- i.e. the DISPATCH_OK text match would be
// laundering an unrelated poll. See BLOCKER 3d (segments) and BLOCKER 6 (pipe
// stages).
function dispatchOkLaundersPoll(commandText) {
  for (const segment of reachableTopLevelSegments(commandText)) {
    if (!segment.runs) continue;
    const stages = pipeStages(segment.text);
    for (const stage of stages) {
      if (stageCarriesPollSubject(stage) && !stageIsDispatchAction(stage)) return true;
    }
    // A subject whose text straddles a pipe boundary belongs to no single
    // stage, so the loop above cannot see it. Splitting must never LOSE
    // detection the segment-level R13 check had: if the segment as a whole
    // carries a subject and no stage in it performs a dispatch, that is
    // laundering too.
    if (stageCarriesPollSubject(segment.text) && !stages.some(stageIsDispatchAction)) return true;
  }
  return false;
}

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
];

// A real Miser log reference is a path SEGMENT (.miser/ dir, or a
// miser*.log/.jsonl basename) -- not the substring "miser" occurring
// anywhere in an unrelated path -- and it must be a FILE argument of an
// actual log-reading command, not a grep/rg SEARCH PATTERN.
const MISER_LOG_PATH_SEGMENT = /(?:^|\/)\.miser\//i;
const MISER_LOG_BASENAME = /^miser(?:[-_.][\w-]*)?\.(?:log|jsonl|json|txt)\b/i;
const LOG_READ_HEADS = new Set(['tail', 'cat', 'less', 'head', 'grep', 'rg', 'nl', 'sed']);
const PATTERN_ARG_HEADS = new Set(['grep', 'rg']);
// grep/rg's PATTERN can be supplied via a repeatable `-e`/`--regexp` flag
// instead of the bare positional argument. CODEX-IQA-R2 B2: naively assuming
// "the first bare argument is always the pattern" produced BOTH directions of
// error -- a second `-e PATTERN` value was left uncounted and misread as a
// file (`grep -e a -e '/.miser/' STATUS.md`), and a `--regexp=` glued form
// already supplied the pattern, so dropping "the first bare argument" instead
// discarded a REAL file argument (`grep --regexp=x ~/.miser/miser.log f`).
const PATTERN_VALUE_FLAGS = new Set(['-e', '--regexp']);

function segmentArgTokens(segment) {
  const input = String(segment || '').trim();
  const tokens = [];
  let cur = '';
  let quote = '';
  let any = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = '';
      else cur += ch;
      any = true;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      const next = input[i + 1];
      if (!quote || '"\\$`\n'.includes(next)) {
        if (next !== '\n') cur += next;
        any = true;
        i++;
        continue;
      }
    }
    if (quote === '"') {
      if (ch === '"') quote = '';
      else cur += ch;
      any = true;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (any) { tokens.push(cur); cur = ''; any = false; } continue; }
    cur += ch; any = true;
  }
  if (any) tokens.push(cur);
  return tokens;
}

// Flags that consume a SEPARATE following argument for a given wrapper (not
// bundled/`=`-joined). Needed so a wrapper's OWN option value (e.g. `sudo -u
// brad`) is never mistaken for the next wrapper or the real command's head.
// CODEX-IQA-R2 B1: `sudo -u x nice tail -f ...` resolved to head `x` (the
// username) because the old skip loop only knew how to skip flag TOKENS
// themselves, never a flag's separate value token.
const WRAPPER_VALUE_FLAGS = {
  sudo: new Set(['-u', '--user', '-g', '--group', '-p', '--prompt', '-r', '--role', '-t', '--type', '-h', '--host', '-C', '--close-from']),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-k', '--kill-after', '-s', '--signal']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),   // <- NEW
};
// timeout's own leading positional argument is the duration, not a flag, and
// must be skipped like one (`timeout 5 tail -f ...`).
const BARE_DURATION = /^\s*[+]?(?:0[xX](?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)(?:[pP][-+]?\d+)?|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|inf(?:inity)?|nan)[smhd]?$/i;
// timeout accepts a negative zero as a disabled timer. Other negative durations
// are rejected by coreutils; do not treat them as wrapper durations.
function isTimeoutDuration(value) {
  if (BARE_DURATION.test(value)) return true;
  const text = String(value || '').replace(/^\s+/, '');
  if (!text.startsWith('-')) return false;
  const unsigned = text.slice(1);
  if (!BARE_DURATION.test(unsigned)) return false;
  const numeric = unsigned.replace(/[smhd]$/i, '');
  const hex = /^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([-+]?\d+))?$/.exec(numeric);
  if (hex) {
    const digits = (hex[1] + (hex[2] || '')).replace(/^0+/, '');
    if (!digits) return true;
    const first = parseInt(digits[0], 16);
    const highestBit = (digits.length - 1) * 4 + Math.floor(Math.log2(first));
    const exponent = Number(hex[3] || 0) - 4 * (hex[2] || '').length;
    const highestPower = highestBit + exponent;
    if (highestPower < -1075) return true;
    if (highestPower > -1075) return false;
    // Exactly halfway to the smallest subnormal rounds to signed zero.
    return /^[1248]0*$/.test(digits);
  }
  const decimal = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.exec(numeric);
  return !!decimal && Number(numeric) === 0;
}

// Resolves the real head through COMMAND_WRAPPER_HEADS -- including chained
// wrappers (`sudo -u x nice tail -f ...`) and each wrapper's own
// value-consuming flags or (for timeout) leading positional duration -- and
// returns the remaining args as plain, unquoted tokens.
function envDashSEscapedLiteral(ch) {
  switch (ch) {
    case 'f': return '\f';
    case 'n': return '\n';
    case 'r': return '\r';
    case 't': return '\t';
    case 'v': return '\v';
    case '#': return '#';
    case '$': return '$';
    case '"': return '"';
    case "'": return "'";
    case '\\': return '\\';
    default: return null;
  }
}
function splitEnvDashSValue(value) {
  const input = String(value || '');
  const n = input.length;
  const tokens = [];
  let cur = '';
  let any = false;
  let quote = '';
  let i = 0;
  while (i < n) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === '\\' && (input[i + 1] === "'" || input[i + 1] === '\\')) { cur += input[i + 1]; i += 2; any = true; continue; }
      if (ch === "'") { quote = ''; i++; continue; }
      cur += ch; any = true; i++; continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < n) {
        const next = input[i + 1];
        if (next === '_') { cur += ' '; i += 2; any = true; continue; } // \_ inside "" -> literal space
        const literal = envDashSEscapedLiteral(next);
        if (literal !== null) { cur += literal; i += 2; any = true; continue; }
        cur += ch; i++; any = true; continue; // unrecognized escape: leave the backslash itself literal
      }
      if (ch === '"') { quote = ''; i++; continue; }
      cur += ch; any = true; i++; continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; any = true; i++; continue; }
    if (ch === '\\' && i + 1 < n) {
      const next = input[i + 1];
      if (next === '_') { if (any) { tokens.push(cur); cur = ''; any = false; } i += 2; continue; } // \_ outside quotes -> separator
      const literal = envDashSEscapedLiteral(next);
      if (literal !== null) { cur += literal; i += 2; any = true; continue; }
      cur += next; i += 2; any = true; continue; // unrecognized escape (e.g. \c, not implemented): literal next char
    }
    if (/\s/.test(ch)) { if (any) { tokens.push(cur); cur = ''; any = false; } i++; continue; }
    cur += ch; any = true; i++;
  }
  if (any) tokens.push(cur);
  return tokens;
}

function parseCommandSegment(segment) {
  const tokens = segmentArgTokens(segment);
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) { i++; continue; }
    const base = path.basename(tok).toLowerCase();
    if (COMMAND_WRAPPER_HEADS.has(base)) {
      i++;
      const valueFlags = WRAPPER_VALUE_FLAGS[base];
      while (i < tokens.length && tokens[i].startsWith('-')) {
        const flag = tokens[i];
        if (base === 'env' && (flag === '-S' || flag === '--split-string')) {
          i++;
          if (i < tokens.length) tokens.splice(i, 1, ...splitEnvDashSValue(tokens[i]));
          continue;
        }
        if (base === 'env' && flag.startsWith('--split-string=')) {
          tokens.splice(i, 1, ...splitEnvDashSValue(flag.slice('--split-string='.length)));
          continue;
        }
        // NEW: glued short form (env -S'value', no space at all).
        if (base === 'env' && flag.length > 2 && flag.startsWith('-S') && !flag.startsWith('--')) {
          tokens.splice(i, 1, ...splitEnvDashSValue(flag.slice(2)));
          continue;
        }
        i++;
        if (valueFlags && valueFlags.has(flag) && !flag.includes('=') && i < tokens.length) i++;
      }
      if (base === 'timeout' && i < tokens.length && isTimeoutDuration(tokens[i])) i++;
      continue;
    }
    return { head: base, args: tokens.slice(i + 1) };
  }
  return { head: '', args: [] };
}

function commandHeadName(segment) {
  return parseCommandSegment(segment).head;
}

// Splits on unquoted ; \n && || (top-level compound commands) AND a bare `&`
// (background job) so a Miser reference in one segment can't be credited to
// an unrelated command in another. CODEX-IQA-R2 B1: the round-2 splitter
// omitted `||` entirely (only `;`, `\n`, `&&` were recognized).
function closesQuoteHere(input, i, quote) {
  if (quote === '"') return !isEscapedAt(input, i);
  return true;
}

function commandPipelineSegments(command) {
  const input = String(command || '');
  const segments = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      current += ch;
      if (ch === quote && closesQuoteHere(input, i, quote)) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === ';' || ch === '\n' || ch === '&' || (ch === '|' && input[i + 1] === '|')) {
      if ((ch === '&' && input[i + 1] === '&') || (ch === '|' && input[i + 1] === '|')) i++;
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

// Splits ONE top-level segment into its `|`-joined pipe STAGES so a Miser log
// read appearing anywhere in a pipe chain is recognized (`printf ready | tail
// -f ~/.miser/miser.log` still reads the Miser log; CODEX-IQA-R2 B1 -- round
// 2's isMiserPoll only ever inspected the chain's FIRST head). Quote-aware so
// a literal `|` inside a quoted argument is never mistaken for a pipe.
function pipeStages(segment) {
  const input = String(segment || '');
  const stages = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      current += ch;
      if (ch === quote && closesQuoteHere(input, i, quote)) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === '|' && input[i + 1] !== '|') { stages.push(current); current = ''; continue; }
    current += ch;
  }
  stages.push(current);
  return stages;
}

// Excludes grep/rg's PATTERN argument(s) from the candidate file list --
// EVERY pattern-supplying flag form, not just the common bare-positional
// case (CODEX-IQA-R2 B2).
// Once a bundle hits a short flag that is itself known to consume a value,
// EVERYTHING after it is that flag's own glued value, not further flag
// characters -- an `e` occurring past that point can never be the pattern
// flag. Scan left-to-right and stop at the first such flag.
const RG_VALUE_SHORT_FLAGS = new Set(['A', 'B', 'C', 'M', 'm', 'r', 'f', 'g', 't', 'T', 'j', 'E']);
const GREP_VALUE_SHORT_FLAGS = new Set(['A', 'B', 'C', 'f', 'm', 'd', 'D']);
function valueShortFlagsFor(head) {
  return head === 'rg' ? RG_VALUE_SHORT_FLAGS : GREP_VALUE_SHORT_FLAGS;
}

const PATTERN_FILE_VALUE_FLAGS = new Set(['-f', '--file']);

function shortClusterPatternFlag(arg, head) {
  if (!arg.startsWith('-') || arg.startsWith('--')) return null;
  const body = arg.slice(1);
  if (!body.length) return null;
  const valueFlags = valueShortFlagsFor(head);
  for (let idx = 0; idx < body.length; idx++) {
    const ch = body[idx];
    if (ch === 'e') return { kind: 'pattern', needsNextToken: body.slice(idx + 1).length === 0 };
    if (ch === 'f') return { kind: 'file', needsNextToken: body.slice(idx + 1).length === 0, glued: body.slice(idx + 1) };
    if (valueFlags.has(ch)) return null;
  }
  return null;
}

function stripPatternArgs(args, head) {
  const out = [];
  let sawPatternFlag = false;
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!optionsEnded && arg === '--') { optionsEnded = true; continue; }
    if (!optionsEnded && arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      const flagName = eq === -1 ? arg : arg.slice(0, eq);
      if (PATTERN_VALUE_FLAGS.has(flagName)) {
        sawPatternFlag = true;
        if (eq === -1 && i + 1 < args.length) i++;
        continue;
      }
      if (PATTERN_FILE_VALUE_FLAGS.has(flagName)) {
        sawPatternFlag = true;
        if (eq !== -1) out.push(flagName === '-f' && head === 'grep' ? arg.slice(2) : arg.slice(eq + 1));
        else if (i + 1 < args.length) { out.push(args[i + 1]); i++; }
        continue;
      }
      const cluster = shortClusterPatternFlag(arg, head);
      if (cluster) {
        sawPatternFlag = true;
        if (cluster.kind === 'file') {
          if (cluster.needsNextToken) { if (i + 1 < args.length) { out.push(args[i + 1]); i++; } }
          else out.push(cluster.glued);
        } else if (cluster.needsNextToken && i + 1 < args.length) i++;
      }
      continue;
    }
    out.push(arg);
  }
  return sawPatternFlag ? out : out.slice(1);
}

function fileArgsFor(head, args) {
  if (PATTERN_ARG_HEADS.has(head)) return stripPatternArgs(args, head);
  return args.filter(a => !a.startsWith('-'));
}

function isMiserPoll(command) {
  return commandPipelineSegments(command).some(segment => {
    if (/\b(?:curl|wget|http)\b/i.test(segment)
        && /:20128\/(?:health|stats|events)\b|\/api\/miser\b/i.test(segment)) return true;
    if (/\bjournalctl\b/.test(segment) && /(?:-u|--unit(?:=|\s+))\s*miser\b/i.test(segment)) return true;
    return pipeStages(segment).some(stage => {
      const { head, args } = parseCommandSegment(stage);
      if (!LOG_READ_HEADS.has(head)) return false;
      const fileArgs = fileArgsFor(head, args);
      return fileArgs.some(a => MISER_LOG_PATH_SEGMENT.test(a) || MISER_LOG_BASENAME.test(a));
    });
  });
}

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
  const tool = toolCommandForShape(shape);
  const name = tool.name.toLowerCase();
  // isMiserPoll needs the RAW text (embedded newlines intact) to correctly
  // split a multi-line command into separate logical commands -- by the time
  // `command` below is built, normalizedText has already collapsed every
  // newline to a space, silently fusing e.g. `printf ready\ntail -f
  // ~/.miser/miser.log` into one blob whose head is `printf`, hiding the
  // real second command from classification entirely.
  const rawCommandText = String(tool.command || tool.rawArguments || promptCommandCandidate(shape) || '');
  const command = normalizedText(rawCommandText);
  const filePath = tool.filePath;

  // R13 BLOCKER 3d (CODEX-IQA-R12 enforcement.js:864,1310): DISPATCH_OK is a
  // TEXT match and it wins ahead of every poll class, so
  // `echo "spawn-lane.sh"; curl .../api/sessions/<id>` was never classified as
  // polling no matter how many times it repeated. A mention of a script name
  // must not buy an exemption for an unrelated poll riding in another segment.
  // A poll subject appearing INSIDE the dispatch command itself (a td-inject
  // message body that says "replyCount", a POST to the reply endpoint) is still
  // DISPATCH_OK -- only a poll in a segment that is not itself a dispatch
  // demotes the call to its real poll class.
  if (command && commandMatches(command, DISPATCH_OK_PATTERNS) && !dispatchOkLaundersPoll(rawCommandText)) {
    return { commandClass: 'DISPATCH_OK', terminalShape: shape.kind, dispatchActionRan: commandRunsDispatchAction(rawCommandText) };
  }
  if (filePath && isDispatchArtifactPath(filePath)) return { commandClass: 'DISPATCH_OK', terminalShape: shape.kind };
  if (command && commandMatches(command, POLL_CI_PATTERNS)) return { commandClass: 'POLL_CI', terminalShape: shape.kind };
  if (command && commandMatches(command, POLL_TERMDECK_PATTERNS)) return { commandClass: 'POLL_TERMDECK', terminalShape: shape.kind };
  if (command && (commandMatches(command, POLL_MISER_PATTERNS) || isMiserPoll(rawCommandText))) return { commandClass: 'POLL_MISER', terminalShape: shape.kind };
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

// --- Fix B.2 (v3): bounded single-read exemption for an explicit operator question ---

function textLooksLikeDirectQuestion(text) {
  const t = normalizedText(text);
  if (!t || t.length > 400) return false; // a long briefing/boot prompt is not "a quick question"
  if (/[?]\s*$/.test(t)) return true;
  return /^(?:what|when|where|why|how|who|which|is|are|can|could|did|does|do|should)\b/i.test(t);
}

// An explicit "stop watching/monitoring" style instruction should immediately
// disarm a pending, still-unused bounded-read allowance rather than leaving
// it armed until the turn-window naturally expires it (CODEX-IQA-R2 B4).
function textLooksLikeStopInstruction(text) {
  const lower = normalizedText(text).toLowerCase();
  if (!lower) return false;
  return /\b(?:stop|halt|cancel|never\s*mind)\b[\s\S]*\b(?:monitor(?:ing)?|poll(?:ing)?|watch(?:ing)?|check(?:ing)?|track(?:ing)?)\b/.test(lower);
}

// A question only earns an exemption for the class it is actually ABOUT.
// "Are you still there?" must never arm a POLL_MISER read, no matter how
// recently it was asked -- direct fix for CODEX-IQA-R2/R1 B4. Bare "logs"/
// "stats" were dropped from the POLL_MISER hint entirely (CODEX-IQA-R2 B4):
// they matched ANY log/stats question regardless of subject, so an unrelated
// "What do nginx logs show?" re-triggered a Miser-read exemption armed by an
// earlier, genuinely-Miser question. LOOP_SHELL is deliberately absent: a
// loop construct is never a single bounded read regardless of what the
// question asked.
const REDIRECT_CLASS_TOPIC_HINTS = {
  POLL_MISER: /\bmiser\b|\.miser\b|:20128\b/i,
  POLL_CI: /\bci\b|\bcheck(?:s)?\b|\bpipeline\b|\bpr\b|\brun(?:s)?\b/i,
  POLL_TERMDECK: /\btermdeck\b|\bsession(?:s)?\b|\bpanel(?:s)?\b|\breplycount\b/i,
  POLL_HEALTH: /\bhealth\b|\bstatus\b|\bservice(?:s)?\b|\bsystemctl\b/i,
  SWEEP_REPO: /\brepo(?:s)?\b|\bpr(?:s)?\b|\bsweep\b/i,
};

const MISER_COMPOUND_IDENTIFIER = /\bmiser-[\w-]+\b|\b[\w-]+-miser\b/gi;
function isLogShapedMiserCompound(match, rest) {
  if (/^\.(?:log|jsonl|json|txt)\b/i.test(rest)) return true; // ...-log.log, ...-log.jsonl, etc.
  return /-log$/i.test(match); // a bare, extensionless "...-log" basename (e.g. miser-access-log)
}
function stripMiserCompoundIdentifiers(text) {
  const input = String(text || '');
  return input.replace(MISER_COMPOUND_IDENTIFIER, (match, offset, full) => {
    const rest = full.slice(offset + match.length);
    return isLogShapedMiserCompound(match, rest) ? match : ' ';
  });
}

function questionMentionsTopic(questionText, commandClass) {
  const hint = REDIRECT_CLASS_TOPIC_HINTS[commandClass];
  return !!hint && hint.test(stripMiserCompoundIdentifiers(questionText));
}

function questionLooksTopical(questionText) {
  const stripped = stripMiserCompoundIdentifiers(questionText);
  return Object.values(REDIRECT_CLASS_TOPIC_HINTS).some(hint => hint.test(stripped));
}

// Rejects the exact shapes CODEX-IQA-R1/R2 B3 confirmed slip through a
// window/allowance check that only looked at "did a question happen
// recently": a following tail/journalctl (including a combined short-flag
// cluster like `-fn50`, not just a standalone `-f`), a watch loop, a
// while/until/for loop of any shape (not just one that happens to also
// contain the literal word "sleep"), and an xargs pipeline (repeats its
// command once per input line by construction). A single pipe chain
// (`curl ... | jq .`) is NOT rejected -- that is one logical read, matching
// Fix B.1's commandPipelineSegments' own pipe-is-not-a-boundary rule.


// Splits on ; \n && || AND a bare `&` (background job -- CODEX-IQA-R2 B3: two
// reads joined by `&` previously stayed in one segment and looked "single").
// Same NOT-split-on-`|` rationale as commandPipelineSegments.
// R13: the existing splitter DISCARDS which operator joined two segments, so
// short-circuit semantics are invisible to every caller. This is the same scan,
// quote-for-quote, but it records the operator that PRECEDED each segment.
// `commandTopLevelSegments` is left byte-identical so no existing caller moves.
function commandTopLevelSegmentsWithOps(command) {
  const input = String(command || '');
  const parts = [];
  let current = '';
  let pendingOp = null;
  let quote = '';
  const push = () => { if (current.trim()) parts.push({ text: current, op: pendingOp }); };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      current += ch;
      if (ch === quote && closesQuoteHere(input, i, quote)) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === ';' || ch === '\n' || ch === '&' || (ch === '|' && input[i + 1] === '|')) {
      let op = ch;
      if (ch === '&' && input[i + 1] === '&') { op = '&&'; i++; }
      else if (ch === '|' && input[i + 1] === '|') { op = '||'; i++; }
      push();
      if (current.trim()) pendingOp = op;
      current = '';
      continue;
    }
    current += ch;
  }
  push();
  return parts;
}

function commandTopLevelSegments(command) {
  const input = String(command || '');
  const segments = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      current += ch;
      if (ch === quote && closesQuoteHere(input, i, quote)) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === ';' || ch === '\n' || ch === '&' || (ch === '|' && input[i + 1] === '|')) {
      if ((ch === '&' && input[i + 1] === '&') || (ch === '|' && input[i + 1] === '|')) i++;
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.filter(s => s.trim());
}

// Follow flags are command arguments, not bytes in reconstructed shell text.
// Keep each pipe stage and its -- marker separate; quoted filename separators
// remain data and cannot manufacture a flag after a lossy join.
function tailShortClusterHasUpperFollow(arg) {
  if (!/^-[a-zA-Z0-9]+$/.test(arg)) return false;
  for (const ch of arg.slice(1)) {
    if (ch === 'F') return true;
    // GNU tail's -n/-c/-s consume the remainder as their own value.
    if (ch === 'n' || ch === 'c' || ch === 's') return false;
  }
  return false;
}

// GNU coreutils accepts unique long-option abbreviations. The installed tail
// option table has only one --f* option, but --s is ambiguous (silent/sleep).
const TAIL_LONG_OPTIONS = [
  '--bytes', '--follow', '--lines', '--max-unchanged-stats', '--pid',
  '--quiet', '--retry', '--silent', '--sleep-interval', '--verbose',
  '--zero-terminated', '--help', '--version',
];
const TAIL_LONG_VALUE_OPTIONS = new Set([
  '--bytes', '--lines', '--max-unchanged-stats', '--pid', '--sleep-interval',
]);
function resolveTailLongOption(arg) {
  const eq = arg.indexOf('=');
  const name = eq === -1 ? arg : arg.slice(0, eq);
  if (name.length < 3) return null;
  const matches = TAIL_LONG_OPTIONS.filter(option => option.startsWith(name));
  if (matches.length !== 1) return null;
  return { name: matches[0], hasValue: eq !== -1, value: eq === -1 ? '' : arg.slice(eq + 1) };
}
function isTailFollowValue(value) {
  return !!value && ('name'.startsWith(value) || 'descriptor'.startsWith(value));
}
function isTraditionalTailFollow(args, index) {
  if (index !== 0 || args.length > 2) return false;
  // Traditional +[NUM][bcl]f is one option, with at most one file operand.
  // The leading + is an operand after --, handled by the caller's boundary.
  return /^\+\d*[bcl]?f$/.test(args[index]);
}
// CODEX-IQA-R10 B3-L: a value-taking option's argument decides whether tail
// ever reaches its follow loop. GNU tail 9.4 exits 1 on a value it rejects
// (`--lines ~/.miser/miser.log` -> "invalid number of lines"), and exits 1 when
// the option is missing its argument entirely. A value carrying unexpanded
// shell syntax is NOT judged here -- we cannot see what it becomes at runtime,
// so it is treated as possibly valid rather than used to excuse a follow.
const TAIL_NUMERIC_VALUE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[a-zA-Z]{0,3}$/;
function tailValueStopsCommand(value) {
  if (value == null) return true; // option is missing its required argument
  if (/[$`]/.test(value)) return false; // unexpanded: unknowable, not a negation
  return !TAIL_NUMERIC_VALUE.test(value);
}
// A short cluster whose last character is a value-taking letter with nothing
// glued after it takes the NEXT argument as its value (-n, -c, -s, and also
// combined forms such as -fn).
function tailShortClusterTakesNextValue(arg) {
  return /^-[a-zA-Z0-9]*[ncs]$/.test(arg);
}
function stageHasFollowFlag(stage) {
  const { head, args } = parseCommandSegment(stage);
  if (head !== 'tail' && head !== 'journalctl') return false;
  // CODEX-IQA-R10 B3-L: recognizing a --follow-shaped token is not the verdict.
  // GNU tail keeps parsing the rest of the argument list, and a later --help,
  // --version, unrecognized or ambiguous long option, rejected option value, or
  // missing required argument makes it print/error and exit WITHOUT following
  // (`tail --f --help FILE` exits 0; audit/vendor-tail-r11.json). So record the
  // follow and keep scanning: only a follow nothing later negates counts.
  let sawFollow = false;
  let valuePending = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valuePending) {
      if (tailValueStopsCommand(arg)) return false;
      valuePending = false;
      continue;
    }
    if (arg === '--') break;
    if (head === 'tail') {
      if (arg.startsWith('--')) {
        const option = resolveTailLongOption(arg);
        if (!option) return false; // invalid/ambiguous long option: tail exits
        if (option.name === '--help' || option.name === '--version') return false;
        if (option.name === '--follow') {
          // A rejected --follow=VALUE is an exit, not a quiet non-follow.
          if (option.hasValue && !isTailFollowValue(option.value)) return false;
          sawFollow = true;
          continue;
        }
        if (TAIL_LONG_VALUE_OPTIONS.has(option.name)) {
          if (!option.hasValue) valuePending = true;
          else if (tailValueStopsCommand(option.value)) return false;
        } else if (option.hasValue) return false; // this option takes no =value
        continue;
      }
      if (isTraditionalTailFollow(args, i)) { sawFollow = true; continue; }
      if (/^-[a-zA-Z0-9]*f[a-zA-Z0-9]*$/.test(arg) || tailShortClusterHasUpperFollow(arg)) {
        sawFollow = true;
      }
      if (tailShortClusterTakesNextValue(arg)) valuePending = true;
      continue;
    }
    // journalctl's own -F lists fields; retain only its existing follow forms.
    if (arg === '--follow' || arg.startsWith('--follow=')) return true;
    if (/^-[a-zA-Z0-9]*f[a-zA-Z0-9]*$/.test(arg)) return true;
  }
  if (valuePending) return false; // option never got its required argument
  return sawFollow;
}

const UNBOUNDED_CONTROL_PATTERN = /(?:^|\s)watch\s|\bwhile\b[\s\S]*\bdo\b|\buntil\b[\s\S]*\bdo\b|\bfor\b[\s\S]*\bdo\b|\bxargs\b|\bsleep\s+\d+(?:\.\d+)?\s*&&/i;
// R12 Hit 2 (live NACHO-ORCH repro 2026-09-14): boundedness is a property of
// each command, not of how many commands share one Bash call. The round-11
// form demanded EXACTLY ONE top-level segment, so a genuinely bounded
// `tail -30 PROPOSAL-v10.md` silently forfeited its exemption the moment it
// was batched behind `;`/`&&` with an ls/grep/find that were each bounded too
// -- and the batch was redirected as POLL_MISER. Judge EVERY segment instead:
// the call is bounded when no segment is unbounded. Single-segment behaviour is
// unchanged by construction (`[x].every(f)` === `f(x)`), and the whole-text
// UNBOUNDED_CONTROL_PATTERN check above still rejects a batch containing a
// watch/while/until/for/xargs construct anywhere in it.
function isBoundedReadCommand(commandText) {
  const raw = String(commandText || '');
  if (!raw.trim()) return false;
  if (UNBOUNDED_CONTROL_PATTERN.test(raw)) return false;
  const segments = commandTopLevelSegments(raw);
  // A non-empty string that yields no segments at all (`;;;`) is not a read.
  if (!segments.length) return false;
  return segments.every(segment => !pipeStages(segment).some(stageHasFollowFlag));
}

// R12: relaxing the "exactly one segment" rule must not turn one Bash call into
// a cheap way to run the SAME poll several times. Batching unrelated bounded
// work alongside one bounded read is the false positive we are fixing; batching
// N reads OF THE REDIRECTED SUBJECT is exactly the repeat-polling the redirect
// exists to stop, and the inherited PROPOSAL-v4 regressions
// (`tail -n 50 ~/.miser/miser.log; tail -n 50 ~/.miser/miser.log`, and the same
// joined by `&`) assert precisely that. So count the segments that carry the
// subject of the class being exempted and allow at most one.
const REDIRECT_CLASS_SUBJECT_TESTS = {
  POLL_MISER: segment => commandMatches(normalizedText(segment), POLL_MISER_PATTERNS) || isMiserPoll(segment),
  POLL_TERMDECK: segment => commandMatches(normalizedText(segment), POLL_TERMDECK_PATTERNS),
  POLL_CI: segment => commandMatches(normalizedText(segment), POLL_CI_PATTERNS),
  POLL_HEALTH: segment => commandMatches(normalizedText(segment), POLL_HEALTH_PATTERNS),
  SWEEP_REPO: segment => commandMatches(normalizedText(segment), SWEEP_REPO_PATTERNS),
};
function hasAtMostOneSubjectSegment(commandText, commandClass) {
  const isSubject = REDIRECT_CLASS_SUBJECT_TESTS[commandClass];
  if (!isSubject) return true; // class carries no subject test: nothing extra to enforce
  let seen = 0;
  for (const segment of commandTopLevelSegments(String(commandText || ''))) {
    if (isSubject(segment) && ++seen > 1) return false;
  }
  return true;
}

// R13 BLOCKER 1 (CODEX-IQA-R12 enforcement.js:1314,1636): classification picks
// the FIRST matching class and the exemption was then evaluated for THAT class
// alone. `gh run view 1; tail -30 ~/.miser/miser.log` classified POLL_CI, held
// exactly one CI segment, and the pass excused the whole call -- laundering an
// unrelated Miser read through a CI authorization. An exemption must be scoped
// PER CLASS: enumerate every protected class actually present among the
// segments and require each one to earn its own pass (its own on-topic
// question, its own unused one-shot, its own single-subject cap). One class's
// pass can never excuse another class's segment.
function protectedClassesInCommand(commandText) {
  const found = new Set();
  for (const segment of commandTopLevelSegments(String(commandText || ''))) {
    for (const cls of Object.keys(REDIRECT_CLASS_SUBJECT_TESTS)) {
      if (REDIRECT_CLASS_SUBJECT_TESTS[cls](segment)) found.add(cls);
    }
  }
  return found;
}
// Every class this call must clear: the classified one plus any other protected
// class riding along in some segment. (The classified class is included even
// when no segment test recognizes it -- e.g. a whole-text-only match -- so the
// exemption can never get WEAKER than the round-12 single-class rule.)
function exemptionClassesFor(classification, commandText) {
  const classes = protectedClassesInCommand(commandText);
  if (isRedirectableCommandClass(classification.commandClass)) classes.add(classification.commandClass);
  return [...classes];
}
// Returns the array of classes exempted, or null when the call is not exempt.
function boundedOperatorReadClasses(classification, st, policy, body) {
  if (!st || st.lastDirectQuestionAssistantTurns == null) return null;
  if (classification.terminalShape !== 'tool_result') return null;
  if (classification.commandClass === 'LOOP_SHELL') return null;
  const orch = policy.orchControl || {};
  const windowTurns = orch.boundedReadMaxAssistantTurns ?? DEFAULT_POLICY.orchControl.boundedReadMaxAssistantTurns;
  const turnsSince = classification.assistantTurns - st.lastDirectQuestionAssistantTurns;
  if (turnsSince < 1 || turnsSince > windowTurns) return null;
  const shape = terminalMessageShape(body);
  const tool = toolCommandForShape(shape);
  const commandText = String(tool.command || tool.rawArguments || '');
  if (!isBoundedReadCommand(commandText)) return null;
  const classes = exemptionClassesFor(classification, commandText);
  if (!classes.length) return null;
  for (const cls of classes) {
    if (cls === 'LOOP_SHELL') return null;
    if (!questionMentionsTopic(st.lastDirectQuestionText, cls)) return null;
    if (st.boundedReadClassesUsed && st.boundedReadClassesUsed.has(cls)) return null;
    if (!hasAtMostOneSubjectSegment(commandText, cls)) return null;
  }
  return classes;
}
function isBoundedOperatorRead(classification, st, policy, body) {
  return boundedOperatorReadClasses(classification, st, policy, body) !== null;
}

// R12 NEW (live NACHO-ORCH repro 2026-09-14): a single `GET /api/sessions/<id>`
// confirming a spawn that this panel JUST performed was redirected as
// POLL_TERMDECK. Root cause: POLL_TERMDECK is decided purely from the URL
// shape, and the only exemption path (isBoundedOperatorRead) is armed
// EXCLUSIVELY by a direct operator question -- performing a DISPATCH_OK action
// arms nothing at all. So the classifier has no representation of "one bounded
// confirmation read after an action", which is the same category as CHARGE.md
// Pattern B, now on the TermDeck API surface. This allowance is deliberately
// the narrowest thing that closes it: it is armed only by a DISPATCH_OK action
// that actually ran, it expires after DISPATCH_CONFIRM_MAX_TURNS assistant
// turns, it is one-shot per armed action, it covers ONLY POLL_TERMDECK, it
// requires a bounded read naming a SPECIFIC session id, and it refuses a bulk
// listing or any non-GET method. A second check, a listing, or a scheduled
// poll is still redirected exactly as before.
const DISPATCH_CONFIRM_MAX_TURNS = 2;
const TERMDECK_SINGLE_SESSION_URL = /\/api\/sessions\/[A-Za-z0-9._:-]+/i;
const TERMDECK_SESSION_LIST_URL = /\/api\/sessions(?![/A-Za-z0-9._:-])/i;
// R13 BLOCKER 3b (CODEX-IQA-R12 enforcement.js:1685): the round-12 check only
// rejected the spaced/equals `-X`/`--request` spellings, so `-XDELETE`,
// `-XPOST`, `-d`, `--data*`, `-F`, `-T` and `--head` all sailed through and a
// MUTATING request could collect the read exemption. Instead of blacklisting
// spellings, prove the opposite: the stage must be a fetch we can see is a
// plain GET. Anything we cannot parse as such is refused.
// curl short options that take a value, so a cluster's tail is that value and
// must not be re-read as more flags.
// R14 (CODEX-IQA-R13 enforcement.js:1839,1861): `K` was listed here as an
// ordinary value-taking option, so `curl -K request.conf URL` parsed as a plain
// GET even though that file can set `request = DELETE`, attach a body, or add
// further URLs -- defeating both the method check and the cardinality count.
// The contents of an external config file are not visible to us, so a command
// that reads one is not PROVABLY a plain GET and is refused. `K` is removed
// from the value-option list so the cluster scan below can reject it.
const CURL_SHORT_VALUE_OPTS = 'XdFTHEbcoAeumtwzUY';
// Long options that change the method or attach a body.
const CURL_METHOD_LONG = /^--(?:request|data|data-raw|data-binary|data-ascii|data-urlencode|json|form|form-string|form-escape|upload-file|head|next)\b/i;
// Long options that read request configuration we cannot inspect.
const CURL_EXTERNAL_CONFIG_LONG = /^--config\b/i;
const CURL_FORCE_GET_LONG = /^--get\b/i;
function curlStageIsPlainGet(stage) {
  const { head, args } = parseCommandSegment(stage);
  if (head !== 'curl' && head !== 'wget') return false;
  if (head === 'wget') {
    // wget defaults to GET; any method/body option disqualifies it.
    return !args.some(arg => /^--(?:method|post-data|post-file|body-data|body-file)\b/i.test(arg));
  }
  let forcesGet = false;
  let methodChanging = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (CURL_FORCE_GET_LONG.test(arg)) { forcesGet = true; continue; }
    if (CURL_EXTERNAL_CONFIG_LONG.test(arg)) return false;
    if (CURL_METHOD_LONG.test(arg)) {
      // `--data` under an explicit `--get` is still a GET query string.
      if (/^--(?:data|data-raw|data-binary|data-ascii|data-urlencode|json)\b/i.test(arg)) { methodChanging = methodChanging || !forcesGet; continue; }
      return false;
    }
    if (arg === '--') break;
    if (arg.startsWith('--') || !arg.startsWith('-') || arg.length < 2) continue;
    // Short cluster: scan until a value-taking option consumes the remainder.
    for (let k = 1; k < arg.length; k++) {
      const ch = arg[k];
      if (ch === 'X' || ch === 'F' || ch === 'T' || ch === 'I' || ch === 'K') return false;
      if (ch === 'G') { forcesGet = true; }
      if (ch === 'd') { methodChanging = true; break; }
      if (CURL_SHORT_VALUE_OPTS.includes(ch)) break; // rest of cluster is its value
    }
  }
  // `-G -d` is a GET; a bare `-d`/`--data` is a POST.
  return !(methodChanging && !forcesGet);
}
// R13 BLOCKER 3c (CODEX-IQA-R12 enforcement.js:1643,1688): cardinality was
// counted in SHELL SEGMENTS, but one curl invocation issues one request PER
// URL. `curl URL/a URL/b URL/c` is a single segment and matched the unanchored
// single-session regex, so three polls ran under a one-shot allowance. Count
// actual request TARGETS instead.
const TERMDECK_SESSION_URL_GLOBAL = /\/api\/sessions\/[A-Za-z0-9._:-]+/gi;
const CURL_GLOB_CHARS = /[{}\[\]]/;
function isSingleSessionStatusRead(commandText) {
  const raw = String(commandText || '');
  if (!raw.trim()) return false;
  if (TERMDECK_SESSION_LIST_URL.test(raw)) return false;
  let targets = 0;
  for (const segment of commandTopLevelSegments(raw)) {
    for (const stage of pipeStages(segment)) {
      const tokens = segmentArgTokens(stage);
      const urlTokens = tokens.filter(tok => TERMDECK_SINGLE_SESSION_URL.test(tok));
      if (!urlTokens.length) continue;
      // Every stage that issues a session request must itself be a plain GET.
      if (!curlStageIsPlainGet(stage)) return false;
      for (const tok of urlTokens) {
        // curl expands `{a,b}` / `[1-3]` into SEVERAL requests from one token.
        if (CURL_GLOB_CHARS.test(tok)) return false;
        targets += (tok.match(TERMDECK_SESSION_URL_GLOBAL) || []).length;
      }
    }
  }
  // Exactly one real HTTP request against exactly one named session.
  return targets === 1;
}
function isBoundedDispatchConfirmation(classification, st, body) {
  if (!st) return false;
  if (classification.terminalShape !== 'tool_result') return false;
  if (classification.commandClass !== 'POLL_TERMDECK') return false;
  const tool = toolCommandForShape(terminalMessageShape(body));
  const commandText = String(tool.command || tool.rawArguments || '');
  // R13: with BLOCKER 3d fixed, `~/bin/spawn-lane.sh ...; curl .../sessions/<id>`
  // no longer classifies DISPATCH_OK, so the dispatch and its one confirmation
  // read can now arrive in the SAME call. That is still Pattern B, so accept a
  // dispatch this very command reachably runs, alongside the existing
  // <=2-turn window armed by a previous turn.
  const armedNow = commandRunsDispatchAction(commandText);
  if (!armedNow) {
    if (st.lastDispatchActionAssistantTurns == null) return false;
    const turnsSince = classification.assistantTurns - st.lastDispatchActionAssistantTurns;
    if (turnsSince < 1 || turnsSince > DISPATCH_CONFIRM_MAX_TURNS) return false;
    if (st.dispatchConfirmClassesUsed && st.dispatchConfirmClassesUsed.has(classification.commandClass)) return false;
  }
  if (!isBoundedReadCommand(commandText)) return false;
  if (!hasAtMostOneSubjectSegment(commandText, classification.commandClass)) return false;
  // Every OTHER protected class riding along must clear its own rules too
  // (BLOCKER 1): this allowance covers POLL_TERMDECK and nothing else.
  if (exemptionClassesFor(classification, commandText).some(cls => cls !== 'POLL_TERMDECK')) return false;
  return isSingleSessionStatusRead(commandText);
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
    dispatchActionRan: !!command.dispatchActionRan,
    redirectable: isRedirectableCommandClass(command.commandClass),
    directOperatorQuestion: command.terminalShape === 'real_user_text' && textLooksLikeDirectQuestion(latestPromptText),
    stopInstruction: command.terminalShape === 'real_user_text' && textLooksLikeStopInstruction(latestPromptText),
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
        lastDirectQuestionAssistantTurns: null,
        lastDirectQuestionText: '',
        boundedReadClassesUsed: null,
        lastDispatchActionAssistantTurns: null,
        dispatchConfirmClassesUsed: null,
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
    st.lastDirectQuestionAssistantTurns = null;
    st.lastDirectQuestionText = '';
    st.boundedReadClassesUsed = null;
    st.lastDispatchActionAssistantTurns = null;
    st.dispatchConfirmClassesUsed = null;
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
    st.lastDirectQuestionAssistantTurns = null;
    st.lastDirectQuestionText = '';
    st.boundedReadClassesUsed = null;
    st.lastDispatchActionAssistantTurns = null;
    st.dispatchConfirmClassesUsed = null;
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
    st.lastDirectQuestionAssistantTurns = null;
    st.lastDirectQuestionText = '';
    st.boundedReadClassesUsed = null;
    st.lastDispatchActionAssistantTurns = null;
    st.dispatchConfirmClassesUsed = null;
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
    if (classification.stopInstruction) {
      // Immediately disarm rather than waiting for the turn-window to expire
      // a now-unwanted allowance (CODEX-IQA-R2 B4).
      st.lastDirectQuestionAssistantTurns = null;
      st.lastDirectQuestionText = '';
      st.boundedReadClassesUsed = null;
      st.lastDispatchActionAssistantTurns = null;
      st.dispatchConfirmClassesUsed = null;
    } else if (classification.directOperatorQuestion) {
      // A topic-less follow-up ("Are you still there?") must not clobber a
      // still-pending allowance armed by an earlier, genuinely on-topic
      // question -- direct fix for CODEX-IQA-R2 B4 (round 2 treated this as
      // an accepted over-blocking tradeoff; it is fixed here instead). A
      // topical question always (re-)arms fresh, and an unarmed session
      // still records itself so the turn-window bound applies from here.
      const topical = questionLooksTopical(classification.latestUserPromptText);
      if (topical || st.lastDirectQuestionAssistantTurns == null) {
        st.lastDirectQuestionAssistantTurns = classification.assistantTurns;
        st.lastDirectQuestionText = classification.latestUserPromptText || classification.latestUserText || '';
        st.boundedReadClassesUsed = new Set();
      }
    }
    // R12 NEW: a DISPATCH_OK action that actually RAN (a tool_result, not a
    // mention of one in prose) arms exactly one bounded confirmation read.
    if (classification.commandClass === 'DISPATCH_OK' && classification.terminalShape === 'tool_result'
        && classification.dispatchActionRan) {
      st.lastDispatchActionAssistantTurns = classification.assistantTurns;
      st.dispatchConfirmClassesUsed = new Set();
    }
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
  const tool = toolCommandForShape(shape);
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

// --- Fix A (v3): narrow data-payload blanking, not general quote-stripping ---
//
// Only these commands, and only these specific flags, hand their argument to
// something OTHER than this process's own operand handling -- an HTTP request
// body, sent to a remote endpoint, never read/executed locally as shell
// syntax. Every other quoted argument anywhere else (cat's file path,
// printenv's var name, rg's pattern, bash -c's or eval's script, a heredoc
// body) is the real operand/code and must stay fully scannable. Not
// generalizing this list is the entire fix for A1/A2 (CODEX-IQA-R1): if we
// never strip anything for any other command, there is nothing left for a
// bypass to exploit.
const DATA_TRANSPORT_COMMANDS = new Set(['curl', 'wget']);
// Case-SENSITIVE and a real `--data*` prefix match (CODEX-IQA-R2 A1's curl-
// flag citation): round 2 enumerated exact long-flag names AND matched
// case-insensitively, which (a) would silently miss any future curl
// `--data-xxx` variant and (b) let `-D` (curl's unrelated dump-headers-to-
// file flag) match `-d` case-insensitively. Neither was a confirmed exploit,
// but both are fixed here while this line is already being rewritten rather
// than left as latent risk.
const DATA_PAYLOAD_FLAG = /^(?:-d|--data(?:-[a-z]+)*|--post-data)(?:=([\s\S]*))?$/;

// A command wrapper never changes WHAT executes, only how -- resolve through
// it to find the real head (env, sudo, nice, nohup, timeout all commonly
// precede the real command). Shared with Fix B's parseCommandSegment.
const COMMAND_WRAPPER_HEADS = new Set(['env', 'nice', 'nohup', 'timeout', 'sudo', 'command', 'exec']);

const MAX_SUBSTITUTION_DEPTH = 24;
const MAX_SUBSTITUTION_SCAN_LEN = 20000;
const MAX_COMMAND_SCAN_LEN = 200000; // far past any real command; fail closed (scan unchanged) rather than parse

// Quote-aware AND depth-bounded. Quote-aware: a `)` character sitting inside
// an unclosed quote never decrements paren depth, so `$(printf ')';
// git push origin main)` cannot have its substitution closed early by the
// quoted `)`. Depth-bounded: past MAX_SUBSTITUTION_DEPTH we stop trying to
// look inside nested `$(...)` and signal overflow instead of recursing
// further.
//
// `parenIndex` is the index of the OPENING `(` character itself (the caller
// always passes the position right after a `$`). CODEX-IQA-R2 A3: round 2's
// loop started scanning AT that same `(` and counted it toward `paren`,
// which meant the loop needed one EXTRA unmatched `)` beyond the substitution's
// real close before it would ever return -- on a substitution with no nested
// parens at all, this ran the scan off the end of the string (silently
// swallowing whatever came after, including a real subsequent command) or,
// when a stray later `)` happened to exist, over-captured everything up to
// that point (`$(printf ok)XYZ` yielded inner `'printf ok)XYZ'`). Starting
// the loop at `parenIndex + 1` and only incrementing `paren` for a REAL
// nested `(` (never the substitution's own opening one) fixes both shapes.
function readBalancedParen(text, parenIndex, depth = 0) {
  if (depth > MAX_SUBSTITUTION_DEPTH) return { inner: '', endIndex: parenIndex, overflow: true };
  let paren = 0;
  let quote = '';
  for (let i = parenIndex + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < text.length) { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) { i++; continue; }   // <- NEW: unquoted backslash-escape
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '$' && text[i + 1] === '(') {
      const inner = readBalancedParen(text, i + 1, depth + 1);
      if (inner.overflow) return inner;
      i = inner.endIndex;
      continue;
    }
    if (ch === '(') { paren++; continue; }
    if (ch === ')') {
      if (paren === 0) return { inner: text.slice(parenIndex + 1, i), endIndex: i };
      paren--;
    }
  }
  return { inner: text.slice(parenIndex + 1), endIndex: text.length - 1 };
}

// Pulls ONLY live $(...)/`...` substitution content out of a span (used
// exclusively on an already-identified curl/wget data-payload argument);
// everything else in the span (the literal JSON/text payload) is discarded,
// which is correct here specifically because this function is only ever
// called on text we have already decided is a removed data payload.
//
// CODEX-IQA-R2 A3's primary bug: round 2 recursed into `extractLiveSubstitutions`
// to look for FURTHER nested substitutions inside a found one, but never
// actually appended the substitution's own inner text to `out` -- only
// whatever its recursive call happened to find. A substitution whose body
// contains no NESTED `$(...)`/backtick of its own (e.g. `$(printf ')';
// git push origin main)`) therefore vanished entirely, deleting a live
// `git push` from the scan. Fixed by appending `inner`/the backtick body
// itself; a flat, non-recursive single pass is sufficient because the
// eventual hard-safety scan is a plain substring/regex match over the
// reconstructed text -- it does not care whether a nested substitution's
// syntax is still visibly nested or not, only whether the executed text is
// present somewhere in the string at all.
//
// Returns `{ overflow: true }` if the span is too long or too deeply nested
// to safely parse (CODEX-IQA-R2 A4) -- the caller (`blankDataPayloadSpans`)
// must react to that by leaving the ORIGINAL span text in place, unblanked,
// rather than discarding it: failing OPEN by deleting an unscanned payload
// is exactly the bug being fixed, not an acceptable degradation.
function extractLiveSubstitutions(text) {
  if (text.length > MAX_SUBSTITUTION_SCAN_LEN) return { overflow: true };
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) { i++; continue; }
    if (ch === '$' && text[i + 1] === '(') {
      const result = readBalancedParen(text, i + 1);
      if (result.overflow) return result;
      out += ' ' + result.inner + ' ';
      i = result.endIndex;
      continue;
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end === -1) break;
      out += ' ' + text.slice(i + 1, end) + ' ';
      i = end;
      continue;
    }
  }
  return { overflow: false, text: out };
}

// Minimal quote-aware tokenizer with ORIGINAL-STRING spans (start/end),
// because Fix A needs to blank an exact byte range, not just extract
// resolved token text. Recognizes ; \n && || | as top-level boundaries
// (each pipeline stage is a distinct process, so the "current head command"
// resets there too). No recursion, no paren-tracking -- O(n), cannot be the
// site of an A4-style stack blowout regardless of input shape.
function isEscapedAt(command, pos) {
  let backslashes = 0;
  let j = pos - 1;
  while (j >= 0 && command[j] === '\\') { backslashes++; j--; }
  return backslashes % 2 === 1;
}
function isRedirectionAmpersand(command, i) {
  const prev = command[i - 1];
  if ((prev === '>' || prev === '<') && !isEscapedAt(command, i - 1)) return true;
  return command[i + 1] === '>';
}
function joinLineContinuations(command) {
  const n = command.length;
  let out = '';
  let quote = '';
  let i = 0;
  while (i < n) {
    const ch = command[i];
    if (quote === "'") {
      out += ch;
      if (ch === "'") quote = '';
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < n) {
      if (command[i + 1] !== '\n') out += ch + command[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (!quote) quote = ch;
      else if (quote === ch) quote = '';
    }
    out += ch;
    i++;
  }
  return out;
}

function shellTokenize(command) {
  const tokens = [];
  let i = 0;
  const n = command.length;
  while (i < n) {
    if (command[i] === ';' || command[i] === '\n') { tokens.push({ op: true, text: command[i], start: i, end: i + 1 }); i++; continue; }
    if (command[i] === '&' && !isRedirectionAmpersand(command, i)) {
      if (command[i + 1] === '&') { tokens.push({ op: true, text: '&&', start: i, end: i + 2 }); i += 2; continue; }
      tokens.push({ op: true, text: '&', start: i, end: i + 1 }); i++; continue;
    }
    if (/\s/.test(command[i])) { i++; continue; }
    if (command[i] === '|' && command[i + 1] === '|') { tokens.push({ op: true, text: '||', start: i, end: i + 2 }); i += 2; continue; }
    if (command[i] === '|') { tokens.push({ op: true, text: '|', start: i, end: i + 1 }); i++; continue; }
    const start = i;
    let quote = '';
    while (i < n) {
      const ch = command[i];
      if (quote) {
        if (ch === '\\' && quote === '"' && i + 1 < n) { i += 2; continue; }
        if (ch === quote) { quote = ''; i++; continue; }
        i++; continue;
      }
      if (ch === '\\' && i + 1 < n) { i += 2; continue; }
      if (ch === "'" || ch === '"') { quote = ch; i++; continue; }
      if (/\s/.test(ch) || ch === ';' || ch === '\n' || ch === '|') break;
      if (ch === '&' && !isRedirectionAmpersand(command, i)) break;
      i++;
    }
    tokens.push({ op: false, text: command.slice(start, i), start, end: i });
  }
  return tokens;
}

// Resolves a token's quotes for MATCHING only (flag names, head names) --
// never used to compute a span; spans always come from token.start/end so
// blanking stays byte-exact.
function unquoteWord(word) {
  let out = '';
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (ch === "'" || ch === '"') continue;
    if (ch === '\\' && i + 1 < word.length) { out += word[i + 1]; i++; continue; }
    out += ch;
  }
  return out;
}

function blankDataPayloadSpans(command) {
  if (!command || command.length > MAX_COMMAND_SCAN_LEN) return command; // fail closed: too long to safely parse, scan unchanged
  const command_ = joinLineContinuations(command);
  const tokens = shellTokenize(command_);
  const spans = [];
  let head = null;
  let expectHeadNext = true;
  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    if (tok.op) { head = null; expectHeadNext = true; continue; }
    const word = unquoteWord(tok.text);
    if (expectHeadNext) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue; // FOO=bar env-style prefix; keep waiting
      const base = path.basename(word).toLowerCase();
      if (COMMAND_WRAPPER_HEADS.has(base)) continue; // wrapper itself is not the head; next real word is
      head = base;
      expectHeadNext = false;
      continue;
    }
    if (!DATA_TRANSPORT_COMMANDS.has(head)) continue;
    const flagMatch = word.match(DATA_PAYLOAD_FLAG);
    if (!flagMatch) continue;
    if (flagMatch[1] !== undefined) {
      const eq = tok.text.indexOf('=');
      spans.push({ start: tok.start + eq + 1, end: tok.end });
    } else if (tokens[idx + 1] && !tokens[idx + 1].op) {
      spans.push({ start: tokens[idx + 1].start, end: tokens[idx + 1].end });
      idx++;
    }
  }
  if (!spans.length) return command_; // fast path: the overwhelming majority of commands never touch this at all
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += command_.slice(cursor, span.start);
    const spanText = command_.slice(span.start, span.end);
    const extracted = extractLiveSubstitutions(spanText);
    // CODEX-IQA-R2 A4: on overflow (too deep or too long to safely parse),
    // fail CLOSED by putting the ORIGINAL span text back verbatim -- fully
    // scannable, exactly as if this command had never matched a data-transport
    // flag at all -- instead of round 2's `return ''`, which silently deleted
    // an unscanned payload (including a live `git push`) from the scan.
    out += extracted.overflow ? spanText : (extracted.text ? ` ${extracted.text} ` : ' ');
    cursor = span.end;
  }
  out += command_.slice(cursor);
  return out;
}

function hardSafetyScanText(command) {
  const raw = String(command || '');
  return raw ? blankDataPayloadSpans(raw) : '';
}

// R12 Hit 3/4 (live NACHO-ORCH repro 2026-09-14): `sensitive-file-read` fired
// on ANY reference to a sensitive DIRECTORY, so `find ~/.termdeck -iname ...`
// and `grep -rl ... ~/.termdeck` were gated even though neither can emit a
// single byte of file CONTENT -- they report path existence and which paths
// matched. The trigger regex below is left byte-identical; what is added is a
// SUPPRESSION that fires only when every stage touching a sensitive path is
// PROVABLY path-only. Anything unrecognized (`bash -c "cat ~/.ssh/id_rsa"`, a
// wrapper we cannot resolve, an unparsed stage) is not provable, so it keeps
// tripping. cat/head/tail/sed/nl are never path-only -- a bounded
// `tail -30 ~/.termdeck/config.yaml` still exposes 30 lines of a sensitive
// file and must still trip, per the R12 charge.
const SENSITIVE_READ_PATH = /(?:~\/\.ssh|\/home\/[^/\s]+\/\.ssh|~\/\.termdeck|\/home\/[^/\s]+\/\.termdeck|~\/\.claude\.json|\/\.claude\.json|~\/\.gitconfig|\/\.gitconfig)/;
// find actions that can execute a reader, or write/destroy, rather than just
// naming paths. -printf/-print0/-print emit find's own format directives only,
// never file contents, so they are NOT listed; -fprint*/-fls write files and
// -delete destroys them, so they are (fail closed -- this reason is the only
// gate those shapes currently hit).
const FIND_NON_PATH_ONLY_ACTIONS = new Set([
  '-exec', '-execdir', '-ok', '-okdir', '-delete', '-fls', '-fprint', '-fprint0', '-fprintf',
]);
// grep/rg short options whose remaining cluster characters are that option's
// VALUE, not more flags -- scanning must stop at the first one of these so
// `-e l` style values are never mistaken for `-l`. `-NUM` (context) likewise
// consumes the rest of the cluster.
const GREP_VALUE_SHORT_OPTS = 'ABCDdefm';
const GREP_PATHS_ONLY_LONG = new Set(['--files-with-matches', '--files-without-match']);
function grepArgIsPathsOnly(arg) {
  if (GREP_PATHS_ONLY_LONG.has(arg)) return true;
  if (arg.startsWith('--') || !arg.startsWith('-') || arg.length < 2) return false;
  for (let i = 1; i < arg.length; i++) {
    const ch = arg[i];
    if (ch === 'l' || ch === 'L') return true;
    if (GREP_VALUE_SHORT_OPTS.includes(ch) || /\d/.test(ch)) return false;
  }
  return false;
}
// R13 BLOCKER 2 (CODEX-IQA-R12 enforcement.js:2664,2674): the R12 proof looked
// only at the OUTER shape of the stage. `printf x | grep -l --label="$(cat
// ~/.ssh/id_rsa)" x` parses as head `grep` carrying `-l`, so it was suppressed
// -- while the embedded command substitution read the private key and
// `--label` emitted it in place of the filename. A command substitution runs an
// arbitrary command whose output we do not and cannot resolve statically, so no
// command containing one is PROVABLY path-only. Same for an unresolved
// expansion (`$VAR`, backtick) inside the sensitive stage itself: its value can
// supply further flags or a content-bearing argument. Both fail CLOSED, which
// is the policy this suppression already states for everything unrecognized.
function commandHasUnresolvableSubstitution(command) {
  const raw = String(command || '');
  if (!/[$`]/.test(raw)) return false;
  const extracted = extractLiveSubstitutions(raw);
  if (extracted.overflow) return true;        // too deep/long to parse -> unproven
  return !!String(extracted.text || '').trim(); // any real $(...) or `...` present
}
// grep/rg options that replace the emitted path with caller-supplied text, so
// the output is no longer "just a path" even with -l.
const GREP_LABEL_OPTS = /^--label(?:=|$)/;
function stageIsPathOnlySensitiveRead(stage) {
  const { head, args } = parseCommandSegment(stage);
  // Any unresolved expansion in the very stage that touches the sensitive path
  // makes its argv unknowable. Unproven -> not path-only.
  if (/[$`]/.test(String(stage || ''))) return false;
  if (head === 'ls') return true; // ls reports names/metadata; it has no content mode
  if (head === 'find') return !args.some(arg => FIND_NON_PATH_ONLY_ACTIONS.has(arg.toLowerCase()));
  if (head === 'grep' || head === 'rg') {
    if (args.some(arg => GREP_LABEL_OPTS.test(arg))) return false;
    return args.some(grepArgIsPathsOnly);
  }
  return false; // cat/head/tail/sed/nl, wrappers, and anything unrecognized
}
function sensitiveReadIsProvablyPathOnly(command) {
  const raw = String(command || '');
  // Scan the WHOLE command text, not just the matched stage: a substitution in
  // any segment can read a sensitive file and hand its bytes to the stage that
  // does the emitting.
  if (commandHasUnresolvableSubstitution(raw)) return false;
  const segments = commandTopLevelSegments(raw);
  if (!segments.length) return false;
  let sawSensitiveStage = false;
  for (const segment of segments) {
    for (const stage of pipeStages(segment)) {
      if (!SENSITIVE_READ_PATH.test(stage.toLowerCase())) continue;
      sawSensitiveStage = true;
      if (!stageIsPathOnlySensitiveRead(stage)) return false;
    }
  }
  // If splitting found no sensitive stage at all, the whole-text regex matched
  // across a boundary our splitter cannot see. Unproven -> keep tripping.
  return sawSensitiveStage;
}

function hardSafetyCommandReason(command) {
  const commandish = normalizedText(command).toLowerCase();
  if (!commandish) return '';
  const envCommandBoundary = /(^|\s)(env|printenv|export|set)(\s|$)/;
  if (envCommandBoundary.test(commandish)
      && /(secret|token|key|password|credential|anthropic|openai|termdeck)/.test(commandish)) return 'sensitive-env';
  if (/\b(?:cat|head|tail|sed|nl|rg|grep|find|ls)\b[\s\S]*(?:~\/\.ssh|\/home\/[^/\s]+\/\.ssh|~\/\.termdeck|\/home\/[^/\s]+\/\.termdeck|~\/\.claude\.json|\/\.claude\.json|~\/\.gitconfig|\/\.gitconfig)/.test(commandish)
      && !sensitiveReadIsProvablyPathOnly(command)) return 'sensitive-file-read';
  if (/\brg\b[\s\S]*(?:secret|token|password|credential)[\s\S]*\/home\/nacho\b/.test(commandish)) return 'broad-secret-search';
  if (/\bgit\s+branch\b[\s\S]*(?:-d|-D|--delete)\b/.test(commandish)) return 'destructive-git-branch';
  if (/\bgit\s+(?:commit|push|merge)\b/.test(commandish)) return 'git-write-operation';
  if (/\bgh\s+pr\s+(?:create|merge)\b/.test(commandish)) return 'pr-write-operation';
  if (/\bsystemctl\b[\s\S]*(?:restart|stop|start|reload)\b/.test(commandish)) return 'service-mutation';
  if (/\bcodex\s+exec\b/.test(commandish)) return 'direct-codex-exec';
  return '';
}

function hardSafetyReason(classification, body = null) {
  // Inspect the entire result batch before any role, boot or advisor exemption.
  const shapes = body ? terminalMessageShapes(body) : [null];
  for (const shape of shapes) {
    const tool = toolCommandForShape(shape);
    const prompt = !shape || ['real_user_text', 'notification'].includes(shape.kind)
      ? promptCommandCandidate(shape || { kind: 'real_user_text', text: classification.latestUserPromptText }, true)
      : '';
    const filePath = String(tool.filePath || '').toLowerCase();
    if (filePath && /(?:^|\/)\.(?:ssh|termdeck)(?:\/|$)|(?:^|\/)\.claude\.json$|(?:^|\/)\.gitconfig$/.test(filePath)) {
      return 'sensitive-file-read';
    }
    const commandReason = hardSafetyCommandReason(hardSafetyScanText(tool.command) || prompt)
      || (tool.argumentsUnvalidated && looksExecCapableToolName(tool.name) ? 'unvalidated-tool-arguments' : '');
    if (commandReason) return commandReason;
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

function buildRedirectResponse(project, panel, policy, classification, state, guardDeps, body, st) {
  const redirectMode = policy.redirect && policy.redirect.mode ? policy.redirect.mode : DEFAULT_POLICY.redirect.mode;
  if (!['warn', 'enforce'].includes(redirectMode)) return null;
  if (!safeForSyntheticRedirect(body, classification)) return null;
  // Defense in depth alongside the checkEnforcement-level short-circuit
  // (CODEX-IQA-R2 B5): that short-circuit is the primary fix (it also
  // prevents unrelated DOWNSTREAM budget checks from firing on the same
  // turn, which this function alone cannot do), but keeping this guard here
  // too costs nothing and means this function is independently correct.
  if (classification.terminalShape === 'real_user_text' && classification.directOperatorQuestion) return null;
  const exemptedClasses = boundedOperatorReadClasses(classification, st, policy, body);
  if (exemptedClasses) {
    // R13 BLOCKER 1: burn the one-shot for EVERY class this call consumed;
    // recording only the classified one would let the next turn re-spend the
    // others.
    if (st) {
      st.boundedReadClassesUsed = st.boundedReadClassesUsed || new Set();
      for (const cls of exemptedClasses) st.boundedReadClassesUsed.add(cls);
    }
    return null;
  }
  if (isBoundedDispatchConfirmation(classification, st, body)) {
    st.dispatchConfirmClassesUsed = st.dispatchConfirmClassesUsed || new Set();
    st.dispatchConfirmClassesUsed.add(classification.commandClass);
    return null;
  }

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

  // CODEX-IQA-R2 B5: a genuine inbound operator question (real_user_text,
  // question-shaped) must never be redirect- OR budget-blocked, no matter
  // what commandClass/topic its own prompt text happens to match. Round 2's
  // fix only guarded buildRedirectResponse; a LATER, separate check further
  // down this same function (e.g. orch-assignment-budget) still fired on the
  // same turn, because that check has no knowledge of buildRedirectResponse's
  // decision. Promoting the short-circuit to here means it exits the ENTIRE
  // downstream decision surface for this turn, not just one function. Hard
  // safety (checked unconditionally above, before this point) is deliberately
  // NOT bypassed by this -- an operator question is never a vector to skip a
  // real safety block, and by the time we reach here that check has already
  // run and (if it found something) already returned.
  if (classification.terminalShape === 'real_user_text' && classification.directOperatorQuestion) {
    return null;
  }

  const redirect = redirectEligible ? buildRedirectResponse(project, panel, policy, classification, state, guardDeps, body, st) : null;
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

module.exports.__test = { commandTopLevelSegmentsWithOps, reachableTopLevelSegments, dispatchOkLaundersPoll, stageIsDispatchAction, stageCarriesPollSubject, commandHasUnresolvableSubstitution, curlStageIsPlainGet, protectedClassesInCommand, hardSafetyReason, hardSafetyScanText, shellTokenize, joinLineContinuations, parseCommandSegment, segmentArgTokens, splitEnvDashSValue, pipeStages, commandPipelineSegments, commandTopLevelSegments, stageHasFollowFlag, isBoundedReadCommand, sensitiveReadIsProvablyPathOnly, isSingleSessionStatusRead, commandRunsDispatchAction, hasAtMostOneSubjectSegment, stripPatternArgs, stripMiserCompoundIdentifiers, questionMentionsTopic };
