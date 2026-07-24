'use strict';

const https = require('node:https');
const http = require('node:http');
const { translateToOllama, translateOllamaStream } = require('./translate.js');
const { translateToOpenAI, validateOpenAIRequest } = require('./translate-openai.js');
const { translateToResponses, validateResponsesRequest, translateResponsesStream } = require('./translate-responses.js');
const { hardCapOllamaBody } = require('./hardcap.js');
const { getCodexBearer } = require('./oauth.js');
const { recordUsage } = require('./quota.js');
const { recordAnthropicUsage } = require('./stats.js');
const { AnthropicUsageParser } = require('./usage.js');
const { createBreaker } = require('./circuit-breaker.js');
const config = require('./config.js');

const _legErrors = { anthropic: 0, codex: 0, ollama: 0 };

function incrementLegError(leg) {
  if (Object.prototype.hasOwnProperty.call(_legErrors, leg)) _legErrors[leg] += 1;
}

function getLegErrors() {
  return { ..._legErrors };
}

// Module-level breaker singletons — initialized once at require time from config.
// Tests override via deps.breakers; createProxy() does NOT accept breakerOpts.
const _breakers = {
  anthropic: createBreaker('anthropic', { threshold: config.breakerThreshold, resetMs: config.breakerResetMs }),
  codex:     createBreaker('codex',     { threshold: config.breakerThreshold, resetMs: config.breakerResetMs }),
  ollama:    createBreaker('ollama',    { threshold: config.breakerThreshold, resetMs: config.breakerResetMs }),
};

function getBreakers() {
  return _breakers;
}

// ---------------------------------------------------------------------------
// Retry + breaker helpers
// ---------------------------------------------------------------------------

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Two-point res.headersSent guard (normative §2.3B):
// 1. Top-of-loop: before any sleep — catches synchronous header-set during fn()
// 2. Post-sleep: before next fn() call — catches async races during await sleep()
async function retryWithBackoff(fn, res, opts = {}) {
  const maxAttempts = opts.maxAttempts || 3;
  const baseMs = opts.baseMs || 200;
  const jitter = opts.jitterFn || (() => Math.random());
  const sleep = opts.sleepFn || defaultSleep;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (res.headersSent) throw lastErr || new Error('headers sent; retry aborted');
    if (attempt > 0) {
      const delay = baseMs * Math.pow(2, attempt - 1) * (0.5 + jitter() * 0.5);
      await sleep(delay);
      // GUARD: check again after sleep — another async path may have set headersSent
      if (res.headersSent) throw lastErr || new Error('headers sent during backoff; retry aborted');
    }
    try {
      return await fn();
    } catch (err) {
      if (!err.retryable) throw err; // non-retryable: propagate immediately
      lastErr = err;
    }
  }
  throw lastErr; // all attempts exhausted
}

// Fail-open wrappers — a throwing breaker defaults to CLOSED and logs a warning.
function safeAcquire(breaker) {
  try { return breaker.acquire(); }
  catch (e) {
    console.warn('[miser] breaker.acquire error (fail-open):', e.message);
    return true;
  }
}

function safeRecord(breaker, method) {
  try { breaker[method](); }
  catch (e) { console.warn(`[miser] breaker.${method} error:`, e.message); }
}

// Extract nowMs from guardDeps.nowFn (returns a Date) or fallback to new Date().
function _nowMs(guardDeps) {
  return ((guardDeps.nowFn || (() => new Date()))()).getTime();
}

// Fire-and-forget sub-cap alert — synchronous section wrapped in try/catch so
// a tracker or ledger exception can never escape to the Codex success/429 path.
function _maybeAlertSubCap(guardDeps, nowMs) {
  if (!guardDeps || !guardDeps.subCapTracker) return;
  let status;
  try {
    status = guardDeps.subCapTracker.getStatus(nowMs);
    if (!status.shouldAlert) return;
    if (!guardDeps.ledger || !guardDeps.ledger.shouldSend('subcap:codex:80pct')) return;
    guardDeps.ledger.markSent('subcap:codex:80pct');
  } catch (e) {
    console.warn('[miser] _maybeAlertSubCap sync error (ignored):', e.message);
    return;
  }
  const sendAlert = guardDeps.sendAlert || require('./daily-rollup.js').sendAlert;
  const pctMsg = `Codex ${Math.round(status.capFraction * 100)}% of ${status.cap5h}-req 5h cap`;
  const events429Msg = status.events429In5h > 0 ? ` — ${status.events429In5h} 429s observed` : '';
  Promise.resolve()
    .then(() => sendAlert(`⚠️ miser sub-cap: ${pctMsg}${events429Msg} — deferBackground=true`))
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Failover chain (anthropic format):
//
//   Anthropic          --429 or OPEN-->  Codex/OpenAI (subscription OAuth)
//   Codex/OpenAI       --429/5xx/OPEN->  hard-capped Ollama
//   Ollama             --OPEN--------->  503 to client
//
// G4 retry: 529/5xx/connect-errors are retried up to retryMaxAttempts before
// the leg is considered exhausted. 429 is NOT retried.
// G4 breakers: per-upstream CLOSED/OPEN/HALF_OPEN; only retryable failures count.
// B3: Codex successes + 429s are recorded in the sub-cap tracker (when enabled).
//
// Every network leg goes through an injectable transport seam so the offline
// test harness can drive the whole chain with zero sockets.
// ---------------------------------------------------------------------------

function defaultDeps() {
  return {
    transports: {
      anthropic: forwardToAnthropic,
      openaiPassthrough: forwardToOpenAI,
      codex: forwardToCodex,
      ollama: forwardToOllama,
    },
    getBearer: getCodexBearer,
    ollamaCap: config.ollamaHardCap,
  };
}

async function routeRequest(messages, originalBody, incomingHeaders, res, project, savedTokens, format = 'anthropic', deps = {}) {
  const base = defaultDeps();
  const transports = { ...base.transports, ...(deps.transports || {}) };
  const getBearer = deps.getBearer || base.getBearer;
  const ollamaCap = deps.ollamaCap != null ? deps.ollamaCap : base.ollamaCap;
  const guardDeps = deps.guardDeps;

  // Merge injected breakers for tests; production uses module-level singletons.
  const breakers = { ..._breakers, ...(deps.breakers || {}) };

  const retryOpts = {
    maxAttempts: (deps.retryOpts && deps.retryOpts.maxAttempts) || config.retryMaxAttempts,
    baseMs:      (deps.retryOpts && deps.retryOpts.baseMs)      || config.retryBaseMs,
    sleepFn:     deps.retryOpts && deps.retryOpts.sleepFn,  // undefined → defaultSleep
    jitterFn:    deps.retryOpts && deps.retryOpts.jitterFn, // undefined → Math.random
  };

  if (format === 'openai') {
    // Already-OpenAI-format request: passthrough, Ollama on 429. (Unchanged
    // legacy path — no Codex leg, the caller is already speaking OpenAI.)
    try {
      await transports.openaiPassthrough(messages, originalBody, incomingHeaders, res, project, savedTokens);
    } catch (err) {
      incrementLegError('codex');
      if (err.statusCode === 429 && !res.headersSent) {
        console.log('[miser] OpenAI 429 — falling back to hard-capped Ollama');
        try {
          await transports.ollama(messages, originalBody, res, project, savedTokens, { cap: ollamaCap });
        } catch (ollamaErr) {
          incrementLegError('ollama');
          throw ollamaErr;
        }
      } else throw err;
    }
    return;
  }

  // --- Anthropic path ------------------------------------------------------
  if (safeAcquire(breakers.anthropic)) {
    try {
      await retryWithBackoff(
        () => transports.anthropic(messages, originalBody, incomingHeaders, res, project, savedTokens, guardDeps),
        res, retryOpts
      );
      safeRecord(breakers.anthropic, 'recordSuccess');
      return;
    } catch (err) {
      incrementLegError('anthropic');
      if (res.headersSent) throw err; // streaming started — cannot recover
      if (err.retryable) safeRecord(breakers.anthropic, 'recordFailure');
      if (err.statusCode !== 429) throw err; // non-429 (5xx after retries) → error to client
      // is 429 + headers not sent → fall through to Codex leg
      console.log('[miser] Anthropic 429 — trying Codex/OpenAI (subscription OAuth)');
    }
  } else {
    console.log('[miser] Anthropic breaker OPEN — skipping to Codex');
  }

  // --- Leg 2: Codex via subscription OAuth ---------------------------------
  if (safeAcquire(breakers.codex)) {
    try {
      const bearer = await getBearer(); // fail closed: throws if no valid token
      const useChat = config.codexFormat === 'chat';
      const codexReq = useChat
        ? translateToOpenAI(messages, originalBody)
        : translateToResponses(messages, originalBody);
      const check = useChat ? validateOpenAIRequest(codexReq) : validateResponsesRequest(codexReq);
      if (!check.valid) {
        const e = new Error(`miser: refusing malformed Codex request: ${check.error}`);
        e.statusCode = 400;
        throw e;
      }
      await retryWithBackoff(
        () => transports.codex(codexReq, bearer, res, project, savedTokens),
        res, retryOpts
      );
      // B3: record Codex success and maybe alert on cap proximity
      if (guardDeps && guardDeps.subCapTracker) {
        const nowMs = _nowMs(guardDeps);
        guardDeps.subCapTracker.recordSuccess(nowMs);
        _maybeAlertSubCap(guardDeps, nowMs);
      }
      safeRecord(breakers.codex, 'recordSuccess');
      return;
    } catch (err) {
      incrementLegError('codex');
      if (res.headersSent) throw err; // response already streaming — can't fail over
      // Normative catch ordering (R3):
      // 1. Subscription cap (429): B3 event + alert; fall through to Ollama; no breaker record
      if (err.statusCode === 429) {
        if (guardDeps && guardDeps.subCapTracker) {
          const nowMs = _nowMs(guardDeps);
          guardDeps.subCapTracker.record429(nowMs);
          _maybeAlertSubCap(guardDeps, nowMs);
        }
        console.log('[miser] Codex 429 — hard-capped Ollama fallback');
        // fall through to Ollama
      } else if (err.statusCode === 401 || err.statusCode === 403 || err.statusCode === 400) {
        // Auth/client errors: NOT retried, NOT a B3 event, NOT a breaker event.
        // Fall through to Ollama — existing contract (test/failover.test.js:90-119).
        console.log(`[miser] Codex auth/client error (${err.statusCode}) — Ollama fallback`);
        // fall through to Ollama
      } else if (err.retryable) {
        // 5xx / connect-error after retries exhausted: record breaker failure; fall through
        safeRecord(breakers.codex, 'recordFailure');
        console.log(`[miser] Codex/OpenAI unavailable (${err.statusCode || err.message}) — Ollama fallback`);
        // fall through to Ollama
      } else {
        // Unknown error shape: propagate
        throw err;
      }
    }
  } else {
    console.log('[miser] Codex breaker OPEN — skipping to Ollama');
  }

  // --- Leg 3: hard-capped Ollama ------------------------------------------
  if (safeAcquire(breakers.ollama)) {
    try {
      await transports.ollama(messages, originalBody, res, project, savedTokens, { cap: ollamaCap });
      safeRecord(breakers.ollama, 'recordSuccess');
    } catch (err) {
      incrementLegError('ollama');
      // Only retryable errors (connect-errors, transport failures) count against the breaker.
      if (err.retryable) safeRecord(breakers.ollama, 'recordFailure');
      throw err;
    }
  } else {
    incrementLegError('ollama');
    const err = new Error('miser: all upstreams unavailable (ollama breaker OPEN)');
    err.statusCode = 503;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Production transports (real sockets). Not exercised by the offline harness.
// ---------------------------------------------------------------------------

function teardownResponse(res, err) {
  try {
    if (res.destroyed) return;
    if (typeof res.destroy === 'function') res.destroy(err);
    else if (!res.writableEnded) res.end();
  } catch (_) { /* best effort */ }
}

function proxyAnthropicResponse(upstream, res, originalBody, project, savedTokens, resolve, reject, guardDeps) {
  const statusCode = upstream.statusCode;
  const contentType = upstream.headers['content-type'] || 'application/json';
  const parser = new AnthropicUsageParser({
    isSSE: /^text\/event-stream\b/i.test(contentType),
    model: originalBody.model || 'unknown',
  });
  let parserWarned = false;
  function warnParser(err) {
    if (parserWarned) return;
    parserWarned = true;
    console.warn(`[miser] usage parser skipped: ${err.message}`);
  }

  res.writeHead(statusCode, {
    'content-type': contentType,
    'x-miser-provider': 'anthropic',
    'x-miser-model': originalBody.model || 'unknown',
    'x-miser-saved-tokens': String(savedTokens),
  });

  upstream.on('data', (chunk) => {
    try {
      parser.observeChunk(chunk);
    } catch (err) {
      parser.failed = true;
      warnParser(err);
    }
    res.write(chunk);
  });
  upstream.on('end', () => {
    res.end();
    if (statusCode >= 200 && statusCode < 300) {
      let parsed = null;
      try {
        parsed = parser.finish();
      } catch (err) {
        warnParser(err);
      }
      const model = (parsed && parsed.model) || originalBody.model || 'unknown';
      recordUsage(project, 'anthropic', model);
      if (parsed && (parsed.usage || parsed.appliedEdits)) {
        recordAnthropicUsage(project, 'anthropic', model, parsed.usage || {}, parsed.appliedEdits);
      }
      if (guardDeps && guardDeps.checkContextBloat) {
        Promise.resolve()
          .then(() => guardDeps.checkContextBloat(project, model, parsed && parsed.usage, guardDeps))
          .catch(e => console.warn('[miser] bloat check error:', e.message));
      }
    }
    resolve({ statusCode });
  });
  upstream.on('error', (e) => { teardownResponse(res, e); reject(e); });
}

function forwardToAnthropic(messages, originalBody, incomingHeaders, res, project, savedTokens, guardDeps) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(originalBody);
    const anthURL = new URL(config.anthropicUrl);
    const options = {
      hostname: anthURL.hostname,
      port: anthURL.port || (anthURL.protocol === 'https:' ? 443 : 80),
      path: (anthURL.pathname === '/' ? '' : anthURL.pathname) + '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'anthropic-version': incomingHeaders['anthropic-version'] || '2023-06-01',
      },
    };

    if (incomingHeaders['x-api-key']) options.headers['x-api-key'] = incomingHeaders['x-api-key'];
    if (incomingHeaders['authorization']) options.headers['authorization'] = incomingHeaders['authorization'];
    if (incomingHeaders['anthropic-beta']) options.headers['anthropic-beta'] = incomingHeaders['anthropic-beta'];

    const anthTransport = anthURL.protocol === 'https:' ? https : http;
    const req = anthTransport.request(options, (upstream) => {
      if (upstream.statusCode === 429) {
        const err = new Error('anthropic quota exhausted');
        err.statusCode = 429;
        upstream.resume();
        reject(err);
        return;
      }
      // §2.3A (M3 visual inspection): 529/5xx intercepted BEFORE proxyAnthropicResponse.
      // upstream.resume() drains the body; proxyAnthropicResponse is never invoked;
      // res.writeHead() is NOT called by this path (headersSent stays false → retry possible).
      if (upstream.statusCode === 529
          || (upstream.statusCode >= 500 && upstream.statusCode <= 599)) {
        const err = new Error(`anthropic ${upstream.statusCode}`);
        err.statusCode = upstream.statusCode;
        err.retryable = true;
        upstream.resume(); // drain body — do NOT pipe
        reject(err);
        return;
      }
      proxyAnthropicResponse(upstream, res, originalBody, project, savedTokens, resolve, reject, guardDeps);
    });

    req.on('error', (err) => { err.retryable = true; reject(err); });
    req.write(body);
    req.end();
  });
}

// Legacy passthrough for requests that ARRIVE already in OpenAI format.
function forwardToOpenAI(messages, originalBody, incomingHeaders, res, project, savedTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(originalBody);
    const options = {
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    };
    if (incomingHeaders['authorization']) options.headers['authorization'] = incomingHeaders['authorization'];

    const req = https.request(options, (upstream) => {
      if (upstream.statusCode === 429) {
        const err = new Error('openai quota exhausted');
        err.statusCode = 429;
        upstream.resume();
        reject(err);
        return;
      }
      res.writeHead(upstream.statusCode, {
        'content-type': upstream.headers['content-type'] || 'application/json',
        'x-miser-provider': 'openai',
        'x-miser-model': originalBody.model || 'unknown',
        'x-miser-saved-tokens': String(savedTokens),
      });
      upstream.pipe(res);
      upstream.on('end', () => { recordUsage(project, 'openai', originalBody.model || 'unknown'); resolve(); });
      upstream.on('error', (e) => { teardownResponse(res, e); reject(e); });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Codex failover transport. On 5xx, marks retryable so the retry wrapper fires.
// On 401/403/400/429, retryable stays false — propagates immediately to the
// routeRequest catch which routes each code appropriately.
function forwardToCodex(codexReq, bearer, res, project, savedTokens) {
  return new Promise((resolve, reject) => {
    const url = new URL(config.codexUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify(codexReq);
    const isResponses = config.codexFormat !== 'chat';
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'authorization': `Bearer ${bearer.token}`,
      'accept': isResponses ? 'text/event-stream' : 'application/json',
    };
    if (bearer.accountId) headers['chatgpt-account-id'] = bearer.accountId;
    if (isResponses) {
      if (config.codexOriginator) headers['originator'] = config.codexOriginator;
      if (config.codexUserAgent) headers['user-agent'] = config.codexUserAgent;
      if (config.codexClientVersion) headers['version'] = config.codexClientVersion;
    }

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers,
    };

    const req = transport.request(options, (upstream) => {
      if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
        const statusCode = upstream.statusCode;
        const err = new Error(`codex non-2xx ${statusCode}`);
        err.statusCode = statusCode;
        if (statusCode >= 500 && statusCode <= 599) err.retryable = true;
        // 401/403/400/429 → retryable stays false → immediate propagation out of retry wrapper
        upstream.resume();
        reject(err);
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-miser-provider': 'codex',
        'x-miser-model': codexReq.model || 'unknown',
        'x-miser-saved-tokens': String(savedTokens),
      });
      if (isResponses) {
        translateResponsesStream(upstream, res, codexReq.model || 'codex');
      } else {
        upstream.pipe(res);
      }
      upstream.on('end', () => { recordUsage(project, 'codex', codexReq.model || 'unknown'); resolve(); });
      upstream.on('error', (e) => { teardownResponse(res, e); reject(e); });
    });

    req.on('error', (err) => { err.retryable = true; reject(err); });
    req.write(body);
    req.end();
  });
}

function forwardToOllama(messages, originalBody, res, project, savedTokens, opts = {}) {
  return new Promise((resolve, reject) => {
    const model = config.fallbackModels[0];
    const translated = translateToOllama(messages, originalBody, model);
    const cap = opts.cap != null ? opts.cap : config.ollamaHardCap;
    const ollamaBody = hardCapOllamaBody(translated, cap);
    const bodyStr = JSON.stringify(ollamaBody);
    const ollamaUrl = new URL('/api/chat', config.ollamaUrl);
    const transport = ollamaUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: ollamaUrl.hostname,
      port: ollamaUrl.port || (ollamaUrl.protocol === 'https:' ? 443 : 80),
      path: ollamaUrl.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(bodyStr),
      },
    };

    const req = transport.request(options, (upstream) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-miser-provider': 'ollama',
        'x-miser-model': model,
        'x-miser-saved-tokens': String(savedTokens),
      });
      translateOllamaStream(upstream, res, model);
      upstream.on('end', () => { recordUsage(project, 'ollama', model); resolve(); });
      upstream.on('error', (e) => { teardownResponse(res, e); reject(e); });
    });

    req.on('error', (err) => { err.retryable = true; reject(err); });
    req.write(bodyStr);
    req.end();
  });
}

module.exports = {
  routeRequest,
  proxyAnthropicResponse,
  forwardToAnthropic,
  forwardToOpenAI,
  forwardToCodex,
  forwardToOllama,
  teardownResponse,
  getLegErrors,
  getBreakers,
  __test: {
    _legErrors,
    _breakers,
    safeAcquire,
    safeRecord,
    retryWithBackoff,
    _maybeAlertSubCap,
  },
  _buildCappedOllamaBody: (messages, originalBody, cap) =>
    hardCapOllamaBody(translateToOllama(messages, originalBody, config.fallbackModels[0]), cap),
};
