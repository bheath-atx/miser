'use strict';

// In-memory quota tracking per TermDeck project tag.
// Resets on process restart; persistent tracking is Phase 3.
const _usage = new Map();

function recordUsage(project, provider, model) {
  const cur = _usage.get(project) || { requests: 0, providers: {} };
  cur.requests++;
  cur.providers[provider] = (cur.providers[provider] || 0) + 1;
  cur.lastModel = model;
  cur.lastProvider = provider;
  cur.lastAt = new Date().toISOString();
  _usage.set(project, cur);
}

function getUsage(project) {
  return _usage.get(project) || null;
}

function getAllUsage() {
  const out = {};
  for (const [k, v] of _usage) out[k] = v;
  return out;
}

module.exports = { recordUsage, getUsage, getAllUsage };
