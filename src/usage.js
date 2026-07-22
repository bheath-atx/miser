'use strict';

function finiteNumber(v) {
  return Number.isFinite(v) ? v : null;
}

function mergeUsage(target, usage) {
  if (!usage || typeof usage !== 'object') return;
  for (const [from, to] of [
    ['input_tokens', 'input_tokens'],
    ['output_tokens', 'output_tokens'],
    ['cache_read_input_tokens', 'cache_read_input_tokens'],
    ['cache_creation_input_tokens', 'cache_creation_input_tokens'],
  ]) {
    const value = finiteNumber(usage[from]);
    if (value !== null) target[to] = value;
  }
  if (usage.cache_creation && typeof usage.cache_creation === 'object') {
    if (!target.cache_creation) target.cache_creation = {};
    for (const key of ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']) {
      const value = finiteNumber(usage.cache_creation[key]);
      if (value !== null) target.cache_creation[key] = value;
    }
  }
}

function collectAppliedEdits(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.context_management && Array.isArray(value.context_management.applied_edits)) {
    return value.context_management.applied_edits;
  }
  if (value.delta && value.delta.context_management && Array.isArray(value.delta.context_management.applied_edits)) {
    return value.delta.context_management.applied_edits;
  }
  if (Array.isArray(value.applied_edits)) return value.applied_edits;
  return null;
}

class AnthropicUsageParser {
  constructor(opts = {}) {
    this.isSSE = !!opts.isSSE;
    this.buffer = '';
    this.jsonChunks = [];
    this.usage = {};
    this.appliedEdits = null;
    this.model = opts.model || 'unknown';
    this.failed = false;
    this.warned = false;
  }

  warn(err) {
    if (this.warned) return;
    this.warned = true;
    console.warn(`[miser] usage parser skipped: ${err.message}`);
  }

  observeChunk(chunk) {
    if (this.failed) return;
    try {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (this.isSSE) this.observeSSE(text);
      else this.jsonChunks.push(text);
    } catch (err) {
      this.failed = true;
      this.warn(err);
    }
  }

  observeSSE(text) {
    this.buffer += text;
    for (;;) {
      const idx = this.buffer.indexOf('\n\n');
      if (idx === -1) return;
      const eventText = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.parseEvent(eventText);
    }
  }

  parseEvent(eventText) {
    const dataLines = [];
    for (const line of eventText.split(/\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    if (data === '[DONE]') return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      this.warn(err);
      return;
    }
    this.observeObject(parsed);
  }

  observeObject(parsed) {
    if (!parsed || typeof parsed !== 'object') return;
    if (parsed.message && parsed.message.model) this.model = parsed.message.model;
    if (parsed.model) this.model = parsed.model;
    if (parsed.message && parsed.message.usage) mergeUsage(this.usage, parsed.message.usage);
    if (parsed.usage) mergeUsage(this.usage, parsed.usage);
    const appliedEdits = collectAppliedEdits(parsed);
    if (appliedEdits) this.appliedEdits = appliedEdits;
  }

  finish() {
    if (this.failed) return { usage: null, appliedEdits: null, model: this.model };
    if (!this.isSSE) {
      const raw = this.jsonChunks.join('');
      if (raw.trim()) {
        try {
          this.observeObject(JSON.parse(raw));
        } catch (err) {
          this.warn(err);
        }
      }
    }
    if (Object.keys(this.usage).length === 0 && !this.appliedEdits) {
      return { usage: null, appliedEdits: null, model: this.model };
    }
    return { usage: this.usage, appliedEdits: this.appliedEdits, model: this.model };
  }
}

module.exports = { AnthropicUsageParser, mergeUsage, collectAppliedEdits };
