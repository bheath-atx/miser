'use strict';

const { isValidProjectName } = require('./routing.js');

const BETA = 'context-management-2025-06-27';
const EDIT_TYPE = 'clear_tool_uses_20250919';
const DEFAULT_KNOBS = Object.freeze({
  trigger: 60000,
  keep: 5,
  clearAtLeast: 20000,
});
const ALLOWED_KEYS = new Set(['trigger', 'keep', 'clearAtLeast', 'excludeTools']);

function plainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function warnOnce(warnings, msg) {
  warnings.push(msg);
  console.warn(`[miser] context-management disabled: ${msg}`);
}

function validInt(n, min, max) {
  return Number.isInteger(n) && n >= min && (max == null || n <= max);
}

function validateKnobs(project, value, warnings) {
  if (value === true) return { ...DEFAULT_KNOBS };
  if (!plainObject(value)) {
    warnOnce(warnings, `project ${project} has invalid config value`);
    return null;
  }

  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      warnOnce(warnings, `project ${project} has unknown key ${key}`);
      return null;
    }
  }

  const knobs = { ...DEFAULT_KNOBS };
  if ('trigger' in value) knobs.trigger = value.trigger;
  if ('keep' in value) knobs.keep = value.keep;
  if ('clearAtLeast' in value) knobs.clearAtLeast = value.clearAtLeast;
  if ('excludeTools' in value) knobs.excludeTools = value.excludeTools;

  if (!validInt(knobs.trigger, 10000)) {
    warnOnce(warnings, `project ${project} trigger out of bounds`);
    return null;
  }
  if (!validInt(knobs.keep, 1, 20)) {
    warnOnce(warnings, `project ${project} keep out of bounds`);
    return null;
  }
  if (!validInt(knobs.clearAtLeast, 5000)) {
    warnOnce(warnings, `project ${project} clearAtLeast out of bounds`);
    return null;
  }
  if (knobs.excludeTools !== undefined) {
    if (!Array.isArray(knobs.excludeTools) || knobs.excludeTools.length > 50
      || !knobs.excludeTools.every(s => typeof s === 'string' && s.length <= 128)) {
      warnOnce(warnings, `project ${project} excludeTools out of bounds`);
      return null;
    }
    knobs.excludeTools = knobs.excludeTools.slice();
  }
  return knobs;
}

function parseContextEditProjects(raw = process.env.MISER_CONTEXT_EDIT_PROJECTS || '') {
  const warnings = [];
  if (!raw) return { projects: {}, warnings };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    warnOnce(warnings, 'MISER_CONTEXT_EDIT_PROJECTS is malformed JSON');
    return { projects: {}, warnings };
  }
  if (!plainObject(parsed)) {
    warnOnce(warnings, 'MISER_CONTEXT_EDIT_PROJECTS must be a JSON object');
    return { projects: {}, warnings };
  }

  const projects = {};
  for (const [project, value] of Object.entries(parsed)) {
    if (!isValidProjectName(project)) {
      warnOnce(warnings, `invalid project key ${project}`);
      continue;
    }
    const knobs = validateKnobs(project, value, warnings);
    if (knobs) projects[project] = knobs;
  }
  return { projects, warnings };
}

function buildContextManagement(knobs) {
  const edit = {
    type: EDIT_TYPE,
    trigger: { type: 'input_tokens', value: knobs.trigger },
    keep: { type: 'tool_uses', value: knobs.keep },
    clear_at_least: { type: 'input_tokens', value: knobs.clearAtLeast },
  };
  if (knobs.excludeTools) edit.exclude_tools = knobs.excludeTools.slice();
  return { edits: [edit] };
}

function mergeBetaHeader(existing) {
  const parts = String(existing || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!parts.includes(BETA)) parts.push(BETA);
  return parts.join(',');
}

function injectContextManagement(body, headers, project, projects) {
  if (!projects || !projects[project]) return { body, headers, injected: false };
  if (body && body.context_management) return { body, headers, injected: false };
  const outBody = { ...body, context_management: buildContextManagement(projects[project]) };
  const outHeaders = { ...headers, 'anthropic-beta': mergeBetaHeader(headers['anthropic-beta']) };
  return { body: outBody, headers: outHeaders, injected: true };
}

module.exports = {
  BETA,
  DEFAULT_KNOBS,
  parseContextEditProjects,
  buildContextManagement,
  mergeBetaHeader,
  injectContextManagement,
};
