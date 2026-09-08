'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');

const DEFAULT_BASES = ['http://127.0.0.1:3100', 'http://127.0.0.1:3200'];
const DEFAULT_OUTPUT_DIR = '~/.miser/watch/panel-review';
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11436';
const DEFAULT_MODEL = 'qwen2.5:3b-instruct';
const MAX_TRANSCRIPT_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024;
const MAX_PROMPT_CHARS = 18_000;
const STALE_MS = 45 * 60 * 1000;
const ARTIFACT_AGE_MS = 72 * 60 * 60 * 1000;

function expandHome(file) {
  if (typeof file !== 'string' || !file.trim()) return null;
  if (file === '~') return os.homedir();
  if (file.startsWith('~/')) return path.join(os.homedir(), file.slice(2));
  return file;
}

function safeId(value, fallback = 'unknown') {
  const out = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return out || fallback;
}

function readToken(file = '~/.termdeck/config.yaml') {
  try {
    const raw = fs.readFileSync(expandHome(file), 'utf8');
    const match = raw.match(/^[ \t]*token:[ \t]*(\S+)/m);
    return match ? match[1] : '';
  } catch (_) {
    return '';
  }
}

function parseBases(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_BASES;
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

function requestJson(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || 5000;
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (_) {}
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`HTTP ${res.statusCode} ${url}`);
          err.statusCode = res.statusCode;
          err.body = raw;
          reject(err);
          return;
        }
        resolve(parsed == null ? raw : parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (opts.body != null) req.write(opts.body);
    req.end();
  });
}

async function listTermDeckSessions(bases, token, fetchJson = requestJson) {
  const sessions = [];
  const errors = [];
  for (const base of bases) {
    try {
      const rows = await fetchJson(`${base.replace(/\/+$/, '')}/api/sessions`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      for (const row of Array.isArray(rows) ? rows : []) {
        sessions.push({ base, ...row });
      }
    } catch (err) {
      errors.push({ base, error: err.message });
    }
  }
  return { sessions, errors };
}

function claudeProjectDir(cwd, root = path.join(os.homedir(), '.claude', 'projects')) {
  if (!cwd) return null;
  return path.join(root, cwd.replace(/\//g, '-'));
}

function newestFile(files, opts = {}) {
  let best = null;
  const minMtimeMs = Number.isFinite(opts.minMtimeMs) ? opts.minMtimeMs : null;
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (minMtimeMs != null && stat.mtimeMs < minMtimeMs) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs };
    } catch (_) {}
  }
  return best;
}

function readTail(file, maxBytes) {
  try {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const len = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, Math.max(0, stat.size - len));
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (_) {
    return '';
  }
}

function parseJsonLinesTail(raw) {
  const out = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) {}
  }
  return out;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    if (!block || typeof block !== 'object') return '';
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    if (block.type === 'tool_use') return `${block.name || 'tool'} ${JSON.stringify(block.input || {}).slice(0, 500)}`;
    if (block.type === 'tool_result') return String(block.content || '').slice(0, 500);
    return '';
  }).filter(Boolean).join('\n');
}

function summarizeTranscript(cwd, opts = {}) {
  const dir = claudeProjectDir(cwd, opts.claudeProjectsRoot);
  if (!dir) return { path: null, found: false, tail: '', markers: [], errors: [] };
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter(name => name.endsWith('.jsonl'))
      .map(name => path.join(dir, name));
  } catch (_) {}
  const best = newestFile(files, { minMtimeMs: opts.minTranscriptMtimeMs });
  if (!best) return {
    path: null,
    found: false,
    tail: '',
    markers: [],
    errors: [],
    skipped: Number.isFinite(opts.minTranscriptMtimeMs) ? 'no-transcript-after-panel-created' : undefined,
  };
  const raw = readTail(best.file, opts.maxTranscriptBytes || MAX_TRANSCRIPT_BYTES);
  const rows = parseJsonLinesTail(raw);
  const messages = [];
  const errors = [];
  for (const row of rows.slice(-80)) {
    const text = textFromContent(row.message && row.message.content);
    if (row.apiErrorStatus || row.error || /API Error|rate_limit|429|permission|blocked/i.test(text)) {
      errors.push(trim(text || row.error || `apiErrorStatus ${row.apiErrorStatus}`, 300));
    }
    if ((row.type === 'assistant' || row.type === 'user') && text) {
      messages.push(`${row.type}: ${trim(text, 500)}`);
    }
  }
  const tail = messages.slice(-12).join('\n');
  return {
    path: best.file,
    found: true,
    mtime: new Date(best.mtimeMs).toISOString(),
    tail,
    markers: markerHits(`${raw}\n${tail}`),
    errors: errors.slice(-8),
  };
}

function panelUsesClaude(panel) {
  const text = `${panel && panel.type || ''} ${panel && panel.command || ''} ${panel && panel.label || ''}`.toLowerCase();
  return text.includes('claude');
}

function markerHits(text) {
  const hits = [];
  const rules = [
    ['complete', /\b(ORCH-RESULT|VERDICT:\s*(PASS|APPROVE|COMPLETE)|PR\s*#?\d+|merged|done)\b/i],
    ['blocked', /\b(VERDICT:\s*(REVISE|BLOCKED|FAIL)|BLOCKER|blocked|failed|failure|permission denied|429|API Error)\b/i],
    ['handoff', /\b(HANDOFF|SUMMARY|compact result|result artifact)\b/i],
    ['tests', /\b(npm test|node --test|pytest|tests? passed|CI green|CI passed)\b/i],
  ];
  for (const [name, re] of rules) {
    if (re.test(String(text || ''))) hits.push(name);
  }
  return hits;
}

function trim(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function execFilePromise(file, args, opts = {}) {
  return new Promise(resolve => {
    execFile(file, args, { cwd: opts.cwd, timeout: opts.timeoutMs || 5000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : 0,
        output: trim(`${stdout || ''}${stderr || ''}`, opts.maxChars || 4000),
      });
    });
  });
}

async function gitSummary(cwd) {
  if (!cwd || !fs.existsSync(path.join(cwd, '.git'))) return { isRepo: false };
  const status = await execFilePromise('git', ['-C', cwd, 'status', '--short', '--branch'], { timeoutMs: 5000 });
  const head = await execFilePromise('git', ['-C', cwd, 'log', '-1', '--oneline'], { timeoutMs: 5000, maxChars: 1000 });
  return { isRepo: true, status: status.output, head: head.output };
}

function artifactNameLooksRelevant(name) {
  return /\.(md|txt|json)$/i.test(name)
    && /(ORCH-RESULT|RESULT|SUMMARY|VERDICT|AUDIT|BUILD-REPORT|HANDOFF|STATUS|DONE|PR|REVIEW)/i.test(name);
}

function artifactDirLooksRelevant(name) {
  return /^(\.sprint|docs?|sprints?|audit|reports?|tmp|results?)$/i.test(name);
}

function collectArtifacts(cwd, opts = {}) {
  const maxFiles = opts.maxArtifacts || 24;
  const maxDepth = opts.maxArtifactDepth || 4;
  const minMtime = Number.isFinite(opts.minMtimeMs)
    ? opts.minMtimeMs
    : Date.now() - (opts.artifactAgeMs || ARTIFACT_AGE_MS);
  const out = [];
  const seen = new Set();
  function walk(dir, depth) {
    if (!dir || depth > maxDepth || out.length >= maxFiles) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.venv' || entry.name === '__pycache__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && artifactDirLooksRelevant(entry.name)) {
          walk(full, depth + 1);
        }
        continue;
      }
      if (!artifactNameLooksRelevant(entry.name)) continue;
      let stat;
      try { stat = fs.statSync(full); } catch (_) { continue; }
      if (stat.mtimeMs < minMtime || seen.has(full)) continue;
      seen.add(full);
      const tail = readTail(full, opts.maxArtifactBytes || MAX_ARTIFACT_BYTES);
      out.push({
        path: full,
        mtime: new Date(stat.mtimeMs).toISOString(),
        bytes: stat.size,
        markers: markerHits(tail),
        preview: trim(tail, 1200),
      });
    }
  }
  walk(cwd, 0);
  out.sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime));
  return out.slice(0, maxFiles);
}

function deterministicClassify(panel) {
  const lastActivity = Date.parse(panel.lastActivity || panel.createdAt || '');
  const idleMs = Number.isFinite(lastActivity) ? Date.now() - lastActivity : null;
  const text = [
    panel.status,
    panel.statusDetail,
    panel.transcript && panel.transcript.tail,
    ...(panel.artifacts || []).map(a => `${a.path}\n${a.preview}`),
  ].join('\n');
  const markers = markerHits(text);
  const evidence = [];
  if (panel.exitCode != null) evidence.push(`process exited with code ${panel.exitCode}`);
  if (panel.status) evidence.push(`termdeck status ${panel.status}`);
  if (panel.artifacts && panel.artifacts.length) evidence.push(`${panel.artifacts.length} recent result/status artifacts`);
  if (panel.transcript && panel.transcript.errors && panel.transcript.errors.length) evidence.push(`${panel.transcript.errors.length} transcript error markers`);
  if (idleMs != null) evidence.push(`last activity ${Math.floor(idleMs / 1000)}s ago`);

  let state = 'running';
  let confidence = 0.55;
  if (panel.status === 'errored' || (typeof panel.exitCode === 'number' && panel.exitCode !== 0)) {
    state = 'blocked';
    confidence = 0.8;
  }
  if (markers.includes('blocked') || (panel.transcript && panel.transcript.errors.length)) {
    state = 'blocked';
    confidence = 0.75;
  }
  if (markers.includes('complete') && (markers.includes('tests') || markers.includes('handoff') || (panel.artifacts || []).length > 0)) {
    state = 'complete';
    confidence = 0.75;
  }
  if ((panel.status === 'thinking' || panel.status === 'active') && idleMs != null && idleMs > STALE_MS && state === 'running') {
    state = 'stale';
    confidence = 0.7;
  }
  if (/permission|approval|needs brad|awaiting brad|manual/i.test(text)) {
    state = 'needs_human';
    confidence = Math.max(confidence, 0.7);
  }
  if (/429|API Error|rate_limit/i.test(text)) {
    state = 'blocked';
    confidence = Math.max(confidence, 0.8);
  }
  return {
    state,
    confidence,
    evidence,
    missing: [],
    message_for_orch: `${panel.label || panel.id}: ${state}`,
    source: 'deterministic',
  };
}

function buildLlmPrompt(panel, baseline) {
  const payload = {
    instruction: 'Classify this TermDeck panel state. Return only JSON with keys state, confidence, evidence, missing, message_for_orch. Valid states: complete, blocked, running, stale, bad_loop, needs_human.',
    panel: {
      id: panel.id,
      project: panel.project,
      label: panel.label,
      type: panel.type,
      status: panel.status,
      statusDetail: panel.statusDetail,
      cwd: panel.cwd,
      lastActivity: panel.lastActivity,
      exitCode: panel.exitCode,
      lastCommands: panel.lastCommands,
    },
    deterministic: baseline,
    transcript: panel.transcript,
    git: panel.git,
    artifacts: panel.artifacts,
  };
  return trim(JSON.stringify(payload), MAX_PROMPT_CHARS);
}

async function classifyWithOllama(panel, baseline, opts = {}) {
  const prompt = buildLlmPrompt(panel, baseline);
  const body = JSON.stringify({
    model: opts.model || DEFAULT_MODEL,
    prompt,
    stream: false,
    format: 'json',
    options: { num_ctx: 4096, num_predict: 512, temperature: 0 },
  });
  const url = `${String(opts.ollamaUrl || DEFAULT_OLLAMA_URL).replace(/\/+$/, '')}/api/generate`;
  const res = await requestJson(url, {
    method: 'POST',
    timeoutMs: opts.timeoutMs || 30_000,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    body,
  });
  const raw = res && typeof res.response === 'string' ? res.response : JSON.stringify(res);
  return normalizeClassification(raw, baseline, 'local-llm');
}

function messageContradictsState(message, state) {
  const states = ['complete', 'blocked', 'running', 'stale', 'bad_loop', 'needs_human'];
  return states.some(candidate => candidate !== state && new RegExp(`\\b${candidate}\\b`, 'i').test(message));
}

function normalizeClassification(raw, fallback, source) {
  let parsed = null;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) {}
  if (!parsed || typeof parsed !== 'object') return fallback;
  const allowed = new Set(['complete', 'blocked', 'running', 'stale', 'bad_loop', 'needs_human']);
  const state = allowed.has(parsed.state) ? parsed.state : fallback.state;
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence)));
  const parsedMessage = trim(parsed.message_for_orch || fallback.message_for_orch, 600);
  const message = messageContradictsState(parsedMessage, state) && fallback.state === state
    ? fallback.message_for_orch
    : parsedMessage;
  return {
    state,
    confidence: Number.isFinite(confidence) ? confidence : fallback.confidence,
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(x => trim(x, 240)).slice(0, 8) : fallback.evidence,
    missing: Array.isArray(parsed.missing) ? parsed.missing.map(x => trim(x, 240)).slice(0, 8) : fallback.missing,
    message_for_orch: message,
    source,
  };
}

function sessionToPanel(session) {
  const meta = session.meta || {};
  return {
    id: session.id,
    base: session.base,
    pid: session.pid,
    project: meta.project || session.project || 'unknown',
    label: meta.label || session.label || session.id,
    type: meta.type || session.type || 'unknown',
    command: meta.command || session.command || '',
    cwd: meta.cwd || session.cwd || '',
    status: meta.status || session.status || null,
    statusDetail: meta.statusDetail || session.statusDetail || '',
    lastCommands: Array.isArray(meta.lastCommands) ? meta.lastCommands.slice(-10) : [],
    lastActivity: meta.lastActivity || session.lastActivity || null,
    createdAt: meta.createdAt || session.createdAt || null,
    exitCode: meta.exitCode != null ? meta.exitCode : session.exitCode,
  };
}

function markdownReport(result) {
  const lines = [
    `VERDICT: ${result.status.toUpperCase()}`,
    `generated_at: ${result.generated_at}`,
    `panels: ${result.panels.length}`,
    `llm: ${result.llm.enabled ? `${result.llm.model} via ${result.llm.url}` : 'disabled'}`,
    '',
    'PANEL_SUMMARY:',
  ];
  for (const panel of result.panels) {
    lines.push(`- ${panel.project} ${panel.label} ${panel.id.slice(0, 8)}: ${panel.review.state} (${Math.round(panel.review.confidence * 100)}%, ${panel.review.source})`);
    if (panel.review.message_for_orch) lines.push(`  ${panel.review.message_for_orch}`);
    if (panel.review.missing && panel.review.missing.length) lines.push(`  missing: ${panel.review.missing.join('; ')}`);
    if (panel.artifacts && panel.artifacts[0]) lines.push(`  artifact: ${panel.artifacts[0].path}`);
  }
  if (result.errors.length) {
    lines.push('', 'ERRORS:');
    for (const err of result.errors) lines.push(`- ${err.base || err.scope}: ${err.error}`);
  }
  return `${lines.join('\n')}\n`;
}

async function writeOutputs(result, outputDir) {
  if (!outputDir) return;
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const jsonPath = path.join(outputDir, 'index.json');
  const mdPath = path.join(outputDir, 'index.md');
  await fsp.writeFile(`${jsonPath}.${process.pid}.tmp`, JSON.stringify(result, null, 2), { mode: 0o600 });
  await fsp.rename(`${jsonPath}.${process.pid}.tmp`, jsonPath);
  await fsp.writeFile(`${mdPath}.${process.pid}.tmp`, markdownReport(result), { mode: 0o600 });
  await fsp.rename(`${mdPath}.${process.pid}.tmp`, mdPath);
}

async function reviewPanels(opts = {}) {
  const bases = parseBases(opts.bases || process.env.MISER_PANEL_REVIEW_TERMDECK_BASES);
  const token = opts.token != null ? opts.token : readToken(opts.tokenFile);
  const outputDir = expandHome(opts.outputDir || process.env.MISER_PANEL_REVIEW_OUTPUT_DIR || DEFAULT_OUTPUT_DIR);
  const llmEnabled = opts.llmEnabled !== false && !/^(0|false|off|no)$/i.test(process.env.MISER_PANEL_REVIEW_LLM || '');
  const model = opts.model || process.env.MISER_PANEL_REVIEW_MODEL || DEFAULT_MODEL;
  const ollamaUrl = opts.ollamaUrl || process.env.MISER_PANEL_REVIEW_OLLAMA_URL || DEFAULT_OLLAMA_URL;
  const { sessions, errors } = await listTermDeckSessions(bases, token, opts.fetchJson || requestJson);
  const panels = [];
  for (const session of sessions) {
    const panel = sessionToPanel(session);
    const createdMs = Date.parse(panel.createdAt || '');
    panel.transcript = panelUsesClaude(panel)
      ? summarizeTranscript(panel.cwd, {
        ...opts,
        minTranscriptMtimeMs: Number.isFinite(createdMs) ? Math.max(0, createdMs - 5000) : undefined,
      })
      : { path: null, found: false, tail: '', markers: [], errors: [], skipped: 'non-claude-panel' };
    panel.artifacts = collectArtifacts(panel.cwd, {
      ...opts,
      minMtimeMs: Number.isFinite(createdMs) ? Math.max(0, createdMs - 5 * 60 * 1000) : undefined,
    });
    panel.git = await gitSummary(panel.cwd);
    const baseline = deterministicClassify(panel);
    try {
      panel.review = llmEnabled ? await classifyWithOllama(panel, baseline, { model, ollamaUrl }) : baseline;
    } catch (err) {
      panel.review = { ...baseline, source: 'deterministic-fallback', llm_error: err.message };
      errors.push({ scope: `panel ${panel.id}`, error: err.message });
    }
    panels.push(panel);
  }
  const actionable = panels.filter(p => ['complete', 'blocked', 'stale', 'bad_loop', 'needs_human'].includes(p.review.state));
  const result = {
    version: 1,
    generated_at: new Date().toISOString(),
    status: errors.length ? 'warn' : 'ok',
    llm: { enabled: llmEnabled, model, url: ollamaUrl },
    actionable_count: actionable.length,
    panels,
    errors,
  };
  await writeOutputs(result, outputDir);
  return result;
}

module.exports = {
  DEFAULT_BASES,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_OLLAMA_URL,
  DEFAULT_MODEL,
  parseBases,
  safeId,
  markerHits,
  deterministicClassify,
  normalizeClassification,
  sessionToPanel,
  markdownReport,
  reviewPanels,
  __test: {
    claudeProjectDir,
    collectArtifacts,
    messageContradictsState,
    panelUsesClaude,
    textFromContent,
    buildLlmPrompt,
  },
};
