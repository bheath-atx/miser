'use strict';

const crypto = require('node:crypto');
const { compress } = require('./compress.js');
const { routeRequest, getLegErrors } = require('./router.js');
const { getAllUsage } = require('./quota.js');
const {
  recordStats,
  getStats,
  getDailyTrend,
  getFlushLagMs,
  getPendingWriteCount,
} = require('./stats.js');
const { pruneTools } = require('./toolprune.js');
const { checkBudget } = require('./budgets.js');
const { checkModelDrift } = require('./policy-watchdog.js');
const config = require('./config.js');
const { classifyRoute } = require('./routing.js');
const { injectContextManagement } = require('./context-management.js');

const projectFingerprints = new Map();
const contextBreaker = new Map();
const contextDisabled = new Set();
const _reqTimestamps = [];
const COMPACT_HEADER_NAMES = [
  'x-miser-input-tokens-est',
  'x-miser-poll-class',
  'x-miser-oversized-turns',
  'x-miser-compact-hint',
  'x-miser-techniques',
];

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
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
      return '';
    }).join('');
  }
  if (typeof content.text === 'string') return content.text;
  try { return JSON.stringify(content); } catch (_) { return ''; }
}

function toolResultBytes(block) {
  if (!block || block.type !== 'tool_result') return 0;
  const content = block.content;
  if (content == null) return 0;
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  try { return Buffer.byteLength(JSON.stringify(content), 'utf8'); } catch (_) { return 0; }
}

function oversizedToolResultTurns(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i] && messages[i].content;
    if (!Array.isArray(content)) continue;
    if (content.some(block => toolResultBytes(block) > 32768)) out.push(i);
  }
  return out;
}

function modelWindow(model) {
  const name = String(model || '');
  for (const [prefix, window] of Object.entries(config.modelWindows)) {
    if (name.startsWith(prefix)) return window;
  }
  return 200_000;
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === 'user') return textFromContent(msg.content);
  }
  return '';
}

function computeCompactHeaders(body, fingerprints, opts = {}) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  const project = opts.project || 'default';
  const rawTokens = Number.isFinite(opts.rawTokens) ? opts.rawTokens : 0;
  const lastText = lastUserText(messages);
  const fingerprint = crypto.createHash('sha256').update(lastText).digest('hex');
  const previousFingerprint = fingerprints.get(project);
  const pollClass = (lastText.length < 500 || previousFingerprint === fingerprint) ? 'likely' : 'unlikely';
  fingerprints.set(project, fingerprint);

  const oversizedTurns = oversizedToolResultTurns(messages);
  const window = modelWindow(body && body.model);
  let compactHint = 'none';
  if (rawTokens > config.compactHintUrgentFraction * window) {
    compactHint = 'urgent';
  } else if (rawTokens > config.compactHintRecommendFraction * window || oversizedTurns.length > 0) {
    compactHint = 'recommend';
  }

  const techniques = (opts.techniques || []).filter(Boolean);
  const headers = {
    'x-miser-input-tokens-est': String(rawTokens),
    'x-miser-poll-class': pollClass,
    'x-miser-compact-hint': compactHint,
    'x-miser-techniques': techniques.length > 0 ? techniques.join(',') : 'none',
  };
  if (oversizedTurns.length > 0) {
    headers['x-miser-oversized-turns'] = oversizedTurns.join(',');
  }
  return headers;
}

function suppressCompactHeadersOnErrors(res) {
  if (res.__miserCompactHeaderGuarded) return;
  res.__miserCompactHeaderGuarded = true;
  const writeHead = res.writeHead;
  res.writeHead = function guardedWriteHead(code, reasonOrHeaders, maybeHeaders) {
    const headers = (typeof reasonOrHeaders === 'string') ? maybeHeaders : reasonOrHeaders;
    if (Number(code) < 200 || Number(code) >= 300) {
      if (typeof res.removeHeader === 'function') {
        for (const name of COMPACT_HEADER_NAMES) res.removeHeader(name);
      }
      if (headers && typeof headers === 'object') {
        for (const name of COMPACT_HEADER_NAMES) {
          delete headers[name];
          delete headers[name.toLowerCase()];
        }
      }
    }
    return writeHead.apply(this, arguments);
  };
}

function headerProject(headers) {
  const raw = headers['x-termdeck-project'];
  if (Array.isArray(raw)) return raw[0] || 'default';
  return raw || 'default';
}

function contextProjectConfig() {
  const projects = {};
  for (const [project, knobs] of Object.entries(config.contextEditProjects || {})) {
    if (!contextDisabled.has(project)) projects[project] = knobs;
  }
  return projects;
}

function updateContextBreaker(project, injected, statusCode) {
  if (!injected) return;
  if (statusCode === 400) {
    const next = (contextBreaker.get(project) || 0) + 1;
    contextBreaker.set(project, next);
    if (next >= 3 && !contextDisabled.has(project)) {
      contextDisabled.add(project);
      console.warn(`[miser] context-management disabled project=${project} reason=three-consecutive-400`);
    }
    return;
  }
  contextBreaker.set(project, 0);
}

function shouldRecordInjectedStats(statusCode) {
  return Number.isFinite(statusCode) && statusCode >= 200 && statusCode < 300;
}

function trackRequest(now = Date.now()) {
  _reqTimestamps.push(now);
  while (_reqTimestamps.length > 3600) _reqTimestamps.shift();
}

function reqPerMin(now = Date.now()) {
  const cutoff = now - 60000;
  while (_reqTimestamps.length > 0 && _reqTimestamps[0] < cutoff) _reqTimestamps.shift();
  return _reqTimestamps.length;
}

// `deps` is an OPTIONAL injectable seam forwarded verbatim to routeRequest()
// (transports / getBearer / ollamaCap). Production callers pass nothing, so
// routeRequest falls back to its real transports. The offline test harness uses
// it to drive the full proxy→compress→routeRequest→failover chain with zero
// sockets. Never populated on the production path.
function createProxy(deps = {}) {
  return async function handler(req, res) {
    trackRequest();
    const route = classifyRoute(req.method, req.url);

    // Health check
    if (route.kind === 'health') {
      json(res, 200, {
        ok: true,
        uptimeSecs: Math.floor(process.uptime()),
        reqPerMin: reqPerMin(),
        perLegErrors: getLegErrors(),
        c1DisabledProjects: [...contextDisabled],
        statsFlushLagMs: getFlushLagMs(),
        pendingWrites: getPendingWriteCount(),
      });
      return;
    }

    // Quota dashboard
    if (route.kind === 'quota') {
      json(res, 200, getAllUsage());
      return;
    }

    // Persisted optimizer stats
    if (route.kind === 'stats') {
      const url = new URL(req.url, 'http://localhost');
      const daysParam = url.searchParams.get('days');
      const projectFilter = url.searchParams.get('project') || undefined;
      try {
        const result = getStats(daysParam !== null ? daysParam : undefined, projectFilter, config.weightedTokenWeights);
        json(res, 200, result);
      } catch (err) {
        json(res, err.statusCode || 500, { error: { type: 'stats_error', message: err.message } });
      }
      return;
    }

    if (route.kind === 'stats_trend') {
      const url = new URL(req.url, 'http://localhost');
      const daysParam = url.searchParams.get('days');
      const projectFilter = url.searchParams.get('project') || undefined;
      try {
        const result = getDailyTrend(daysParam !== null ? daysParam : undefined, projectFilter);
        json(res, 200, { ok: true, ...result });
      } catch (err) {
        json(res, err.statusCode || 500, { error: { type: 'stats_error', message: err.message } });
      }
      return;
    }

    if (route.kind !== 'messages') {
      json(res, 404, { error: { type: 'not_found', message: `miser: unknown route ${req.url}` } });
      return;
    }

    let project = 'default';
    let c1Injected = false;
    try {
      const raw = await readBody(req);
      const originalBody = JSON.parse(raw);
      project = route.project || headerProject(req.headers);
      const format = route.format;

      // --- Sprint B guardrails (pre-compress, pre-upstream) ----------------
      const guardDeps = deps.guardDeps || {};
      // G3 budget check: the ONLY blocking feature — fires AFTER project
      // resolution + route classification, BEFORE compress() and any upstream
      // contact. Blocked requests are NEVER forwarded, accrue no usage stats,
      // and get no compact headers (none have been set yet). Exception-safe
      // fail-OPEN: a throwing budget check must never block traffic.
      if (guardDeps.budgetsConfig) {
        let block = null;
        try {
          block = checkBudget(project, guardDeps);
        } catch (e) {
          console.warn('[miser] budget check error (fail-open):', e.message);
        }
        if (block) {
          res.writeHead(block.status, block.headers);
          res.end(JSON.stringify(block.body));
          return;
        }
      }
      // B6 model drift: alert-only, read-only on originalBody.model. Runs
      // AFTER the budget check (a blocked request never reaches the model, so
      // no drift alert fires for it). Zero mutation to forwardBody; a throw
      // never affects the request path.
      if (guardDeps.policyConfig) {
        try {
          checkModelDrift(project, originalBody, guardDeps);
        } catch (e) {
          console.warn('[miser] drift check error:', e.message);
        }
      }

      // compress() v2 is LOSSLESS: it returns the REDUCED body (hoisted system,
      // optional cache hint, deduped messages). NO threshold gate, NO synthetic
      // client rejection, NO size ceiling — a client-illegal request is forwarded
      // as-is so Anthropic's authoritative error reaches the client (I1–I3, §8.8).
      const { body, messages, tokens, rawTokens, cacheHintApplied } = compress(originalBody, {
        format,
        cacheHint: config.cacheHint,
      });
      const savedTokens = rawTokens - tokens;

      if (savedTokens > 0) {
        console.log(`[miser] project=${project} format=${format} deduped ${rawTokens}→${tokens} tokens (saved ${savedTokens})`);
      }

      // Per-project tool pruning (Tier A, v3; config-gated and safe-by-default).
      const projectAllowlist = config.toolAllowlists[project] || null;
      let prunedBody = body;
      let toolsRemoved = 0;
      if (projectAllowlist && Array.isArray(body.tools)) {
        const originalCount = body.tools.length;
        const prunedTools = pruneTools(body.tools, body, projectAllowlist);
        toolsRemoved = originalCount - prunedTools.length;
        if (toolsRemoved > 0) {
          prunedBody = { ...body, tools: prunedTools };
          console.log(`[miser] project=${project} tool-prune: ${originalCount}→${prunedTools.length} tools (removed ${toolsRemoved})`);
        }
      }

      const techniques = [];
      if (savedTokens > 0) techniques.push('dedup');
      if (cacheHintApplied) techniques.push('cacheHint');
      if (toolsRemoved > 0) techniques.push('toolPrune');
      const compactHeaders = computeCompactHeaders(originalBody, projectFingerprints, { project, rawTokens, techniques });
      suppressCompactHeadersOnErrors(res);
      for (const [k, v] of Object.entries(compactHeaders)) res.setHeader(k, v);

      const legacyStats = {
        inputTokensRemoved: savedTokens,
        toolsRemoved,
        pollClass: compactHeaders['x-miser-poll-class'],
        techniques: {
          dedup: savedTokens > 0,
          cacheHint: cacheHintApplied,
          toolPrune: toolsRemoved > 0,
        },
      };

      let forwardBody = prunedBody;
      let forwardHeaders = req.headers;
      if (format === 'anthropic') {
        const injected = injectContextManagement(prunedBody, req.headers, project, contextProjectConfig());
        forwardBody = injected.body;
        forwardHeaders = injected.headers;
        c1Injected = injected.injected;
        if (c1Injected) console.log(`[miser] c1-injected project=${project}`);
      }

      if (!c1Injected) recordStats(project, legacyStats);

      // Forward the REDUCED body (I6) — every leg serializes THIS body, so the
      // hoisted top-level `system` and any cache hint reach the wire on all legs.
      await routeRequest(messages, forwardBody, forwardHeaders, res, project, savedTokens, format, deps);
      if (c1Injected && (res.statusCode < 200 || res.statusCode >= 300)) {
        console.warn(`[miser] c1-injected non-2xx project=${project} status=${res.statusCode}`);
      }
      if (c1Injected && shouldRecordInjectedStats(res.statusCode)) {
        recordStats(project, legacyStats);
      }
      updateContextBreaker(project, c1Injected, res.statusCode);
    } catch (err) {
      updateContextBreaker(project, c1Injected, undefined);
      console.error('[miser] error:', err.message);
      if (!res.headersSent) {
        json(res, 500, { error: { type: 'proxy_error', message: err.message } });
      }
    }
  };
}

module.exports = {
  createProxy,
  computeCompactHeaders,
  __test: { contextBreaker, contextDisabled, _reqTimestamps, trackRequest, reqPerMin },
};
