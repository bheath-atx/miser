'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MAX_COMPACT_BYTES,
  parseProbeRegistry,
  parseWatchConfig,
  artifactFreshness,
  compactOutput,
  createWatcher,
} = require('../src/watchd.js');

function tmpWatchDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `miser-watchd-${label}-${process.pid}-`));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('probe registry accepts object and array forms and rejects invalid probes', () => {
  const probes = parseProbeRegistry(JSON.stringify({
    ci: { command: 'gh run list', ttl_s: 90, timeout_s: 5 },
    bad: { ttl_s: 10 },
    'bad/id': { command: 'echo no' },
    stats: 'curl -sS http://127.0.0.1:20128/api/miser/stats',
  }));
  assert.deepEqual(probes.map(p => p.id), ['ci', 'stats']);
  assert.equal(probes[0].ttl_s, 90);
  assert.equal(probes[0].timeout_s, 5);
  assert.equal(probes[1].ttl_s, 300);

  const array = parseProbeRegistry(JSON.stringify([{ id: 'health', command: 'echo ok' }]));
  assert.deepEqual(array.map(p => p.id), ['health']);
});

test('watch config can load probe registry from a configured file', () => {
  const dir = tmpWatchDir('registry-file');
  const file = path.join(dir, 'probes.json');
  fs.writeFileSync(file, JSON.stringify({ stats: { command: 'echo stats', ttl_s: 300 } }));
  const cfg = parseWatchConfig({
    MISER_WATCH_DIR: dir,
    MISER_WATCH_PROBES_FILE: file,
  });
  assert.equal(cfg.watchDir, dir);
  assert.deepEqual(cfg.probes.map(p => p.id), ['stats']);
});

test('watch config env registry overrides configured file registry', () => {
  const dir = tmpWatchDir('registry-override');
  const file = path.join(dir, 'probes.json');
  fs.writeFileSync(file, JSON.stringify({ stale: { command: 'echo stale' } }));
  const cfg = parseWatchConfig({
    MISER_WATCH_DIR: dir,
    MISER_WATCH_PROBES_FILE: file,
    MISER_WATCH_PROBES: JSON.stringify({ fresh: { command: 'echo fresh' } }),
  });
  assert.deepEqual(cfg.probes.map(p => p.id), ['fresh']);
});

test('artifact freshness reports missing, fresh, and stale states', async () => {
  let now = Date.parse('2026-08-30T12:00:00.000Z');
  const dir = tmpWatchDir('freshness');
  const watcher = createWatcher({
    watchDir: dir,
    nowMs: () => now,
    probes: [{ id: 'probe', command: 'echo ok', ttl_s: 10, timeout_s: 5 }],
    runCommand: async () => ({
      status: 'ok',
      exit_code: 0,
      signal: null,
      error: null,
      output: 'all good',
      duration_ms: 12,
    }),
  });

  assert.equal(watcher.freshness('probe').state, 'missing');
  const result = await watcher.refreshProbe('probe');
  assert.equal(result.status, 'ok');
  assert.equal(watcher.freshness('probe').state, 'fresh');
  now += 11_000;
  assert.equal(watcher.freshness('probe').state, 'stale');
});

test('refresh writes JSON, raw, and compact artifacts with verdict-first compact output', async () => {
  const dir = tmpWatchDir('artifacts');
  const watcher = createWatcher({
    watchDir: dir,
    nowMs: () => Date.parse('2026-08-30T12:00:00.000Z'),
    probes: [{ id: 'ci', command: 'echo ok', ttl_s: 90, timeout_s: 5 }],
    runCommand: async () => ({
      status: 'ok',
      exit_code: 0,
      signal: null,
      error: null,
      output: 'line 1\nFAIL marker retained\nline 3',
      duration_ms: 8,
    }),
  });
  const result = await watcher.refreshProbe('ci');
  const paths = watcher.pathsFor('ci');
  const artifact = readJson(paths.json);
  const compact = fs.readFileSync(paths.compact, 'utf8');
  const raw = fs.readFileSync(paths.raw, 'utf8');

  assert.equal(result.ok, true);
  assert.equal(artifact.probe_id, 'ci');
  assert.equal(artifact.generated_at, '2026-08-30T12:00:00.000Z');
  assert.equal(artifact.ttl_s, 90);
  assert.equal(artifact.status, 'ok');
  assert.equal(artifact.raw_path, paths.raw);
  assert.equal(artifact.compact_path, paths.compact);
  assert.equal(raw, 'line 1\nFAIL marker retained\nline 3');
  assert.match(compact, /^VERDICT: OK/);
  assert.match(compact, /FAIL marker retained/);
  assert.ok(Buffer.byteLength(compact, 'utf8') <= MAX_COMPACT_BYTES);
});

test('compact output is capped at 4KB and remains verdict-first', () => {
  const compact = compactOutput(
    { id: 'big', ttl_s: 60 },
    {
      status: 'error',
      generated_at: '2026-08-30T12:00:00.000Z',
      exit_code: 2,
      signal: null,
      error: 'failed',
      output: `ERROR first\n${'x'.repeat(10_000)}`,
      duration_ms: 9,
    },
    { raw: '/tmp/big.raw.txt' }
  );
  assert.match(compact, /^VERDICT: ERROR/);
  assert.ok(Buffer.byteLength(compact, 'utf8') <= MAX_COMPACT_BYTES);
});

test('single-flight lock prevents duplicate concurrent probe execution', async () => {
  const dir = tmpWatchDir('single-flight');
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  let finish;
  const finishPromise = new Promise(resolve => { finish = resolve; });
  let runs = 0;
  const watcher = createWatcher({
    watchDir: dir,
    lockLeaseMs: 30_000,
    probes: [{ id: 'slow', command: 'echo slow', ttl_s: 60, timeout_s: 5 }],
    runCommand: async () => {
      runs += 1;
      started();
      await finishPromise;
      return { status: 'ok', exit_code: 0, signal: null, error: null, output: 'done', duration_ms: 5 };
    },
  });

  const first = watcher.refreshProbe('slow');
  await startedPromise;
  const second = await watcher.refreshProbe('slow');
  assert.equal(second.in_flight, true);
  assert.equal(second.status, 'refreshing');
  assert.equal(runs, 1);
  finish();
  assert.equal((await first).status, 'ok');
  assert.equal(runs, 1);
});

test('expired single-flight lock is replaced by the next refresh', async () => {
  let now = Date.parse('2026-08-30T12:00:00.000Z');
  const dir = tmpWatchDir('expired-lock');
  const watcher = createWatcher({
    watchDir: dir,
    lockLeaseMs: 1000,
    nowMs: () => now,
    probes: [{ id: 'probe', command: 'echo ok', ttl_s: 60, timeout_s: 5 }],
    runCommand: async () => ({ status: 'ok', exit_code: 0, signal: null, error: null, output: 'ok', duration_ms: 1 }),
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(watcher.pathsFor('probe').lock, JSON.stringify({
    pid: 1,
    created_at: '2026-08-30T11:00:00.000Z',
    expires_at: '2026-08-30T11:00:01.000Z',
  }));
  now += 2000;
  const result = await watcher.refreshProbe('probe');
  assert.equal(result.status, 'ok');
});

test('hard timeout writes timeout artifact instead of failing silently', async () => {
  const dir = tmpWatchDir('timeout');
  const watcher = createWatcher({
    watchDir: dir,
    probes: [{
      id: 'timeout',
      command: 'node -e "setTimeout(()=>{}, 5000)"',
      ttl_s: 60,
      timeout_s: 1,
    }],
  });
  const result = await watcher.refreshProbe('timeout');
  const artifact = readJson(watcher.pathsFor('timeout').json);
  const compact = fs.readFileSync(watcher.pathsFor('timeout').compact, 'utf8');

  assert.equal(result.status, 'timeout');
  assert.equal(result.ok, false);
  assert.equal(artifact.status, 'timeout');
  assert.match(artifact.error, /timed out/);
  assert.match(compact, /^VERDICT: TIMEOUT/);
});

test('artifactFreshness treats malformed artifacts as missing', () => {
  assert.equal(artifactFreshness(null).state, 'missing');
  assert.equal(artifactFreshness({ generated_at: 'not-a-date', ttl_s: 1 }).state, 'missing');
});
