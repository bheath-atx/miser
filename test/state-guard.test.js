'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const guard = require('./_state-guard.js');

function repoPath(...parts) {
  return path.join(__dirname, '..', ...parts);
}

function runGuardProof(script, env = {}) {
  const childHome = fs.mkdtempSync(path.join(os.tmpdir(), `miser-guard-proof-home-${process.pid}-`));
  const child = spawnSync(process.execPath, [
    '--require',
    repoPath('test', '_state-guard.js'),
    '-e',
    script,
  ], {
    cwd: repoPath(),
    env: { PATH: process.env.PATH, HOME: childHome, ...env },
    encoding: 'utf8',
  });
  try { fs.rmSync(childHome, { recursive: true, force: true }); } catch (_) {}
  return child;
}

test('test state guard isolates all default state paths during the suite', () => {
  guard.assertStatePathsIsolated();
  assert.notEqual(path.resolve(process.env.MISER_STATS_FILE), guard.homeDefaults.MISER_STATS_FILE);
  assert.notEqual(path.resolve(process.env.MISER_ALERT_LEDGER_FILE), guard.homeDefaults.MISER_ALERT_LEDGER_FILE);
  assert.notEqual(path.resolve(process.env.MISER_DAILY_ROLLUP_DEDUP_FILE), guard.homeDefaults.MISER_DAILY_ROLLUP_DEDUP_FILE);
  assert.notEqual(path.resolve(process.env.CODEX_AUTH_PATH), guard.homeDefaults.CODEX_AUTH_PATH);
});

test('test state guard proves modules fail when HOME defaults would be resolved', () => {
  const cases = [
    ['stats', "require('./src/stats.js')", 'MISER_STATS_FILE'],
    ['alert-ledger', "require('./src/alert-ledger.js').createLedger()", 'MISER_ALERT_LEDGER_FILE'],
    ['daily-rollup', "require('./src/daily-rollup.js')", 'MISER_DAILY_ROLLUP_DEDUP_FILE'],
    ['oauth', "require('./src/oauth.js')", 'CODEX_AUTH_PATH'],
  ];

  for (const [label, script, envName] of cases) {
    const child = runGuardProof(script, {
      MISER_TEST_GUARD_NO_AUTO_ENV: '1',
      MISER_TEST_GUARD_SKIP_STARTUP_ASSERT: '1',
      MISER_TEST_STATE_GUARD: '1',
    });
    assert.notEqual(child.status, 0, label);
    assert.match(child.stderr, new RegExp(`${envName}|MISER_TEST_HOME_DEFAULT`), label);
  }
});

test('test state guard proves HOME .miser writes fail without touching the live HOME', () => {
  const child = runGuardProof(`
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    fs.writeFileSync(path.join(os.homedir(), '.miser-guard-proof'), 'x');
  `);
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /blocked fs\.writeFileSync on HOME state file/);
});
