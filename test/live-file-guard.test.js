'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const guard = global.__miserLiveFileGuard;
assert.ok(guard, 'live file guard must be preloaded by npm test');

test('PAIR tests cannot read the live client key or peer membership', async () => {
  const root = path.join(require('node:os').homedir(), '.config', 'Nvidia Corporation', 'Personal AI Router');
  for (const name of ['cluster/node.key', 'cluster/identity.json']) {
    await assert.rejects(fs.promises.readFile(path.join(root, name)), /miser-live-file-guard/);
  }
});

function runGuarded(script) {
  return spawnSync(process.execPath, [
    '--require',
    path.join(__dirname, 'live-file-guard.js'),
    '-e',
    script,
  ], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env },
    encoding: 'utf8',
  });
}

// Driven off the guard's own list rather than a copy of it: a hardcoded list
// here is what let MISER_PANEL_STATS_FILE ship unguarded.
test('live file guard isolates every HOME-backed default through env', () => {
  assert.ok(guard.homeDefaults.size >= 6, 'guard must cover at least the six known HOME defaults');
  for (const envName of guard.homeDefaults.keys()) {
    assert.ok(process.env[envName], `${envName} should be set by the test guard`);
    assert.doesNotThrow(() => guard.assertSafeResolvedPath(envName, process.env[envName]));
    assert.match(process.env[envName], /miser-test-home-guard-/);
  }
});

test('every HOME default in src/ is covered by the guard', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const found = new Map();
  for (const name of fs.readdirSync(srcDir).filter(f => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(srcDir, name), 'utf8');
    const re = /process\.env\.([A-Z0-9_]+)\s*\|\|\s*path\.join\(\s*os\.homedir\(\)/g;
    let match;
    while ((match = re.exec(text)) !== null) found.set(match[1], name);
  }
  assert.ok(found.size >= 5, `expected to find the HOME-backed defaults in src/; found ${found.size}`);
  for (const [envName, file] of found) {
    assert.ok(
      guard.homeDefaults.has(envName),
      `src/${file} resolves ${envName} against HOME but the live-file guard does not protect it`,
    );
  }
});

test('live file guard fails loudly when a guarded path resolves to its HOME default', () => {
  for (const [envName, defaultPath] of guard.homeDefaults.entries()) {
    assert.throws(
      () => guard.assertSafeResolvedPath(envName, defaultPath),
      /resolved to live HOME default/,
      `${envName} should fail on ${defaultPath}`,
    );
  }
});

test('protected modules cannot resolve HOME defaults when their env is unset', () => {
  const cases = [
    ['MISER_STATS_FILE', "require('./src/stats.js')"],
    ['MISER_PANEL_STATS_FILE', "require('./src/panel-stats.js')"],
    ['MISER_ALERT_LEDGER_FILE', "require('./src/alert-ledger.js').createLedger()"],
    ['MISER_ROLLUP_DEDUP_FILE', "require('./src/daily-rollup.js')"],
    ['MISER_WEEKLY_CAPS_FILE', "require('./src/weekly-caps.js')"],
    ['CODEX_AUTH_PATH', "require('./src/oauth.js')"],
  ];
  for (const [envName, body] of cases) {
    const result = runGuarded(`delete process.env.${envName}; ${body};`);
    assert.notEqual(result.status, 0, `${envName} default resolution should fail`);
    assert.match(result.stderr, /blocked HOME default resolution|blocked fs\.readFileSync on live\/default path/);
  }
});

test('stats observation seal writes only to the isolated stats path under test', () => {
  const result = runGuarded(`
    const stats = require('./src/stats.js');
    setTimeout(async () => {
      await stats.flushNow();
      console.log(stats.getPersistenceStatus().file);
    }, 20);
  `);
  assert.equal(result.status, 0, result.stderr);
  const statsFile = result.stdout.trim().split(/\n/).pop();
  assert.notEqual(statsFile, guard.homeDefaults.get('MISER_STATS_FILE'));
  assert.match(statsFile, /miser-test-home-guard-/);
});

// The snapshot override must not weaken detection: against a task-owned fixture
// dir the guard still fails on a modified, added or removed .miser-* file and
// passes when nothing changed.
test('snapshot-dir override still detects changes to .miser-* files in the fixture dir', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'miser-guard-snap-'));
  const fixture = path.join(dir, '.miser-stats.json');
  fs.writeFileSync(fixture, '{}');
  const run = (body) => {
    const r = spawnSync(process.execPath, [
      '--require', path.join(__dirname, 'live-file-guard.js'), '-e', body,
    ], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, MISER_LIVE_FILE_GUARD_SNAPSHOT_DIR: dir },
      encoding: 'utf8',
    });
    return r;
  };
  try {
    const clean = run('0');
    assert.equal(clean.status, 0, clean.stderr);
    const q = JSON.stringify(fixture);
    const modified = run(`require('node:fs').appendFileSync(${q}, ' ')`);
    assert.notEqual(modified.status, 0, 'a modified fixture file must fail the guard');
    assert.match(modified.stderr, /live ~\/\.miser-stats\.json changed/);
    const added = run(`require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, '.miser-new.json'))}, 'x')`);
    assert.notEqual(added.status, 0, 'an added fixture file must fail the guard');
    assert.match(added.stderr, /file set changed/);
    const removed = run(`require('node:fs').unlinkSync(${JSON.stringify(path.join(dir, '.miser-new.json'))})`);
    assert.notEqual(removed.status, 0, 'a removed fixture file must fail the guard');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Snapshot-dir override: retained default, error paths and empty-fixture failure.
// Every subprocess below runs the real guard file. None points HOME, CODEX_HOME
// or any protected env at a live path; the override (when set) names a task-owned
// tmp directory only. The default-path subprocess strips the beforeExit listeners
// in its own -e script (after printing) so it never waits on, or races, the live
// service's background rewrites of the real ~/.miser-* files; the guard file
// itself is unmodified in that run.
// ---------------------------------------------------------------------------
const OVERRIDE_ENV = 'MISER_LIVE_FILE_GUARD_SNAPSHOT_DIR';

function runGuardedWithOverride(overrideValue, body) {
  const env = { ...process.env };
  if (overrideValue === undefined) delete env[OVERRIDE_ENV];
  else env[OVERRIDE_ENV] = overrideValue;
  return spawnSync(process.execPath, [
    '--require', path.join(__dirname, 'live-file-guard.js'), '-e', body,
  ], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
}

test('snapshot-dir default: env unset => the snapshot watches os.homedir()', () => {
  const home = require('node:os').homedir();
  // Pure resolver (declared default), including the empty-string case.
  assert.equal(guard.resolveSnapshotDir(undefined, home), home);
  assert.equal(guard.resolveSnapshotDir('', home), home);
  assert.equal(guard.resolveSnapshotDir('/some/where/../fixture', home), path.resolve('/some/where/../fixture'));
  // The real guard, loaded in a subprocess with the override env UNSET.
  const r = runGuardedWithOverride(undefined,
    "const g = global.__miserLiveFileGuard; process.removeAllListeners('beforeExit');" +
    "process.stdout.write(JSON.stringify({ dir: g.snapshotDir, overridden: g.snapshotDirOverridden }))");
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dir, home, 'env unset: snapshotDir must be os.homedir()');
  assert.equal(out.overridden, false);
  // Empty string is "unset", not a path.
  const e = runGuardedWithOverride('',
    "const g = global.__miserLiveFileGuard; process.removeAllListeners('beforeExit');" +
    "process.stdout.write(JSON.stringify({ dir: g.snapshotDir, overridden: g.snapshotDirOverridden }))");
  assert.equal(e.status, 0, e.stderr);
  assert.deepEqual(JSON.parse(e.stdout), { dir: home, overridden: false });
});

test('snapshot-dir override: nonexistent directory fails loudly and names the path', () => {
  const missing = path.join(require('node:os').tmpdir(), `miser-guard-missing-${process.pid}-${Date.now()}`);
  assert.equal(fs.existsSync(missing), false, 'precondition: path does not exist');
  const r = runGuardedWithOverride(missing, '0');
  assert.notEqual(r.status, 0, 'a nonexistent override dir must not be accepted');
  assert.ok(r.stderr.includes('cannot list'), r.stderr);
  assert.ok(r.stderr.includes(missing), 'error names the offending directory');
  assert.match(r.stderr, /for live-file snapshot/);
  assert.equal(fs.existsSync(missing), false, 'the guard must not create the missing directory');
});

test('snapshot-dir override: a path that is a file, not a directory, fails loudly', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'miser-guard-notdir-'));
  const file = path.join(dir, '.miser-stats.json');
  try {
    fs.writeFileSync(file, '{}');
    const r = runGuardedWithOverride(file, '0');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /cannot list .* for live-file snapshot/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot-dir override: an existing EMPTY fixture directory is rejected (needs >= 1 .miser-* file)', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'miser-guard-empty-'));
  try {
    const r = runGuardedWithOverride(dir, '0');
    assert.notEqual(r.status, 0, 'an empty override dir must fail loudly, not silently watch nothing');
    assert.match(r.stderr, /holds no \.miser-\* protected fixture file/);
    assert.ok(r.stderr.includes(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot-dir override: a dir with only non-.miser-* files is rejected too', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'miser-guard-nonmiser-'));
  try {
    fs.writeFileSync(path.join(dir, 'unrelated.json'), '{}');
    fs.writeFileSync(path.join(dir, 'miser-stats.json'), '{}'); // no leading dot: not protected
    const r = runGuardedWithOverride(dir, '0');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /holds no \.miser-\* protected fixture file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshot-dir override: a populated fixture is accepted, and deleting every .miser-* file is still detected', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'miser-guard-populated-'));
  const only = path.join(dir, '.miser-stats.json');
  try {
    fs.writeFileSync(only, '{}');
    const ok = runGuardedWithOverride(dir, '0');
    assert.equal(ok.status, 0, ok.stderr);
    const gone = runGuardedWithOverride(dir, `require('node:fs').unlinkSync(${JSON.stringify(only)})`);
    assert.notEqual(gone.status, 0, 'removing the last protected file must fail the guard');
    assert.match(gone.stderr, /file set changed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
