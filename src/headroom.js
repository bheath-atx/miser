'use strict';

// Independent per-block library calls over a local HTTP adapter. No transcript,
// query, session identifier, replay memo, or CCR state crosses this boundary.
const http = require('node:http');
// Corpus counts and the required DENIED exception are documented in PROPOSAL.md.
const STATUS = /\b(?:WITHHELD|NOT|FAIL|FAILED|FAILURE|SKIP|SKIPPED|DENIED|BLOCKED|REJECTED|ERROR|WARNING|NEVER|WITHOUT|NO)\b/gi;
const COUNTS = /\b(?:tests?|pass(?:ed)?|fail(?:ed)?|skipp?(?:ed)?|errors?|warnings?)\s+\d+(?:\s*(?:\/|,|;|\r?\n)?\s+(?:tests?|pass(?:ed)?|fail(?:ed)?|skipp?(?:ed)?|errors?|warnings?)\s+\d+)+\b/i;

function parseHeadroomConfig(env = {}) {
  const enabled = /^(1|true|on|yes)$/i.test(env.MISER_HEADROOM || '');
  const endpoint = env.MISER_HEADROOM_URL || 'http://127.0.0.1:20129/v1/compress';
  const targetRatio = Number(env.MISER_HEADROOM_TARGET_RATIO || '0.5');
  const timeoutMs = Number(env.MISER_HEADROOM_TIMEOUT_MS || '2000');
  const maxBytes = 1024 * 1024;
  if (enabled) {
    const u = new URL(endpoint);
    if (u.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(u.hostname)
        || u.username || u.password || u.pathname !== '/v1/compress' || u.search || u.hash) {
      throw new Error('MISER_HEADROOM_URL must be a literal loopback HTTP /v1/compress endpoint');
    }
    if (!(targetRatio > 0 && targetRatio <= 1) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
      throw new Error('Invalid Headroom target ratio or timeout');
    }
  }
  return { enabled, endpoint, targetRatio, timeoutMs, maxBytes };
}

function postBlock(cfg, text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ text, target_ratio: cfg.targetRatio });
    const req = http.request(cfg.endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, res => {
      let size = 0;
      const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > cfg.maxBytes) { res.destroy(new Error('Headroom response too large')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error(`Headroom HTTP ${res.statusCode}`);
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (typeof result.compressed !== 'string') throw new Error('Invalid Headroom response');
          resolve(result.compressed);
        } catch (err) { reject(err); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Headroom deadline')), cfg.timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(payload);
  });
}

function protectedCounts(text) {
  const counts = new Map();
  for (const match of text.matchAll(STATUS)) counts.set(match[0], (counts.get(match[0]) || 0) + 1);
  return counts;
}

function createHeadroomFilter(cfg, deps = {}) {
  const run = deps.compress || (text => postBlock(cfg, text));
  async function compressText(text) {
    if (text.trim().split(/\s+/).length < 64 || Buffer.byteLength(text) > cfg.maxBytes || COUNTS.test(text)) return text;
    try {
      const output = await run(text);
      if (typeof output !== 'string' || !output.trim() || Buffer.byteLength(output) >= Buffer.byteLength(text)) return text;
      const before = protectedCounts(text), after = protectedCounts(output);
      for (const [token, count] of before) if ((after.get(token) || 0) < count) return text;
      return output;
    } catch (_) { return text; }
  }
  async function applyToMessages(messages) {
    if (!cfg.enabled || !Array.isArray(messages)) return { messages, changed: false };
    let changed = false;
    const out = messages.slice();
    for (let i = 1; i < messages.length; i++) {
      const msg = messages[i], prev = messages[i - 1];
      if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)
          || !prev || prev.role !== 'assistant' || !Array.isArray(prev.content)) continue;
      const ids = new Set(prev.content.filter(b => b && b.type === 'tool_use').map(b => b.id));
      const blocks = msg.content.slice();
      let msgChanged = false;
      for (let j = 0; j < blocks.length; j++) {
        const b = blocks[j];
        if (!b || b.type !== 'tool_result' || !ids.has(b.tool_use_id)) continue;
        // Preserve images, structured results, metadata, and text-part boundaries.
        let content = b.content;
        if (typeof content === 'string') content = await compressText(content);
        else if (Array.isArray(content) && content.every(p => p && p.type === 'text' && typeof p.text === 'string')) {
          content = await Promise.all(content.map(async p => ({ ...p, text: await compressText(p.text) })));
          if (content.every((p, k) => p.text === b.content[k].text)) content = b.content;
        }
        if (content !== b.content) { blocks[j] = { ...b, content }; msgChanged = true; }
      }
      if (msgChanged) { out[i] = { ...msg, content: blocks }; changed = true; }
    }
    return { messages: changed ? out : messages, changed };
  }
  return { applyToMessages };
}
module.exports = { parseHeadroomConfig, createHeadroomFilter, postBlock };
