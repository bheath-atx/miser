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
const config = require('./config.js');

const _legErrors = { anthropic: 0, codex: 0, ollama: 0 };

function incrementLegError(leg) {
  if (Object.prototype.hasOwnProperty.call(_legErrors, leg)) _legErrors[leg] += 1;
}

function getLegErrors() {
  return { ..._legErrors };
}

// ---------------------------------------------------------------------------
// Failover chain (anthropic format):
//
//   Anthropic          --429-->  Codex/OpenAI (subscription OAuth, translated)
//   Codex/OpenAI       --429 or transient-->  hard-capped Ollama
//
// Every network leg goes through an injectable transport seam so the offline
// test harness can drive the whole chain with zero sockets (no :20128, no real
// api.anthropic.com / api.openai.com / Ollama). Production uses the real
// https/http transports defined below.
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
  try {
    await transports.anthropic(messages, originalBody, incomingHeaders, res, project, savedTokens);
    return;
  } catch (err) {
    incrementLegError('anthropic');
    if (err.statusCode !== 429 || res.headersSent) throw err;
    console.log('[miser] Anthropic 429 — trying Codex/OpenAI (subscription OAuth)');
  }

  // --- Leg 2: Codex via subscription OAuth ---------------------------------
  try {
    const bearer = await getBearer(); // fail closed: throws if no valid token
    // Build the request in the configured Codex wire format. Default is the
    // Responses API (Codex backend, where the subscription OAuth authenticates);
    // 'chat' keeps the OpenAI chat/completions shape available.
    const useChat = config.codexFormat === 'chat';
    const codexReq = useChat
      ? translateToOpenAI(messages, originalBody)
      : translateToResponses(messages, originalBody);
    const check = useChat ? validateOpenAIRequest(codexReq) : validateResponsesRequest(codexReq);
    if (!check.valid) {
      // Never ship a malformed request (this is what bricked the client before).
      const e = new Error(`miser: refusing malformed Codex request: ${check.error}`);
      e.statusCode = 400;
      throw e;
    }
    await transports.codex(codexReq, bearer, res, project, savedTokens);
    return;
  } catch (err) {
    incrementLegError('codex');
    if (res.headersSent) throw err; // response already streaming — can't fail over
    console.log(`[miser] Codex/OpenAI unavailable (${err.statusCode || err.message}) — hard-capped Ollama fallback`);
  }

  // --- Leg 3: hard-capped Ollama ------------------------------------------
  try {
    await transports.ollama(messages, originalBody, res, project, savedTokens, { cap: ollamaCap });
  } catch (err) {
    incrementLegError('ollama');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Production transports (real sockets). Not exercised by the offline harness.
// ---------------------------------------------------------------------------

// Once response headers are sent we can no longer emit a clean JSON error, and
// the router/proxy cannot either (headersSent is true). If the upstream stream
// then errors we MUST terminate the downstream response so the client sees a
// broken stream rather than an indefinitely-hung connection.
function teardownResponse(res, err) {
  try {
    if (res.destroyed) return;
    if (typeof res.destroy === 'function') res.destroy(err);
    else if (!res.writableEnded) res.end();
  } catch (_) { /* best effort */ }
}

function proxyAnthropicResponse(upstream, res, originalBody, project, savedTokens, resolve, reject) {
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
    }
    resolve({ statusCode });
  });
  upstream.on('error', (e) => { teardownResponse(res, e); reject(e); });
}

function forwardToAnthropic(messages, originalBody, incomingHeaders, res, project, savedTokens) {
  return new Promise((resolve, reject) => {
    // I6: `originalBody` here IS the reduced body compress() produced (hoisted
    // system, optional cache hint, deduped messages). Serialize it verbatim —
    // it already carries the authoritative `messages`; do NOT rebuild from a
    // pre-reduction body or the top-level system hoist would not reach the wire.
    const body = JSON.stringify(originalBody);
    // §8.3: parse host/path from config.anthropicUrl (authoritative field) rather
    // than a hardcoded host — enables the AC10 loopback-echo canary + testability.
    // No failover-logic change.
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

    // Forward all auth headers — subscription uses Authorization: Bearer,
    // API-key use x-api-key. Forward both so either auth mode works unchanged.
    if (incomingHeaders['x-api-key']) options.headers['x-api-key'] = incomingHeaders['x-api-key'];
    if (incomingHeaders['authorization']) options.headers['authorization'] = incomingHeaders['authorization'];
    if (incomingHeaders['anthropic-beta']) options.headers['anthropic-beta'] = incomingHeaders['anthropic-beta'];

    // Protocol-aware transport so a loopback http:// MISER_ANTHROPIC_URL (AC10
    // canary / tests) works; production https:// api.anthropic.com is unchanged.
    const anthTransport = anthURL.protocol === 'https:' ? https : http;
    const req = anthTransport.request(options, (upstream) => {
      if (upstream.statusCode === 429) {
        const err = new Error('anthropic quota exhausted');
        err.statusCode = 429;
        upstream.resume();
        reject(err);
        return;
      }

      proxyAnthropicResponse(upstream, res, originalBody, project, savedTokens, resolve, reject);
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Legacy passthrough for requests that ARRIVE already in OpenAI format.
function forwardToOpenAI(messages, originalBody, incomingHeaders, res, project, savedTokens) {
  return new Promise((resolve, reject) => {
    // I6: `originalBody` is the reduced body (deduped messages). Serialize it
    // verbatim — it already carries the authoritative `messages`.
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

// Codex failover transport. Driven by a TRANSLATED Codex request (Responses API
// by default) + a subscription OAuth bearer. On ANY non-2xx it rejects BEFORE
// writing a response header so the router can fail over to Ollama — critically
// this includes 401/403 (expired/invalid token → fail closed, never streamed to
// the client). On 2xx it re-emits the Codex SSE in ANTHROPIC event shape so the
// client can parse it (raw-piping the Responses stream would brick the client,
// exactly like a raw Ollama stream). Backend headers + SSE schema are extracted
// from the codex CLI and flagged VERIFY-AT-CUTOVER; fully mocked in the offline
// harness.
function forwardToCodex(codexReq, bearer, res, project, savedTokens) {
  return new Promise((resolve, reject) => {
    const url = new URL(config.codexUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify(codexReq);
    const isResponses = config.codexFormat !== 'chat';
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      // Subscription OAuth — NOT OPENAI_API_KEY.
      'authorization': `Bearer ${bearer.token}`,
      'accept': isResponses ? 'text/event-stream' : 'application/json',
    };
    if (bearer.accountId) headers['chatgpt-account-id'] = bearer.accountId;
    if (isResponses) {
      // Client-identity headers matching the real codex HTTPS request (PINNED
      // from a live capture). Note: NO `openai-beta` — the real request omits it.
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
      // Fail over to Ollama on ANY non-2xx. Critically this includes 401/403:
      // an expired/invalid subscription token must NOT be streamed to the
      // client as a "successful" Codex response — it fails closed to Ollama.
      // We reject BEFORE writeHead so the router can still fail over.
      if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
        const err = new Error(`codex non-2xx ${upstream.statusCode}`);
        err.statusCode = upstream.statusCode;
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
        translateResponsesStream(upstream, res, codexReq.model || 'codex'); // Responses SSE → Anthropic SSE
      } else {
        upstream.pipe(res); // chat/completions: already JSON/OpenAI shape
      }
      upstream.on('end', () => { recordUsage(project, 'codex', codexReq.model || 'unknown'); resolve(); });
      upstream.on('error', (e) => { teardownResponse(res, e); reject(e); });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function forwardToOllama(messages, originalBody, res, project, savedTokens, opts = {}) {
  return new Promise((resolve, reject) => {
    const model = config.fallbackModels[0];
    const translated = translateToOllama(messages, originalBody, model);
    // Hard-cap the fully-translated body so an oversized double-fallback payload
    // (or a single huge recent message) can never exceed the local context.
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

    req.on('error', reject);
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
  __test: { _legErrors },
  // exported so the hard-cap can be asserted end-to-end (translate → cap)
  _buildCappedOllamaBody: (messages, originalBody, cap) =>
    hardCapOllamaBody(translateToOllama(messages, originalBody, config.fallbackModels[0]), cap),
};
