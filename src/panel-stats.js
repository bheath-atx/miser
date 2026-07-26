'use strict';

const _panels = new Map();

function normalizeRaw(raw) {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite1h: 0, cacheWrite5m: 0 };
  if (!raw || typeof raw !== 'object') return out;
  if (Number.isFinite(raw.input_tokens) && raw.input_tokens > 0)
    out.input = raw.input_tokens;
  if (Number.isFinite(raw.output_tokens) && raw.output_tokens > 0)
    out.output = raw.output_tokens;
  if (Number.isFinite(raw.cache_read_input_tokens) && raw.cache_read_input_tokens > 0)
    out.cacheRead = raw.cache_read_input_tokens;
  const creation = (raw.cache_creation && typeof raw.cache_creation === 'object')
    ? raw.cache_creation : {};
  if (Number.isFinite(creation.ephemeral_1h_input_tokens) && creation.ephemeral_1h_input_tokens > 0) {
    out.cacheWrite1h = creation.ephemeral_1h_input_tokens;
  } else if (Number.isFinite(raw.cache_creation_input_tokens) && raw.cache_creation_input_tokens > 0) {
    out.cacheWrite1h = raw.cache_creation_input_tokens;
  }
  if (Number.isFinite(creation.ephemeral_5m_input_tokens) && creation.ephemeral_5m_input_tokens > 0)
    out.cacheWrite5m = creation.ephemeral_5m_input_tokens;
  return out;
}

function recordPanelUsage(project, panel, rawUsage) {
  if (!project || typeof project !== 'string' || !panel || typeof panel !== 'string') return;
  const key = `${project}--${panel}`;
  let bucket = _panels.get(key);
  if (!bucket) {
    bucket = { input: 0, output: 0, cacheRead: 0, cacheWrite1h: 0, cacheWrite5m: 0, requests: 0, lastSeenAt: null };
    _panels.set(key, bucket);
  }
  const norm = normalizeRaw(rawUsage);
  bucket.input      += norm.input;
  bucket.output     += norm.output;
  bucket.cacheRead  += norm.cacheRead;
  bucket.cacheWrite1h += norm.cacheWrite1h;
  bucket.cacheWrite5m += norm.cacheWrite5m;
  bucket.requests   += 1;
  bucket.lastSeenAt = new Date().toISOString();
}

function getPanelStats() {
  const out = {};
  for (const [key, bucket] of _panels) out[key] = { ...bucket };
  return out;
}

function __resetForTest() {
  _panels.clear();
}

module.exports = { recordPanelUsage, getPanelStats, __resetForTest };
