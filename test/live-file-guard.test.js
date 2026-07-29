'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
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

test('live file guard isolates all four HOME-backed defaults through env', () => {
  for (const envName of ['MISER_STATS_FILE', 'MISER_ALERT_LEDGER_FILE', 'MISER_ROLLUP_DEDUP_FILE', 'CODEX_AUTH_PATH']) {
    assert.ok(process.env[envName], `${envName} should be set by the test guard`);
    assert.doesNotThrow(() => guard.assertSafeResolvedPath(envName, process.env[envName]));
    assert.match(process.env[envName], /miser-test-home-guard-/);
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
