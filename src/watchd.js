'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_WATCH_DIR = '~/.miser/watch';
const DEFAULT_TIMEOUT_S = 15;
const DEFAULT_TTL_S = 300;
const DEFAULT_LOCK_LEASE_MS = 60_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_COMPACT_BYTES = 4096;
const PROBE_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

function expandHome(file) {
  if (typeof file !== 'string' || !file.trim()) return null;
  if (file === '~') return os.homedir();
  if (file.startsWith('~/')) return path.join(os.homedir(), file.slice(2));
  return file;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteInt(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) return fallback;
  return n;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function safeProbeId(id) {
  return typeof id === 'string' && PROBE_ID_RE.test(id);
}

function artifactPaths(watchDir, id) {
  return {
    json: path.join(watchDir, `${id}.json`),
    compact: path.join(watchDir, `${id}.md`),
    raw: path.join(watchDir, `${id}.raw.txt`),
    lock: path.join(watchDir, `${id}.lock`),
  };
}

function normalizeProbe(raw, idFromMap = '') {
  const probe = typeof raw === 'string' ? { command: raw } : raw;
  if (!isPlainObject(probe)) return null;
  const id = String(probe.id || idFromMap || '').trim();
  const command = String(probe.command || '').trim();
  if (!safeProbeId(id) || !command) return null;
  return {
    id,
    command,
    cwd: typeof probe.cwd === 'string' && probe.cwd.trim() ? probe.cwd : undefined,
    timeout_s: finiteInt(probe.timeout_s, DEFAULT_TIMEOUT_S, 1, 3600),
    ttl_s: finiteInt(probe.ttl_s, DEFAULT_TTL_S, 1, 86400),
    interval_s: finiteInt(probe.interval_s, probe.ttl_s || DEFAULT_TTL_S, 1, 86400),
  };
}

function parseProbeRegistry(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[miser/watchd] WARN invalid MISER_WATCH_PROBES JSON (${err.message}); watcher registry empty`);
    return [];
  }
  const out = [];
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const probe = normalizeProbe(entry);
      if (probe) out.push(probe);
    }
  } else if (isPlainObject(parsed)) {
    for (const [id, entry] of Object.entries(parsed)) {
      const probe = normalizeProbe(entry, id);
      if (probe) out.push(probe);
    }
  } else {
    console.warn('[miser/watchd] WARN MISER_WATCH_PROBES must be an object or array; watcher registry empty');
  }
  return out;
}

function parseWatchConfig(env = process.env) {
  const watchDir = expandHome(env.MISER_WATCH_DIR || DEFAULT_WATCH_DIR);
  let rawProbes = env.MISER_WATCH_PROBES || '';
  const probesFile = expandHome(env.MISER_WATCH_PROBES_FILE || '');
  if (!rawProbes && probesFile) {
    try {
      rawProbes = fs.readFileSync(probesFile, 'utf8');
    } catch (err) {
      console.warn(`[miser/watchd] WARN could not read MISER_WATCH_PROBES_FILE (${err.message}); watcher registry empty`);
    }
  }
  return {
    enabled: !/^(0|false|off|no)$/i.test(env.MISER_WATCH_ENABLED || ''),
    watchDir,
    lockLeaseMs: finiteInt(env.MISER_WATCH_LOCK_LEASE_MS, DEFAULT_LOCK_LEASE_MS, 1000, 24 * 60 * 60 * 1000),
    probes: parseProbeRegistry(rawProbes),
  };
}

function trimBytes(text, maxBytes) {
  let out = String(text || '');
  while (Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = out.slice(0, Math.max(0, out.length - 1));
  }
  return out;
}

function firstLines(lines, n) {
  return lines.slice(0, n);
}

function lastLines(lines, n) {
  return lines.slice(Math.max(0, lines.length - n));
}

function compactOutput(probe, run, paths, maxBytes = MAX_COMPACT_BYTES) {
  const status = String(run.status || 'error').toUpperCase();
  const output = String(run.output || '');
  const lines = output.split(/\r?\n/).filter(line => line.length > 0);
  const highlights = lines
    .filter(line => /\b(fail|failed|failure|error|timeout|red)\b/i.test(line))
    .slice(0, 12);
  const body = [
    `VERDICT: ${status}`,
    `probe: ${probe.id}`,
    `generated_at: ${run.generated_at}`,
    `ttl_s: ${probe.ttl_s}`,
    `status: ${run.status}`,
    `exit_code: ${run.exit_code == null ? 'null' : run.exit_code}`,
    `signal: ${run.signal || 'null'}`,
    `duration_ms: ${run.duration_ms}`,
    `raw_path: ${paths.raw}`,
    '',
    'HIGHLIGHTS:',
    ...(highlights.length ? highlights.map(line => `- ${line}`) : ['- none']),
    '',
    'OUTPUT_HEAD:',
    ...firstLines(lines, 20),
    '',
    'OUTPUT_TAIL:',
    ...lastLines(lines, 20),
    '',
  ].join('\n');
  return trimBytes(body, maxBytes);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function writeTextAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, value, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function acquireLock(lockFile, leaseMs, nowMs = Date.now()) {
  const lock = {
    pid: process.pid,
    created_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + leaseMs).toISOString(),
  };
  try {
    const fd = fs.openSync(lockFile, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(lock, null, 2));
    fs.closeSync(fd);
    return { acquired: true, lock };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  const existing = readJson(lockFile);
  const expiresAt = existing && Date.parse(existing.expires_at);
  if (Number.isFinite(expiresAt) && expiresAt <= nowMs) {
    try { fs.unlinkSync(lockFile); } catch (_) {}
    return acquireLock(lockFile, leaseMs, nowMs);
  }
  return { acquired: false, lock: existing || null };
}

function releaseLock(lockFile) {
  try { fs.unlinkSync(lockFile); } catch (_) {}
}

function captureAppend(current, chunk) {
  if (Buffer.byteLength(current, 'utf8') >= MAX_CAPTURE_BYTES) return current;
  return trimBytes(current + chunk.toString('utf8'), MAX_CAPTURE_BYTES);
}

function runShellCommand(command, opts = {}) {
  const timeoutMs = finiteInt(opts.timeoutMs, DEFAULT_TIMEOUT_S * 1000, 1, 24 * 60 * 60 * 1000);
  const started = Date.now();
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      env: opts.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    function killProbe(signal) {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (_) {
        try { child.kill(signal); } catch (_) {}
      }
    }

    const termTimer = setTimeout(() => {
      timedOut = true;
      killProbe('SIGTERM');
      setTimeout(() => {
        killProbe('SIGKILL');
      }, 1000).unref();
    }, timeoutMs);
    termTimer.unref();

    child.stdout.on('data', chunk => { output = captureAppend(output, chunk); });
    child.stderr.on('data', chunk => { output = captureAppend(output, chunk); });
    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      resolve({
        status: 'error',
        exit_code: null,
        signal: null,
        error: err.message,
        output,
        duration_ms: Date.now() - started,
      });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      resolve({
        status: timedOut ? 'timeout' : code === 0 ? 'ok' : 'error',
        exit_code: code,
        signal: signal || null,
        error: timedOut ? `probe timed out after ${timeoutMs}ms` : code === 0 ? null : `probe exited ${code}`,
        output,
        duration_ms: Date.now() - started,
      });
    });
  });
}

function buildArtifact(probe, run, paths) {
  return {
    version: 1,
    probe_id: probe.id,
    command: probe.command,
    generated_at: run.generated_at,
    ttl_s: probe.ttl_s,
    status: run.status,
    exit_code: run.exit_code,
    signal: run.signal,
    duration_ms: run.duration_ms,
    raw_path: paths.raw,
    compact_path: paths.compact,
    output_bytes: Buffer.byteLength(run.output || '', 'utf8'),
    error: run.error || null,
  };
}

function artifactFreshness(artifact, nowMs = Date.now()) {
  if (!artifact || !artifact.generated_at || !Number.isFinite(artifact.ttl_s)) {
    return { state: 'missing', age_ms: null, age_s: null };
  }
  const generated = Date.parse(artifact.generated_at);
  if (!Number.isFinite(generated)) return { state: 'missing', age_ms: null, age_s: null };
  const ageMs = Math.max(0, nowMs - generated);
  const ttlMs = artifact.ttl_s * 1000;
  return {
    state: ageMs <= ttlMs ? 'fresh' : 'stale',
    age_ms: ageMs,
    age_s: Math.floor(ageMs / 1000),
  };
}

function createWatcher(opts = {}) {
  const enabled = opts.enabled !== false;
  const watchDir = expandHome(opts.watchDir || DEFAULT_WATCH_DIR);
  const lockLeaseMs = finiteInt(opts.lockLeaseMs, DEFAULT_LOCK_LEASE_MS, 1000, 24 * 60 * 60 * 1000);
  const probeList = Array.isArray(opts.probes) ? opts.probes.map(p => normalizeProbe(p)).filter(Boolean) : [];
  const probes = new Map(probeList.map(probe => [probe.id, probe]));
  const nowMs = opts.nowMs || (() => Date.now());
  const runCommand = opts.runCommand || runShellCommand;

  function getProbe(id) {
    return probes.get(id) || null;
  }

  function listProbes() {
    if (!enabled) return [];
    return Array.from(probes.values()).map(probe => ({ ...probe }));
  }

  function pathsFor(id) {
    return artifactPaths(watchDir, id);
  }

  function readArtifact(id) {
    const paths = pathsFor(id);
    return readJson(paths.json);
  }

  function freshness(id) {
    const artifact = readArtifact(id);
    return {
      probe_id: id,
      artifact,
      paths: pathsFor(id),
      ...artifactFreshness(artifact, nowMs()),
    };
  }

  async function refreshProbe(id) {
    if (!enabled) {
      return {
        ok: false,
        status: 'disabled',
        probe_id: id || null,
        disabled: true,
        in_flight: false,
        paths: id ? pathsFor(id) : null,
      };
    }
    const probe = getProbe(id);
    if (!probe) {
      const err = new Error(`unknown watcher probe ${id}`);
      err.statusCode = 404;
      throw err;
    }
    ensureDir(watchDir);
    const paths = pathsFor(id);
    const lock = acquireLock(paths.lock, lockLeaseMs, nowMs());
    if (!lock.acquired) {
      return {
        ok: true,
        status: 'refreshing',
        probe_id: id,
        in_flight: true,
        lock: lock.lock,
        paths,
      };
    }

    try {
      const commandResult = await runCommand(probe.command, {
        cwd: probe.cwd,
        timeoutMs: probe.timeout_s * 1000,
      });
      const run = {
        ...commandResult,
        generated_at: new Date(nowMs()).toISOString(),
      };
      const compact = compactOutput(probe, run, paths);
      const artifact = buildArtifact(probe, run, paths);
      writeTextAtomic(paths.raw, run.output || '');
      writeTextAtomic(paths.compact, compact);
      writeJsonAtomic(paths.json, artifact);
      return {
        ok: artifact.status === 'ok',
        status: artifact.status,
        probe_id: id,
        in_flight: false,
        artifact,
        paths,
      };
    } finally {
      releaseLock(paths.lock);
    }
  }

  async function refreshAll() {
    const out = [];
    for (const probe of listProbes()) {
      out.push(await refreshProbe(probe.id));
    }
    return out;
  }

  return { enabled, watchDir, getProbe, listProbes, pathsFor, readArtifact, freshness, refreshProbe, refreshAll };
}

module.exports = {
  DEFAULT_WATCH_DIR,
  DEFAULT_TIMEOUT_S,
  DEFAULT_TTL_S,
  MAX_COMPACT_BYTES,
  PROBE_ID_RE,
  parseWatchConfig,
  parseProbeRegistry,
  normalizeProbe,
  artifactFreshness,
  compactOutput,
  createWatcher,
  __test: {
    expandHome,
    artifactPaths,
    acquireLock,
    releaseLock,
    runShellCommand,
    trimBytes,
  },
};
