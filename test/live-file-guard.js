'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const GUARD_ENV = 'MISER_LIVE_FILE_GUARD';

// ---------------------------------------------------------------------------
// EXTENSION for the sendAlert-routing sprint (PROPOSAL §3.4, AR17/AR18).
//
// This guard already isolates HOME state files. Two additions here, folded into
// it rather than shipped as a second preloaded guard: §3.4 was written when main
// had a bare `node --test` and specified porting sprint/miser-E's
// `test/_state-guard.js`. Sprint E3 landed this file first, so a port would have
// meant two overlapping isolation implementations competing for the single
// `--require` slot. Extending the merged one is strictly better — its companion
// live-file-guard.test.js scans src/ for HOME-backed defaults, which is a real
// registry-rot guard E's version lacked.
//
// (1) ALERT-ENV SCRUB, BY PREFIX RATHER THAN BY LIST. A hand-maintained list
//     naming MISER_PKACHU_*, MISER_ALERT_ROUTES and _OPS would have broken the
//     moment the sprint added _STRICT and _UNROUTED_MAX — which it did. Deleting
//     every /^MISER_ALERT_ROUTES/ key covers every future route flag on the day
//     it is invented, with no edit here. AR17 asserts the RULE via a spawned
//     child carrying an INVENTED variable, not a snapshot of today's names.
//     This runs FIRST, before any require of src/, because config.js reads the
//     alert-route env at module load.
const SCRUBBED_PREFIXES = Object.freeze([/^MISER_ALERT_ROUTES/]);
const SCRUBBED_KEYS = Object.freeze(['MISER_PKACHU_ENDPOINT', 'MISER_PKACHU_TOKEN']);

function scrubAlertEnv() {
  for (const key of Object.keys(process.env)) {
    if (SCRUBBED_PREFIXES.some(re => re.test(key))) delete process.env[key];
  }
  for (const key of SCRUBBED_KEYS) delete process.env[key];
}
scrubAlertEnv();

// (2) NETWORK GUARD. Destination-shaped, not blanket default-deny: several
//     existing suites legitimately drive a LOOPBACK ECHO UPSTREAM through the
//     real createProxy (the AC8/AC10 canaries, compact-hint, breaker, and Sprint
//     B guardrail integration tests), and AR18 requires the full suite to pass
//     with the guard armed. So loopback is allowed, egress is blocked, and the
//     pkachu relay port is blocked EVEN ON LOOPBACK — that is the one loopback
//     destination whose traffic would be a real alert carrying a real bearer
//     token, i.e. exactly what this sprint exists to stop misrouting.
//
//     This is A NET, not the fix. Layer 1 is the fix: with all four production
//     fallbacks deleted there is no expression in src/ that can produce a
//     network-capable dispatcher, so an un-injected guardDeps.sendAlert is
//     undefined and the §3.3 guard fires. Do not mistake one for the other.
const NETWORK_ALLOW = 'MISER_TEST_ALLOW_NETWORK';
const NET_LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]', '']);
const NET_RELAY_PORTS = new Set(['8001']);   // pkachu relay (secrets.env:38)

function netDestination(args) {
  const a = args[0];
  let host = '';
  let port = '';
  if (typeof a === 'string') {
    try { const u = new URL(a); host = u.hostname; port = u.port; } catch (_) { return { host: '?', port: '' }; }
  } else if (a instanceof URL) {
    host = a.hostname; port = a.port;
  } else if (a && typeof a === 'object') {
    host = a.hostname || a.host || '';
    port = a.port == null ? '' : String(a.port);
    if (host.includes(':')) host = host.split(':')[0];
  }
  return { host, port };
}

function wrapNetwork(mod, modName, name) {
  const original = mod[name];
  if (typeof original !== 'function') return;
  mod[name] = function (...args) {
    if (process.env[NETWORK_ALLOW] !== '1') {
      const { host, port } = netDestination(args);
      const offHost = !NET_LOOPBACK.has(host);
      const relay = NET_LOOPBACK.has(host) && NET_RELAY_PORTS.has(port);
      if (offHost || relay) {
        const err = new Error(
          `[miser-live-file-guard] blocked ${modName}.${name} to ${host}:${port || '-'} — ` +
          (relay
            ? 'that is the pkachu relay port; a test must never post a real alert. '
            : 'tests must not open off-host sockets. ') +
          `Inject a transport seam (createAlertDispatcher's {post}) instead; set ` +
          `${NETWORK_ALLOW}=1 only if a test deliberately needs this destination.`
        );
        err.code = 'MISER_TEST_NETWORK_GUARD';
        throw err;
      }
    }
    return Reflect.apply(original, this, args);
  };
}

for (const netName of ['request', 'get']) {
  wrapNetwork(require('node:http'), 'http', netName);
  wrapNetwork(require('node:https'), 'https', netName);
}
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
  ['MISER_WEEKLY_CAPS_FILE', path.join(home, '.claude', 'weekly-caps.json')],
  ['CODEX_AUTH_PATH', path.join(home, '.codex', 'auth.json')],
]);

const isolatedDefaults = {
  MISER_STATS_FILE: path.join(tmpRoot, 'miser-stats.json'),
  MISER_PANEL_STATS_FILE: path.join(tmpRoot, 'miser-panel-stats.json'),
  MISER_ALERT_LEDGER_FILE: path.join(tmpRoot, 'miser-alert-ledger.json'),
  MISER_ROLLUP_DEDUP_FILE: path.join(tmpRoot, 'miser-rollup-last.txt'),
  MISER_WEEKLY_CAPS_FILE: path.join(tmpRoot, 'weekly-caps.json'),
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
  if (/src[\/\\](stats|panel-stats|alert-ledger|daily-rollup|oauth|weekly-caps)\.js/.test(stack)) {
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
  // Exported so AR17/AR18 can assert the RULE rather than a snapshot of today's
  // variables or a hard-coded host list.
  SCRUBBED_PREFIXES,
  SCRUBBED_KEYS,
  scrubAlertEnv,
  NETWORK_ALLOW,
  tmpRoot,
  homeDefaults,
  isolatedDefaults,
  isHomeMiserPath,
  isProtectedDefaultPath,
  assertSafeResolvedPath,
  assertProtectedEnvIsIsolated,
  assertNoHomeMiserFilesModified,
};
