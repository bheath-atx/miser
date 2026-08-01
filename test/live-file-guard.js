'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const GUARD_ENV = 'MISER_LIVE_FILE_GUARD';
const home = os.homedir();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `miser-test-home-guard-${process.pid}-`));
// Every `process.env.X || path.join(os.homedir(), ...)` default in src/ must
// appear here. live-file-guard.test.js scans src/ and fails if one is missing,
// so adding a new HOME-backed file cannot silently escape the guard again.
const homeDefaults = new Map([
  ['MISER_STATS_FILE', path.join(home, '.miser-stats.json')],
  ['MISER_PANEL_STATS_FILE', path.join(home, '.miser-panel-stats.json')],
  ['MISER_ALERT_LEDGER_FILE', path.join(home, '.miser-alert-ledger.json')],
  ['MISER_ROLLUP_DEDUP_FILE', path.join(home, '.miser-rollup-last.txt')],
  ['CODEX_AUTH_PATH', path.join(home, '.codex', 'auth.json')],
]);

const isolatedDefaults = {
  MISER_STATS_FILE: path.join(tmpRoot, 'miser-stats.json'),
  MISER_PANEL_STATS_FILE: path.join(tmpRoot, 'miser-panel-stats.json'),
  MISER_ALERT_LEDGER_FILE: path.join(tmpRoot, 'miser-alert-ledger.json'),
  MISER_ROLLUP_DEDUP_FILE: path.join(tmpRoot, 'miser-rollup-last.txt'),
  CODEX_AUTH_PATH: path.join(tmpRoot, 'codex-auth.json'),
};

for (const [key, value] of Object.entries(isolatedDefaults)) {
  if (!process.env[key]) process.env[key] = value;
}
process.env[GUARD_ENV] = '1';

function normalize(p) {
  if (p instanceof URL) return p.pathname;
  if (Buffer.isBuffer(p)) return p.toString('utf8');
  if (typeof p !== 'string') return null;
  return path.resolve(p);
}

function isHomeMiserPath(p) {
  const resolved = normalize(p);
  if (!resolved) return false;
  const rel = path.relative(home, resolved);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && path.basename(resolved).startsWith('.miser-');
}

function isProtectedDefaultPath(p) {
  const resolved = normalize(p);
  if (!resolved) return false;
  for (const defaultPath of homeDefaults.values()) {
    if (resolved === path.resolve(defaultPath)) return true;
  }
  return isHomeMiserPath(resolved);
}

function blockPath(op, p) {
  if (!isProtectedDefaultPath(p)) return;
  throw new Error(`[miser-live-file-guard] blocked ${op} on live/default path: ${normalize(p)}`);
}

function blockAnyPath(op, args) {
  for (const arg of args) blockPath(op, arg);
}

function wrapSync(name, pathIndexes = [0]) {
  const original = fs[name];
  fs[name] = function guardedFsSync(...args) {
    blockAnyPath(`fs.${name}`, pathIndexes.map(i => args[i]));
    return original.apply(this, args);
  };
}

function wrapCallback(name, pathIndexes = [0]) {
  const original = fs[name];
  fs[name] = function guardedFsCallback(...args) {
    blockAnyPath(`fs.${name}`, pathIndexes.map(i => args[i]));
    return original.apply(this, args);
  };
}

wrapSync('readFileSync');
wrapSync('writeFileSync');
wrapSync('appendFileSync');
wrapSync('unlinkSync');
wrapSync('rmSync');
wrapSync('renameSync', [0, 1]);
wrapSync('copyFileSync', [0, 1]);

wrapCallback('readFile');
wrapCallback('writeFile');
wrapCallback('appendFile');
wrapCallback('unlink');
wrapCallback('rm');
wrapCallback('rename', [0, 1]);
wrapCallback('copyFile', [0, 1]);

const originalCreateWriteStream = fs.createWriteStream;
fs.createWriteStream = function guardedCreateWriteStream(file, ...args) {
  blockPath('fs.createWriteStream', file);
  return originalCreateWriteStream.call(this, file, ...args);
};

const originalOpenSync = fs.openSync;
fs.openSync = function guardedOpenSync(file, flags, ...args) {
  if (typeof flags === 'string' && /[wa+]/.test(flags)) blockPath('fs.openSync', file);
  return originalOpenSync.call(this, file, flags, ...args);
};

const originalOpen = fs.open;
fs.open = function guardedOpen(file, flags, ...args) {
  if (typeof flags === 'string' && /[wa+]/.test(flags)) blockPath('fs.open', file);
  return originalOpen.call(this, file, flags, ...args);
};

function patchPromiseFsTarget(target) {
  for (const name of ['readFile', 'writeFile', 'appendFile', 'unlink', 'rm']) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    target[name] = async function guardedPromiseFs(file, ...args) {
      blockPath(`fs.promises.${name}`, file);
      return original.call(this, file, ...args);
    };
  }
  for (const name of ['rename', 'copyFile']) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    target[name] = async function guardedPromiseFsTwoPaths(from, to, ...args) {
      blockAnyPath(`fs.promises.${name}`, [from, to]);
      return original.call(this, from, to, ...args);
    };
  }
  const originalOpenPromise = target.open;
  if (typeof originalOpenPromise === 'function') {
    target.open = async function guardedPromiseOpen(file, flags, ...args) {
      if (typeof flags === 'string' && /[wa+]/.test(flags)) blockPath('fs.promises.open', file);
      return originalOpenPromise.call(this, file, flags, ...args);
    };
  }
}

function patchPromiseFs() {
  if (fs.promises) patchPromiseFsTarget(fs.promises);
  patchPromiseFsTarget(fsp);
}

patchPromiseFs();

const originalHomedir = os.homedir;
os.homedir = function guardedHomedir() {
  const stack = new Error().stack || '';
  if (/src[\/\\](stats|panel-stats|alert-ledger|daily-rollup|oauth)\.js/.test(stack)) {
    throw new Error('[miser-live-file-guard] blocked HOME default resolution from protected miser module');
  }
  return originalHomedir.call(this);
};

function snapshotHomeMiserFiles() {
  const out = new Map();
  let names = [];
  try {
    names = fs.readdirSync(home).filter(name => name.startsWith('.miser-'));
  } catch (err) {
    throw new Error(`[miser-live-file-guard] cannot list HOME for live-file snapshot: ${err.message}`);
  }
  for (const name of names) {
    const file = path.join(home, name);
    const stat = fs.statSync(file);
    out.set(name, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      mode: stat.mode,
    });
  }
  return out;
}

const initialHomeMiserFiles = snapshotHomeMiserFiles();

function assertSafeResolvedPath(envName, resolvedPath) {
  const defaultPath = homeDefaults.get(envName);
  if (!defaultPath) throw new Error(`[miser-live-file-guard] unknown guarded env: ${envName}`);
  if (path.resolve(resolvedPath) === path.resolve(defaultPath)) {
    throw new Error(`[miser-live-file-guard] ${envName} resolved to live HOME default: ${defaultPath}`);
  }
  if (envName !== 'CODEX_AUTH_PATH' && isHomeMiserPath(resolvedPath)) {
    throw new Error(`[miser-live-file-guard] ${envName} resolved under live HOME .miser-* path: ${resolvedPath}`);
  }
}

function assertProtectedEnvIsIsolated() {
  for (const envName of homeDefaults.keys()) {
    const value = process.env[envName];
    if (!value) throw new Error(`[miser-live-file-guard] ${envName} is unset during guarded test run`);
    assertSafeResolvedPath(envName, value);
  }
}

function assertNoHomeMiserFilesModified() {
  const current = snapshotHomeMiserFiles();
  const beforeNames = [...initialHomeMiserFiles.keys()].sort();
  const afterNames = [...current.keys()].sort();
  if (beforeNames.join('\0') !== afterNames.join('\0')) {
    throw new Error(`[miser-live-file-guard] live ~/.miser-* file set changed: before=${beforeNames.join(',')} after=${afterNames.join(',')}`);
  }
  for (const name of beforeNames) {
    const before = initialHomeMiserFiles.get(name);
    const after = current.get(name);
    for (const key of ['size', 'mtimeMs', 'ctimeMs', 'mode']) {
      if (before[key] !== after[key]) {
        throw new Error(`[miser-live-file-guard] live ~/${name} changed (${key}: ${before[key]} -> ${after[key]})`);
      }
    }
  }
}

function finalCheck() {
  assertProtectedEnvIsIsolated();
  assertNoHomeMiserFilesModified();
}

process.on('beforeExit', () => {
  try {
    finalCheck();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  }
});

global.__miserLiveFileGuard = {
  tmpRoot,
  homeDefaults,
  isolatedDefaults,
  isHomeMiserPath,
  isProtectedDefaultPath,
  assertSafeResolvedPath,
  assertProtectedEnvIsIsolated,
  assertNoHomeMiserFilesModified,
};
