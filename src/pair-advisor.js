'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const { X509Certificate, timingSafeEqual, createHash } = require('node:crypto');
const { promptFor, validateAdvisorJson } = require('./orch-intent-classifier');

const PRECISION = Object.freeze({ name: 'precision', endpoint: 'https://100.115.118.29:11434', model: 'qwen3:4b' });
const PER730 = Object.freeze({ name: 'per730', endpoint: 'http://127.0.0.1:11434', model: 'qwen2.5:1.5b-instruct' });
const PEER_UUID = '5b0f111c-4f20-48b3-9387-b9fcf303bf9f';
const LOCAL_UUID = '8c7e7148-77a1-4be5-8242-b5529f44b5ee';
const DEFAULTS = Object.freeze({
  enabled: false, totalTimeoutMs: 20000, precisionTimeoutMs: 15000,
  fallbackTimeoutMs: 5000, livenessTtlMs: 30000, decisionTtlMs: 30000,
  maxConcurrent: 2, maxCacheEntries: 128,
});
const BOUNDS = {
  totalTimeoutMs: [100, 20000], precisionTimeoutMs: [50, 15000],
  fallbackTimeoutMs: [50, 5000], livenessTtlMs: [100, 60000],
  decisionTtlMs: [100, 60000], maxConcurrent: [1, 4], maxCacheEntries: [1, 256],
};

function parsePairAdvisor(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || Array.isArray(parsed) || parsed.enabled !== true) return null;
    if (Object.keys(parsed).some(k => !['enabled', 'configDir', ...Object.keys(BOUNDS)].includes(k))) return null;
    const config = { ...DEFAULTS, enabled: true };
    for (const [key, [min, max]] of Object.entries(BOUNDS)) {
      if (parsed[key] === undefined) continue;
      if (!Number.isSafeInteger(parsed[key]) || parsed[key] < min || parsed[key] > max) return null;
      config[key] = parsed[key];
    }
    if (parsed.configDir !== undefined) {
      if (typeof parsed.configDir !== 'string' || !path.isAbsolute(parsed.configDir)) return null;
      config.configDir = parsed.configDir;
    }
    return config;
  } catch (_) { return null; }
}

async function loadPrecisionIdentity(configDir, signal) {
  const root = configDir || path.join(os.homedir(), '.config', 'Nvidia Corporation', 'Personal AI Router');
  const read = async name => {
    const file = path.join(root, name);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 32768) throw new Error('invalid_identity_file');
    return fs.readFile(file, { encoding: 'utf8', signal });
  };
  const [identityText, settingsText, pinText, cert, key] = await Promise.all([
    read('cluster/identity.json'), read('settings.json'), read(`cluster/trusted/${PEER_UUID}.json`),
    read('cluster/node.crt'), read('cluster/node.key'),
  ]);
  const identity = JSON.parse(identityText);
  const settings = JSON.parse(settingsText);
  const pin = JSON.parse(pinText);
  if (identity.node_uuid !== LOCAL_UUID || pin.nodeUuid !== PEER_UUID
      || !settings.cluster_id || settings.cluster_id !== pin.clusterId) throw new Error('membership_mismatch');
  const pinned = new X509Certificate(pin.certPem);
  if (pinned.toLegacyObject().subject.CN !== PEER_UUID
      || new X509Certificate(cert).toLegacyObject().subject.CN !== LOCAL_UUID) throw new Error('identity_mismatch');
  return {
    ca: pin.certPem, cert, key, rejectUnauthorized: true,
    // PAIR certificates identify node UUIDs, not Tailscale IP addresses.
    // Normal CA/expiry validation stays enabled; require the exact peer pin too.
    checkServerIdentity(_host, presented) {
      if (!presented.raw || presented.raw.length !== pinned.raw.length
          || !timingSafeEqual(presented.raw, pinned.raw) || presented.subject?.CN !== PEER_UUID) {
        const error = new Error('PAIR peer identity mismatch');
        error.code = 'ERR_PAIR_PIN';
        return error;
      }
      return undefined;
    },
  };
}

const UNAVAILABLE_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EAI_AGAIN']);

// Entire attempt (including async identity reads and response body) is bounded
// by the caller's AbortSignal. No child process or synchronous I/O on this path.
async function infer(target, prompt, { signal, configDir, numPredict = 160 } = {}) {
  let tlsOptions = {};
  if (target.name === 'precision') {
    try { tlsOptions = await loadPrecisionIdentity(configDir, signal); }
    catch (_) { return { ok: false, reason: 'peer_trust_unavailable', unavailable: false }; }
  }
  if (signal?.aborted) return { ok: false, reason: 'deadline', unavailable: true };
  const payload = JSON.stringify({ model: target.model, prompt, format: 'json', stream: false, think: false,
    options: { temperature: 0, num_predict: numPredict, num_ctx: 4096 } });
  return new Promise(resolve => {
    let settled = false;
    const finish = result => { if (!settled) { settled = true; resolve(result); } };
    const transport = target.endpoint.startsWith('https:') ? https : http;
    const req = transport.request(`${target.endpoint}/api/generate`, {
      ...tlsOptions, method: 'POST', agent: false, signal,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, res => {
      let size = 0;
      const chunks = [];
      res.on('error', () => finish({ ok: false, reason: 'response_error', unavailable: true }));
      res.on('aborted', () => finish({ ok: false, reason: 'response_aborted', unavailable: true }));
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) {
          finish({ ok: false, reason: 'response_too_large', unavailable: false });
          req.destroy();
        } else chunks.push(chunk);
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          finish({ ok: false, reason: `http_${res.statusCode}`, unavailable: [408, 429, 502, 503, 504].includes(res.statusCode) });
          return;
        }
        let outer;
        try { outer = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* invalid below */ }
        if (outer?.done !== true || typeof outer.response !== 'string' || outer.response.length > 4096) {
          finish({ ok: false, reason: 'invalid_generation', unavailable: false });
        } else finish({ ok: true, text: outer.response, reason: 'inference_ok', unavailable: false });
      });
    });
    req.on('error', error => finish({ ok: false, reason: signal?.aborted ? 'deadline' : 'connection_error',
      unavailable: signal?.aborted || UNAVAILABLE_ERRORS.has(error.code) }));
    req.end(payload);
  });
}

function createPairClient(options = {}, deps = {}) {
  const config = { ...DEFAULTS, ...options };
  const now = deps.now || Date.now;
  const inference = deps.infer || infer;
  const liveness = new Map();
  let active = 0;

  async function attempt(target, prompt, timeoutMs, numPredict) {
    const cached = liveness.get(target.name);
    if (cached && !cached.ok && cached.expiresAt > now()) return { ...cached, cached: true };
    const started = now();
    const controller = new AbortController();
    let timer;
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => {
        resolve({ ok: false, reason: 'deadline', unavailable: true });
        controller.abort();
      }, timeoutMs);
    });
    let result;
    try {
      result = await Promise.race([
        Promise.resolve().then(() => inference(target, prompt, { signal: controller.signal, configDir: config.configDir, numPredict })),
        deadline,
      ]);
      if (!result || typeof result.ok !== 'boolean') result = { ok: false, reason: 'invalid_transport', unavailable: false };
    } catch (_) { result = { ok: false, reason: 'inference_error', unavailable: false }; }
    finally { clearTimeout(timer); }
    const stamp = { ok: result.ok, reason: result.reason, unavailable: result.unavailable === true,
      checkedAt: now(), expiresAt: now() + config.livenessTtlMs, elapsedMs: now() - started };
    liveness.set(target.name, stamp);
    return { ...result, ...stamp };
  }

  async function generate(prompt, { numPredict = 160 } = {}) {
    if (active >= config.maxConcurrent) return { ok: false, reason: 'capacity' };
    active++;
    const start = performance.now();
    const attempts = [];
    try {
      for (const target of [PRECISION, PER730]) {
        const remaining = config.totalTimeoutMs - (performance.now() - start);
        if (remaining <= 0) break;
        const budget = target === PRECISION ? config.precisionTimeoutMs : config.fallbackTimeoutMs;
        const result = await attempt(target, prompt, Math.min(budget, remaining), numPredict);
        attempts.push({ target: target.name, endpoint: target.endpoint, model: target.model,
          ok: result.ok, reason: result.reason, elapsed_ms: result.cached ? 0 : (result.elapsedMs || 0), cached: result.cached === true });
        // Malformed generations, authentication/configuration failures and
        // model opinions are not evidence the preferred GPU is unavailable.
        if (result.ok || !result.unavailable) return { ...result, target: target.name, attempts, elapsed_ms: Math.round(performance.now() - start) };
      }
      return { ok: false, reason: 'both_unavailable', attempts, elapsed_ms: Math.round(performance.now() - start) };
    } finally { active--; }
  }

  return { generate, snapshot: () => ({ active, targets: Object.fromEntries([...liveness].map(([name, value]) => [name,
    { ...value, fresh: value.expiresAt > now(), state: value.expiresAt <= now() ? 'stale'
      : value.ok ? 'healthy' : value.unavailable ? 'unavailable' : 'error' }])) }) };
}

function createPairAdvisor(options = {}, deps = {}) {
  const config = { ...DEFAULTS, ...options };
  const client = deps.client || createPairClient(config, deps);
  const now = deps.now || Date.now;
  const cache = new Map();
  const pending = new Map();
  async function classify(input) {
    const prompt = promptFor(input);
    const key = createHash('sha256').update(prompt).digest('hex');
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return { ...cached.result, cached: true };
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= config.maxConcurrent) return { ok: false, reason: 'capacity' };
    const work = (async () => {
      let result;
      try {
        const generated = await client.generate(prompt);
        const validated = generated.ok ? validateAdvisorJson(generated.text) : null;
        result = validated?.ok ? { ok: true, advisor: validated.value, target: generated.target }
          : { ok: false, reason: validated?.reason || generated.reason };
      } catch (_) { result = { ok: false, reason: 'advisor_error' }; }
      cache.delete(key);
      cache.set(key, { result, expiresAt: now() + config.decisionTtlMs });
      while (cache.size > config.maxCacheEntries) cache.delete(cache.keys().next().value);
      return result;
    })();
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  }
  return { classify, timeoutMs: config.totalTimeoutMs,
    snapshot: () => ({ ...client.snapshot(), cachedDecisions: cache.size, pending: pending.size }) };
}

module.exports = { parsePairAdvisor, createPairClient, createPairAdvisor, loadPrecisionIdentity, infer, DEFAULTS, PRECISION, PER730, PEER_UUID, LOCAL_UUID };
