'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_STALL_MS = 3 * 60 * 1000;
const DEFAULT_RETRY_WAIT_MS = 30 * 1000;
const DEFAULT_INTERVAL_MS = 30 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TERMDECK_BASE_URL = 'http://127.0.0.1:3100';
const DEFAULT_TOKEN_FILE = path.join(os.homedir(), '.termdeck', 'config.yaml');
const PROJECT_ALIASES = Object.freeze({
  aetheria: 'Aetheria-Concierge',
});

function nowIso(nowMs) {
  return new Date(nowMs).toISOString();
}

function panelKey(project, panel) {
  return `${project}--${panel}`;
}

function normalizeName(value) {
  return String(value || '').toLowerCase();
}

function termdeckProjectName(miserProject, aliases = PROJECT_ALIASES) {
  const key = normalizeName(miserProject);
  return aliases[key] || miserProject;
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const direct = headers[name] || headers[name.toLowerCase()];
  if (Array.isArray(direct)) return direct[0];
  return direct;
}

function isBudgetExhausted(headers) {
  return normalizeName(headerValue(headers, 'x-miser-budget')) === 'exhausted';
}

function isRetryableFailure(outcome = {}) {
  if (isBudgetExhausted(outcome.headers)) return false;
  const statusCode = Number(outcome.statusCode || (outcome.error && outcome.error.statusCode));
  if (statusCode === 429) return true;
  if (statusCode >= 500 && statusCode <= 599) return true;
  return Boolean(outcome.error && outcome.error.retryable);
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

function lastUserText(body) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === 'user') return textFromContent(msg.content);
  }
  return '';
}

function parseStopgapWatchdogEnv(env = process.env) {
  const rawEnabled = env.MISER_STOPGAP_WATCHDOG || '';
  const enabled = /^(1|true|on|yes)$/i.test(rawEnabled);
  return {
    enabled,
    intervalMs: parseInt(env.MISER_STOPGAP_WATCHDOG_INTERVAL_MS || String(DEFAULT_INTERVAL_MS), 10),
    stallMs: parseInt(env.MISER_STOPGAP_WATCHDOG_STALL_MS || String(DEFAULT_STALL_MS), 10),
    retryWaitMs: parseInt(env.MISER_STOPGAP_WATCHDOG_RETRY_WAIT_MS || String(DEFAULT_RETRY_WAIT_MS), 10),
    maxAttempts: parseInt(env.MISER_STOPGAP_WATCHDOG_MAX_ATTEMPTS || String(DEFAULT_MAX_ATTEMPTS), 10),
    termdeckBaseUrl: env.MISER_TERMDECK_BASE_URL || DEFAULT_TERMDECK_BASE_URL,
    termdeckToken: env.MISER_TERMDECK_TOKEN || '',
    termdeckTokenFile: env.MISER_TERMDECK_TOKEN_FILE || DEFAULT_TOKEN_FILE,
  };
}

async function readTermdeckToken(opts = {}) {
  if (opts.token) return opts.token;
  const file = opts.tokenFile || DEFAULT_TOKEN_FILE;
  const raw = await fs.readFile(file, 'utf8');
  const match = raw.match(/^\s*token:\s*(\S+)/m);
  return (match ? match[1] : raw.trim()).trim();
}

function requestJson(baseUrl, method, routePath, body, opts = {}) {
  return new Promise(async (resolve, reject) => {
    let token = '';
    try {
      token = await readTermdeckToken({ token: opts.token, tokenFile: opts.tokenFile });
    } catch (err) {
      reject(err);
      return;
    }
    const url = new URL(routePath, baseUrl);
    const payload = body == null ? null : JSON.stringify(body);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      timeout: opts.timeoutMs || 15000,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (_) {}
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          const err = new Error(`termdeck HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          err.body = parsed || raw;
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('termdeck request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sessionMatchesPanel(session, project, panel, aliases = PROJECT_ALIASES) {
  const meta = (session && session.meta) || {};
  const expectedProject = termdeckProjectName(project, aliases);
  if (normalizeName(meta.project) !== normalizeName(expectedProject)) return false;
  const label = normalizeName(meta.label);
  const wantedPanel = normalizeName(panel);
  return label === wantedPanel
    || label.endsWith(`-${wantedPanel}`)
    || label.endsWith(`--${wantedPanel}`);
}

function createTermdeckClient(opts = {}) {
  const baseUrl = opts.baseUrl || DEFAULT_TERMDECK_BASE_URL;
  const token = opts.token || '';
  const tokenFile = opts.tokenFile || DEFAULT_TOKEN_FILE;
  const aliases = opts.aliases || PROJECT_ALIASES;
  const request = opts.request || ((method, routePath, body) =>
    requestJson(baseUrl, method, routePath, body, { token, tokenFile, timeoutMs: opts.timeoutMs }));

  async function listSessions() {
    const sessions = await request('GET', '/api/sessions');
    return Array.isArray(sessions) ? sessions : [];
  }

  async function findSession(project, panel) {
    const sessions = await listSessions();
    const matches = sessions.filter(session => sessionMatchesPanel(session, project, panel, aliases));
    if (matches.length === 0) return null;
    matches.sort((a, b) => {
      const ma = a.meta || {};
      const mb = b.meta || {};
      return String(mb.lastActivity || '').localeCompare(String(ma.lastActivity || ''));
    });
    return matches[0];
  }

  async function sendInput(sessionId, text, source = 'miser-stopgap-watchdog') {
    return request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/input`, { text, source });
  }

  return {
    listSessions,
    findSession,
    sendInput,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createStopgapWatchdog(opts = {}) {
  const states = new Map();
  const nowFn = opts.nowFn || (() => Date.now());
  const stallMs = Number.isFinite(opts.stallMs) ? opts.stallMs : DEFAULT_STALL_MS;
  const retryWaitMs = Number.isFinite(opts.retryWaitMs) ? opts.retryWaitMs : DEFAULT_RETRY_WAIT_MS;
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : DEFAULT_MAX_ATTEMPTS;
  const client = opts.client || createTermdeckClient(opts.termdeck || {});
  const sendAlert = opts.sendAlert || null;
  const wait = opts.sleepFn || sleep;

  function stateFor(project, panel) {
    const key = panelKey(project, panel);
    if (!states.has(key)) {
      states.set(key, {
        project,
        panel,
        key,
        lastAttemptTs: 0,
        lastSuccessTs: 0,
        lastFailureTs: 0,
        consecutiveRetryableFailures: 0,
        lastStatusCode: null,
        lastOriginalBody: null,
        lastUserText: '',
        resubmitAttempts: 0,
        lastResubmitTs: 0,
        paged: false,
        inflight: false,
      });
    }
    return states.get(key);
  }

  function resetEpisode(st) {
    st.consecutiveRetryableFailures = 0;
    st.resubmitAttempts = 0;
    st.lastResubmitTs = 0;
    st.paged = false;
    st.inflight = false;
  }

  function recordProxyOutcome(outcome = {}) {
    const { project, panel } = outcome;
    if (!project || !panel) return null;
    const now = Number.isFinite(outcome.now) ? outcome.now : nowFn();
    const st = stateFor(project, panel);
    st.lastAttemptTs = now;
    st.lastStatusCode = Number(outcome.statusCode || (outcome.error && outcome.error.statusCode)) || null;

    if (isRetryableFailure(outcome)) {
      st.consecutiveRetryableFailures += 1;
      st.lastFailureTs = now;
      st.lastOriginalBody = outcome.originalBody || null;
      st.lastUserText = lastUserText(outcome.originalBody);
      return st;
    }

    if (st.lastStatusCode >= 200 && st.lastStatusCode < 300) {
      st.lastSuccessTs = now;
    }
    resetEpisode(st);
    return st;
  }

  function isStuck(st, now = nowFn()) {
    if (!st || st.consecutiveRetryableFailures < 2) return false;
    if (now - st.lastAttemptTs < stallMs) return false;
    if (st.lastResubmitTs && now - st.lastResubmitTs < retryWaitMs) return false;
    return true;
  }

  async function page(st, attemptNo, reason) {
    if (st.paged) return;
    st.paged = true;
    const ts = nowIso(nowFn());
    const text = `miser stopgap watchdog: ${st.project}--${st.panel} still stuck after ${attemptNo} resubmit attempt(s) (${reason}); lastStatus=${st.lastStatusCode || 'unknown'} lastFailure=${st.lastFailureTs ? nowIso(st.lastFailureTs) : 'unknown'}`;
    console.warn(`[miser/stopgap] PAGE project=${st.project} panel=${st.panel} ts=${ts} attempt=${attemptNo} reason=${reason}`);
    if (!sendAlert) {
      console.warn(`[miser/alert] ALERT-DROPPED project=${st.project} kind=stopgap-watchdog reason=no_dispatcher`);
      try { require('./alert-routes.js').bumpDropped(); } catch (_) {}
      return;
    }
    await sendAlert(text, { project: st.project, kind: 'stopgap-watchdog' });
  }

  async function attemptResubmit(st) {
    const now = nowFn();
    if (!isStuck(st, now)) return { attempted: false, reason: 'not_stuck' };
    if (st.resubmitAttempts >= maxAttempts) {
      await page(st, st.resubmitAttempts, 'max_attempts');
      return { attempted: false, reason: 'paged' };
    }

    st.inflight = true;
    const attemptNo = st.resubmitAttempts + 1;
    const mode = attemptNo === 1 ? 'bare-cr' : 'original-body';
    console.warn(`[miser/stopgap] DETECTED project=${st.project} panel=${st.panel} ts=${nowIso(now)} attempt=${attemptNo} failures=${st.consecutiveRetryableFailures}`);
    try {
      const session = await client.findSession(st.project, st.panel);
      if (!session) {
        console.warn(`[miser/stopgap] WARN no TermDeck session match project=${st.project} termdeckProject=${termdeckProjectName(st.project)} panel=${st.panel} attempt=${attemptNo}`);
        st.resubmitAttempts = attemptNo;
        st.lastResubmitTs = nowFn();
        if (st.resubmitAttempts >= maxAttempts) await page(st, st.resubmitAttempts, 'session_not_found');
        return { attempted: true, ok: false, mode, reason: 'session_not_found' };
      }

      const label = session.meta && session.meta.label ? session.meta.label : session.id;
      console.warn(`[miser/stopgap] RESUBMIT project=${st.project} panel=${st.panel} session=${session.id} label=${label} ts=${nowIso(nowFn())} attempt=${attemptNo} mode=${mode}`);
      if (mode === 'bare-cr') {
        await client.sendInput(session.id, '\r');
      } else {
        if (!st.lastUserText) {
          st.resubmitAttempts = attemptNo;
          st.lastResubmitTs = nowFn();
          if (st.resubmitAttempts >= maxAttempts) await page(st, st.resubmitAttempts, 'empty_original_body_text');
          return { attempted: true, ok: false, mode, reason: 'empty_original_body_text' };
        }
        await client.sendInput(session.id, `\x1b[200~${st.lastUserText}\x1b[201~`);
        await wait(400);
        await client.sendInput(session.id, '\r');
      }
      st.resubmitAttempts = attemptNo;
      st.lastResubmitTs = nowFn();
      return { attempted: true, ok: true, mode, sessionId: session.id };
    } catch (err) {
      st.resubmitAttempts = attemptNo;
      st.lastResubmitTs = nowFn();
      console.warn(`[miser/stopgap] WARN resubmit failed project=${st.project} panel=${st.panel} attempt=${attemptNo} error=${err.message}`);
      if (st.resubmitAttempts >= maxAttempts) await page(st, st.resubmitAttempts, 'resubmit_error');
      return { attempted: true, ok: false, mode, error: err };
    } finally {
      st.inflight = false;
    }
  }

  async function checkOnce() {
    const results = [];
    for (const st of states.values()) {
      if (st.inflight) continue;
      if (!isStuck(st)) continue;
      results.push(await attemptResubmit(st));
    }
    return results;
  }

  function snapshot() {
    return Array.from(states.values()).map(st => ({ ...st }));
  }

  return {
    recordProxyOutcome,
    checkOnce,
    snapshot,
    _states: states,
    _isStuck: isStuck,
  };
}

function startStopgapWatchdogInterval(watchdog, opts = {}) {
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
  function tick() {
    Promise.resolve()
      .then(() => watchdog.checkOnce())
      .catch(err => console.warn(`[miser/stopgap] WARN watchdog tick failed: ${err.message}`));
  }
  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  DEFAULT_STALL_MS,
  DEFAULT_RETRY_WAIT_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TERMDECK_BASE_URL,
  PROJECT_ALIASES,
  createStopgapWatchdog,
  createTermdeckClient,
  isRetryableFailure,
  lastUserText,
  parseStopgapWatchdogEnv,
  sessionMatchesPanel,
  startStopgapWatchdogInterval,
  termdeckProjectName,
  __test: {
    readTermdeckToken,
    requestJson,
  },
};
