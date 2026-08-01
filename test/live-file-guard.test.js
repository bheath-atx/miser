'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const guard = global.__miserLiveFileGuard;
assert.ok(guard, 'live file guard must be preloaded by npm test');

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
  assert.ok(guard.homeDefaults.size >= 5, 'guard must cover at least the five known HOME defaults');
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
