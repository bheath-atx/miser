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
const { checkEnforcement } = require('./enforcement.js');
const { checkModelDrift } = require('./policy-watchdog.js');
const config = require('./config.js');
const { classifyRoute } = require('./routing.js');
const { injectContextManagement } = require('./context-management.js');
const { buildMetricsText } = require('./metrics.js');
const { getPanelStats, getPersistenceStatus, getRecordRejectionStatus: getPanelRecordRejectionStatus } = require('./panel-stats.js');
const { alertRoutingHealth } = require('./alert-routes.js');

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

function wantsAnthropicStream(body) {
  return !!(body && body.stream === true);
}

function anthropicSseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function writeLocalAnthropicResponse(res, local, originalBody) {
  const isStreamingWarning = local
    && local.enforcement
    && local.enforcement.warning
    && wantsAnthropicStream(originalBody);

  if (!isStreamingWarning) {
    res.writeHead(local.status, local.headers);
    res.end(JSON.stringify(local.body));
    return;
  }

  const body = local.body || {};
  const text = Array.isArray(body.content) && body.content[0] && typeof body.content[0].text === 'string'
    ? body.content[0].text
    : '';
  const headers = {
    ...local.headers,
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  };
  res.writeHead(local.status, headers);
  res.write(anthropicSseFrame('message_start', {
    type: 'message_start',
    message: {
      id: body.id || `miser_warning_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: body.model || (originalBody && originalBody.model) || 'miser-enforcement-warning',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
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
  res.write(anthropicSseFrame('content_block_stop', {
    type: 'content_block_stop',
    index: 0,
  }));
  res.write(anthropicSseFrame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 0 },
  }));
  res.write(anthropicSseFrame('message_stop', { type: 'message_stop' }));
  res.end();
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
  // Unmatched model: default to 200K, the conservative/safe assumption for a
  // genuinely unknown model ID, and the SAME default the fleet's own scripts
  // use (~/bin/orch-token-gauge.py DEFAULT_WINDOW, orch-token-watchdog.py
  // DEFAULT_WINDOW are both 200_000). Every model actually known to have a 1M
  // window (opus-5, sonnet-5, fable-5, opus/sonnet-4-6+, etc.) is listed
  // explicitly above with its own entry — only truly unlisted/legacy IDs
  // (e.g. 'claude-sonnet-4-20250514', still referenced in this repo's own
  // tests) fall through to this default, and for those, overstating the
  // window as 1M would silently suppress the compact-hint urgency signal.
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
// (transports / getBearer / ollamaCap / breakers / guardDeps). Production callers
// pass nothing, so routeRequest falls back to its real transports. The offline
// test harness uses it to drive the full proxy→compress→routeRequest→failover
// chain with zero sockets. Never populated on the production path.
function createProxy(deps = {}) {
  // Injectable breaker state seam — lets health tests verify states without
  // touching the module-level singletons in router.js.
  const getBreakersState = deps.getBreakersState || (() => {
    const { getBreakers } = require('./router.js');
    const bs = getBreakers();
    const out = {};
    for (const [name, b] of Object.entries(bs)) out[name] = b.getState();
    return out;
  });

  return async function handler(req, res) {
    trackRequest();
    const route = classifyRoute(req.method, req.url);

    // Health check
    if (route.kind === 'health') {
      let subCapStatus = null;
      const gd = deps.guardDeps;
      if (gd && gd.subCapTracker) {
        subCapStatus = gd.subCapTracker.getStatus(Date.now());
      }
      // §2.8: ok flips false when EITHER degraded cause is non-empty (§2.3).
      // defaultConfigured is no longer only a reported field — it participates
      // in status via cause 2, so "@default" cannot falsely satisfy completeness.
      // HTTP stays 200 deliberately: the status code drives supervisors, the body
      // drives operators, and a non-200 is what gets wired to a restart — which
      // would recreate the very outage §2.3 exists to prevent.
      const alertRouting = alertRoutingHealth(config);
      json(res, 200, {
        ok: alertRouting.status !== 'degraded',
        uptimeSecs: Math.floor(process.uptime()),
        reqPerMin: reqPerMin(),
        perLegErrors: getLegErrors(),
        c1DisabledProjects: [...contextDisabled],
        statsFlushLagMs: getFlushLagMs(),
        pendingWrites: getPendingWriteCount(),
        circuitBreakers: getBreakersState(),
        subscriptionCap: subCapStatus,
        enforcement: gd && gd.enforcementState ? gd.enforcementState.snapshot() : null,
        alertRouting,
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
        const persistence = result.persistence;
        const authoritative = persistence.healthy && persistence.durable;
        const note = authoritative
          ? 'persisted; survives restart'
          : persistence.pending
            ? 'persistence pending; stats may not survive restart yet'
            : 'persistence degraded; stats may not survive restart';
        // Contract matches panel stats: ok is data-authoritative, not just
        // HTTP handler success. Return the payload so consumers can degrade.
        json(res, 200, {
          ...result,
          ok: authoritative,
          note,
          durable: persistence.durable,
          degraded: !persistence.healthy,
          authoritative,
          persistence,
        });
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
        const persistence = result.persistence;
        const authoritative = persistence.healthy && persistence.durable;
        const note = authoritative
          ? 'persisted; survives restart'
          : persistence.pending
            ? 'persistence pending; stats may not survive restart yet'
            : 'persistence degraded; stats may not survive restart';
        json(res, 200, {
          ...result,
          ok: authoritative,
          note,
          durable: persistence.durable,
          degraded: !persistence.healthy,
          authoritative,
          persistence,
        });
      } catch (err) {
        json(res, err.statusCode || 500, { error: { type: 'stats_error', message: err.message } });
      }
      return;
    }

    if (route.kind === 'metrics') {
      const statsResult = getStats(undefined, undefined, config.weightedTokenWeights);
      const metricsText = buildMetricsText(statsResult);
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8; version=0.0.4',
        'cache-control': 'no-cache',
      });
      res.end(metricsText);
      return;
    }

    if (route.kind === 'stats_panels') {
      const panels = getPanelStats();
      const persistence = getPersistenceStatus();
      const authoritative = persistence.healthy && persistence.durable;
      const note = authoritative
        ? 'persisted; survives restart'
        : persistence.pending
          ? 'persistence pending; panel stats may not survive restart yet'
        : 'persistence degraded; panel stats may not survive restart';
      // Contract: ok is data-authoritative, not just HTTP handler success. The
      // endpoint still returns panels on degraded/pending persistence so existing
      // consumers can render partial data while checking ok/durable/degraded.
      json(res, 200, {
        ok: authoritative,
        note,
        durable: persistence.durable,
        degraded: !persistence.healthy,
        authoritative,
        persistence,
        recordRejections: getPanelRecordRejectionStatus(),
        panels,
      });
      return;
    }

    if (route.kind !== 'messages') {
      json(res, 404, { error: { type: 'not_found', message: `miser: unknown route ${req.url}` } });
      return;
    }

    let project = 'default';
    let originalBody = null;
    let c1Injected = false;
    try {
      const raw = await readBody(req);
      originalBody = JSON.parse(raw);
      project = route.project || headerProject(req.headers);
      const panel = route.panel || null;
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
          if (panel && deps.stopgapWatchdog) {
            deps.stopgapWatchdog.recordProxyOutcome({
              project,
              panel,
              originalBody,
              statusCode: block.status,
              headers: block.headers,
            });
          }
          writeLocalAnthropicResponse(res, block, originalBody);
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

      if (guardDeps.enforcementConfig) {
        let block = null;
        try {
          const check = guardDeps.checkEnforcement || checkEnforcement;
          block = check(project, panel, originalBody, compactHeaders, rawTokens, guardDeps, req.headers);
        } catch (e) {
          console.warn('[miser] enforcement check error (fail-open):', e.message);
        }
        if (block) {
          if (panel && deps.stopgapWatchdog) {
            deps.stopgapWatchdog.recordProxyOutcome({
              project,
              panel,
              originalBody,
              statusCode: block.status,
              headers: block.headers,
              enforcement: block.enforcement,
            });
          }
          writeLocalAnthropicResponse(res, block, originalBody);
          return;
        }
      }

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
      await routeRequest(messages, forwardBody, forwardHeaders, res, project, savedTokens, format,
        { ...deps, panel });
      if (panel && deps.stopgapWatchdog) {
        deps.stopgapWatchdog.recordProxyOutcome({
          project,
          panel,
          originalBody,
          statusCode: res.statusCode,
          headers: res.headers,
        });
      }
      if (c1Injected && (res.statusCode < 200 || res.statusCode >= 300)) {
        console.warn(`[miser] c1-injected non-2xx project=${project} status=${res.statusCode}`);
      }
      if (c1Injected && shouldRecordInjectedStats(res.statusCode)) {
        recordStats(project, legacyStats);
      }
      updateContextBreaker(project, c1Injected, res.statusCode);
    } catch (err) {
      updateContextBreaker(project, c1Injected, undefined);
      if (route.panel && deps.stopgapWatchdog) {
        deps.stopgapWatchdog.recordProxyOutcome({
          project,
          panel: route.panel,
          originalBody,
          statusCode: err.statusCode,
          error: err,
        });
      }
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
