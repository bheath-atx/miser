'use strict';

const https = require('node:https');
const http = require('node:http');
const { translateToOllama, translateOllamaStream } = require('./translate.js');
const { translateToOpenAI, validateOpenAIRequest } = require('./translate-openai.js');
const { translateToResponses, validateResponsesRequest, translateResponsesStream } = require('./translate-responses.js');
const { hardCapOllamaBody } = require('./hardcap.js');
const { getCodexBearer } = require('./oauth.js');
const { recordUsage } = require('./quota.js');
const { recordAnthropicUsage, recordProviderLimitEvent } = require('./stats.js');
const { recordPanelUsage } = require('./panel-stats.js');
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
  // Production fallback DELETED (§3.1). Missing dispatcher is loud (§3.3); this
  // is a pre-dispatcher check owning its own line + counter (§2.7).
  if (!guardDeps.sendAlert) {
    console.warn('[miser/alert] ALERT-DROPPED project=fleet kind=sub-cap reason=no_dispatcher');
    require('./alert-routes.js').bumpDropped();
    return;
  }
  const pctMsg = `Codex ${Math.round(status.capFraction * 100)}% of ${status.cap5h}-req 5h cap`;
  const events429Msg = status.events429In5h > 0 ? ` — ${status.events429In5h} 429s observed` : '';
  // FLEET scope (§2.6): the subscription cap is a fleet-wide resource and the
  // ledger key is already global. No project is fabricated for it.
  Promise.resolve()
    .then(() => guardDeps.sendAlert(
      `⚠️ miser sub-cap: ${pctMsg}${events429Msg} — deferBackground=true`,
      { scope: 'fleet', kind: 'sub-cap' }))
    .catch(() => {});
}

function limitEventCapText(observed) {
  if (!observed) return 'cap=unknown';
  if (Number.isFinite(observed.weeklyCapAtObservation)) {
    const range = observed.capRangeAtObservation;
    const rangeText = range && Number.isFinite(range.low) && Number.isFinite(range.high)
      ? ` range=${Math.round(range.low)}-${Math.round(range.high)}`
      : '';
    return `cap=${Math.round(observed.weeklyCapAtObservation)} weighted routed tokens source=${observed.capSourceAtObservation || 'unknown'}${rangeText}`;
  }
  return `cap=unavailable(${observed.capUnavailableReasonAtObservation || observed.capSourceAtObservation || 'unknown'})`;
}

function wantsAnthropicStream(body) {
  return !!(body && body.stream === true);
}

function anthropicSseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function localAnthropicMessage(model, text) {
  return {
    id: `miser_local_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: model || 'miser-local',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    },
  };
}

function writeLocalAnthropicMessage(res, originalBody, text, extraHeaders = {}) {
  const body = localAnthropicMessage((originalBody && originalBody.model) || 'miser-local', text);
  const headers = {
    'x-miser-provider': 'local',
    'x-miser-enforcement': 'tool-sensitive-fallback-veto',
    ...extraHeaders,
  };

  if (!wantsAnthropicStream(originalBody)) {
    res.writeHead(200, { ...headers, 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write(anthropicSseFrame('message_start', {
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
  }));
  res.write(anthropicSseFrame('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }));
  if (text) {
    res.write(anthropicSseFrame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }));
  }
  res.write(anthropicSseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }));
  res.write(anthropicSseFrame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 0 },
  }));
  res.write(anthropicSseFrame('message_stop', { type: 'message_stop' }));
  res.end();
}

function textOnlyContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(block => {
      if (!block || typeof block !== 'object') return '';
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function latestRealUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'user') continue;
    const text = textOnlyContent(msg.content);
    if (text.trim()) return text;
  }
  return '';
}

function contentHasToolBlock(content) {
  return Array.isArray(content) && content.some(block =>
    block && (block.type === 'tool_use' || block.type === 'tool_result'));
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

function isDeliveryRepairText(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return false;
  return /stop[-_ ]?hook/.test(s)
    || s.includes('stop_hook_active')
    || s.includes('use the bash tool')
    || s.includes('do not print curl')
    || s.includes('send it now')
    || s.includes('ok:true')
    || s.includes('"ok":true')
    || /\/v1\/orch(?:-[^\s"'`]+|\/[^\s"'`]+)\/reply/.test(s);
}

function isToolSensitiveFallback(messages, originalBody) {
  const last = Array.isArray(messages) && messages.length ? messages[messages.length - 1] : null;
  return !!(
    (last && contentHasToolBlock(last.content))
    || forcedToolChoice(originalBody)
    || isDeliveryRepairText(latestRealUserText(messages || []))
  );
}

function writeToolSensitiveFallbackVeto(res, originalBody, project, panel) {
  const where = panel ? `${project || 'default'}--${panel}` : (project || 'default');
  const text = `miser: upstream unavailable; local fallback disabled for tool-sensitive Claude Code turn in ${where} because fallback cannot preserve tool_use. Stand down and retry after provider recovery or restart a fresh panel.`;
  writeLocalAnthropicMessage(res, originalBody, text, {
    'x-miser-enforcement-reason': 'upstream-unavailable-tool-sensitive',
  });
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
  const panel = (deps && deps.panel) || null;

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
        () => transports.anthropic(messages, originalBody, incomingHeaders, res, project, panel, savedTokens, guardDeps),
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

  if (isToolSensitiveFallback(messages, originalBody)) {
    console.log(`[miser] tool-sensitive fallback veto project=${project || 'default'} panel=${panel || ''}`);
    writeToolSensitiveFallbackVeto(res, originalBody, project, panel);
    return;
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
      const result = await transports.ollama(messages, originalBody, res, project, savedTokens, { cap: ollamaCap });
      if (result && result.ok === false) {
        safeRecord(breakers.ollama, 'recordFailure');
      } else {
        safeRecord(breakers.ollama, 'recordSuccess');
      }
    } catch (err) {
      incrementLegError('ollama');
      // Only retryable errors (connect-errors, transport failures) count against the breaker.
      if (err.retryable) safeRecord(breakers.ollama, 'recordFailure');
      if (!res.headersSent) {
        writeLocalAnthropicMessage(res, originalBody,
          `miser: local fallback unavailable (${err.statusCode || err.message}); stand down and retry after provider recovery.`,
          { 'x-miser-enforcement-reason': 'ollama-unavailable' });
        return;
      }
      throw err;
    }
  } else {
    incrementLegError('ollama');
    writeLocalAnthropicMessage(res, originalBody,
      'miser: all upstreams unavailable and local fallback breaker is open; stand down and retry after provider recovery.',
      { 'x-miser-enforcement-reason': 'ollama-breaker-open' });
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

function proxyAnthropicResponse(upstream, res, originalBody, project, panel, savedTokens, resolve, reject, guardDeps) {
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
      if (panel) {
        recordPanelUsage(project, panel, (parsed && parsed.usage) || {});
      }
      if (panel && guardDeps && guardDeps.enforcementConfig && guardDeps.recordEnforcementUsage && parsed && parsed.usage) {
        try {
          guardDeps.recordEnforcementUsage(project, panel, parsed.usage, config.weightedTokenWeights, guardDeps);
        } catch (e) {
          console.warn('[miser] enforcement usage record error:', e.message);
        }
      }
      if (guardDeps && guardDeps.checkContextBloat) {
        Promise.resolve()
          .then(() => guardDeps.checkContextBloat(project, model, parsed && parsed.usage, guardDeps))
          .catch(e => console.warn('[miser] bloat check error:', e.message));
      }
      if (guardDeps && guardDeps.checkCacheThrash && parsed) {
        Promise.resolve()
          .then(() => guardDeps.checkCacheThrash(project, model, parsed.usage, guardDeps))
          .catch(e => console.warn('[miser] thrash check error:', e.message));
      }
    }
    resolve({ statusCode });
  });
  upstream.on('error', (e) => { teardownResponse(res, e); reject(e); });
}

function forwardToAnthropic(messages, originalBody, incomingHeaders, res, project, panel, savedTokens, guardDeps) {
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
        const chunks = [];
        upstream.on('data', chunk => chunks.push(chunk));
        upstream.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let errorType = null;
          try {
            const parsed = JSON.parse(raw);
            errorType = parsed && parsed.error && parsed.error.type;
          } catch (_) {}
          const observed = recordProviderLimitEvent(project, 'anthropic', originalBody.model || 'unknown', {
            status: upstream.statusCode,
            errorType,
            raw: raw || null,
          });
          if (guardDeps && guardDeps.sendAlert) {
            Promise.resolve()
              .then(() => guardDeps.sendAlert(
                `miser provider limit event: anthropic ${upstream.statusCode} model=${originalBody.model || 'unknown'} project=${project || 'default'} consumed=${observed ? observed.weightedConsumptionAtObservation : 'unknown'} weighted routed tokens ${limitEventCapText(observed)}`,
                { scope: 'fleet', kind: 'limit-event' }))
              .catch(() => {});
          }
          const err = new Error('anthropic quota exhausted');
          err.statusCode = 429;
          reject(err);
        });
        upstream.on('error', reject);
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
      proxyAnthropicResponse(upstream, res, originalBody, project, panel, savedTokens, resolve, reject, guardDeps);
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
      const contentType = upstream.headers['content-type'] || '';
      if (isResponses && !/^text\/event-stream\b/i.test(contentType)) {
        const err = new Error(`codex 2xx non-SSE response (${contentType || 'missing content-type'})`);
        err.statusCode = 502;
        err.retryable = true;
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
      if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
        upstream.resume();
        writeLocalAnthropicMessage(res, originalBody,
          `miser: local fallback unavailable (ollama ${upstream.statusCode}); stand down and retry after provider recovery.`,
          { 'x-miser-enforcement-reason': 'ollama-non-2xx' });
        resolve({ ok: false, statusCode: upstream.statusCode });
        return;
      }
      const headers = {
        'content-type': 'text/event-stream',
        'x-miser-provider': 'ollama',
        'x-miser-model': model,
        'x-miser-saved-tokens': String(savedTokens),
      };
      translateOllamaStream(upstream, res, model, {
        headers,
        emptyText: 'miser: local fallback returned an empty response; stand down and retry after provider recovery.',
      }).then((result) => {
        if (result && result.ok) recordUsage(project, 'ollama', model);
        resolve(result);
      }).catch(reject);
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
    isToolSensitiveFallback,
    writeLocalAnthropicMessage,
  },
  _buildCappedOllamaBody: (messages, originalBody, cap) =>
    hardCapOllamaBody(translateToOllama(messages, originalBody, config.fallbackModels[0]), cap),
};
