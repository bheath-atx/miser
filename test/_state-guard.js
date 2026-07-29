'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const GUARD_ENV = 'MISER_TEST_STATE_GUARD';
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `miser-test-state-${process.pid}-`));
const statePaths = Object.freeze({
  MISER_STATS_FILE: path.join(tempRoot, 'stats.json'),
  MISER_ALERT_LEDGER_FILE: path.join(tempRoot, 'alert-ledger.json'),
  MISER_DAILY_ROLLUP_DEDUP_FILE: path.join(tempRoot, 'rollup-last.txt'),
  CODEX_AUTH_PATH: path.join(tempRoot, 'codex-auth.json'),
});
const homeDefaults = Object.freeze({
  MISER_STATS_FILE: path.join(os.homedir(), '.miser-stats.json'),
  MISER_ALERT_LEDGER_FILE: path.join(os.homedir(), '.miser-alert-ledger.json'),
  MISER_DAILY_ROLLUP_DEDUP_FILE: path.join(os.homedir(), '.miser-rollup-last.txt'),
  CODEX_AUTH_PATH: path.join(os.homedir(), '.codex', 'auth.json'),
});

process.env[GUARD_ENV] = '1';
if (process.env.MISER_TEST_GUARD_NO_AUTO_ENV !== '1') {
  for (const [name, value] of Object.entries(statePaths)) {
    if (!process.env[name]) process.env[name] = value;
  }
}

function toPathname(value) {
  if (typeof value === 'string') return value;
  if (value instanceof URL && value.protocol === 'file:') return fileURLToPath(value);
  return null;
}

function absolute(value) {
  const pathname = toPathname(value);
  return pathname == null ? null : path.resolve(pathname);
}

function isHomeMiserFile(value) {
  const target = absolute(value);
  if (!target) return false;
  return path.dirname(target) === path.resolve(os.homedir())
    && path.basename(target).startsWith('.miser-');
}

function fail(message) {
  const err = new Error(`[miser/test-state-guard] ${message}`);
  err.code = 'MISER_TEST_STATE_GUARD';
  throw err;
}

function assertNotHomeMiserFile(value, op) {
  if (isHomeMiserFile(value)) fail(`blocked ${op} on HOME state file ${absolute(value)}`);
}

function assertStatePathsIsolated() {
  for (const [name, defaultPath] of Object.entries(homeDefaults)) {
    const configured = process.env[name];
    if (!configured) fail(`${name} is unset; tests would resolve ${defaultPath}`);
    if (path.resolve(configured) === path.resolve(defaultPath)) {
      fail(`${name} points at HOME default ${defaultPath}`);
    }
  }
}

function wrapSync(name, pathIndexes) {
  const original = fs[name];
  fs[name] = function (...args) {
    for (const index of pathIndexes) assertNotHomeMiserFile(args[index], `fs.${name}`);
    return Reflect.apply(original, this, args);
  };
}

function wrapOpenSync() {
  const original = fs.openSync;
  fs.openSync = function (...args) {
    const flags = args[1] == null ? 'r' : String(args[1]);
    if (/[wa+]/.test(flags)) assertNotHomeMiserFile(args[0], 'fs.openSync');
    return Reflect.apply(original, this, args);
  };
}

function wrapAsync(name, pathIndexes) {
  const original = fs[name];
  fs[name] = function (...args) {
    for (const index of pathIndexes) assertNotHomeMiserFile(args[index], `fs.${name}`);
    return Reflect.apply(original, this, args);
  };
}

function wrapPromise(name, pathIndexes) {
  const original = fs.promises[name];
  if (typeof original !== 'function') return;
  fs.promises[name] = function (...args) {
    for (const index of pathIndexes) assertNotHomeMiserFile(args[index], `fs.promises.${name}`);
    return Reflect.apply(original, this, args);
  };
}

function wrapPromiseOpen() {
  const original = fs.promises.open;
  if (typeof original !== 'function') return;
  fs.promises.open = function (...args) {
    const flags = args[1] == null ? 'r' : String(args[1]);
    if (/[wa+]/.test(flags)) assertNotHomeMiserFile(args[0], 'fs.promises.open');
    return Reflect.apply(original, this, args);
  };
}

wrapSync('writeFileSync', [0]);
wrapSync('appendFileSync', [0]);
wrapSync('truncateSync', [0]);
wrapSync('unlinkSync', [0]);
wrapSync('rmSync', [0]);
wrapSync('renameSync', [0, 1]);
wrapSync('copyFileSync', [1]);
wrapSync('createWriteStream', [0]);
wrapOpenSync();

wrapAsync('writeFile', [0]);
wrapAsync('appendFile', [0]);
wrapAsync('truncate', [0]);
wrapAsync('unlink', [0]);
wrapAsync('rm', [0]);
wrapAsync('rename', [0, 1]);
wrapAsync('copyFile', [1]);

wrapPromise('writeFile', [0]);
wrapPromise('appendFile', [0]);
wrapPromise('truncate', [0]);
wrapPromise('unlink', [0]);
wrapPromise('rm', [0]);
wrapPromise('rename', [0, 1]);
wrapPromise('copyFile', [1]);
wrapPromiseOpen();

if (process.env.MISER_TEST_GUARD_SKIP_STARTUP_ASSERT !== '1') {
  assertStatePathsIsolated();
}

try {
  const { beforeEach, afterEach } = require('node:test');
  if (process.env.MISER_TEST_GUARD_SKIP_STARTUP_ASSERT !== '1') {
    beforeEach(assertStatePathsIsolated);
    afterEach(assertStatePathsIsolated);
  }
} catch (_) {}

process.on('exit', () => {
  if (process.env.MISER_TEST_GUARD_SKIP_STARTUP_ASSERT !== '1') {
    assertStatePathsIsolated();
  }
});

function guardedEnv() {
  return { [GUARD_ENV]: '1', ...statePaths };
}

module.exports = {
  assertStatePathsIsolated,
  guardedEnv,
  homeDefaults,
  statePaths,
  tempRoot,
};
