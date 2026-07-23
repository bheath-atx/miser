'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createProxy } = require('./proxy.js');
const { flushNow, getRawStatsSnapshot } = require('./stats.js');
const { startDailyRollupInterval } = require('./daily-rollup.js');
const config = require('./config.js');

// --- Single-instance advisory lock -----------------------------------------
// The OS port bind is the AUTHORITATIVE single-instance guard (two processes
// can never both bind 127.0.0.1:<port>). This lockfile is purely advisory: it
// lets an unmanaged/manual `node src/index.js` print a clear message pointing
// at the real owner *before* the bind fails. It must NEVER hard-refuse startup
// on its own — a stale lock left by a crash (under systemd Restart=on-failure)
// would otherwise permanently wedge the service. Stale locks self-heal.
const LOCK_DIR = process.env.XDG_RUNTIME_DIR || os.tmpdir();
const LOCK_FILE = path.join(LOCK_DIR, `miser-${config.port}.lock`);

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM = exists but not ours
}

function writeLock() {
  try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch (_) {}
}

function clearLock() {
  try {
    const cur = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    if (cur === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (_) {}
}

// Pre-flight advisory check (warn only).
try {
  const prev = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
  if (prev && prev !== process.pid && pidAlive(prev)) {
    console.warn(`[miser] WARNING: lockfile ${LOCK_FILE} names live PID ${prev} —`);
    console.warn(`[miser] another miser instance may already own port ${config.port}.`);
    console.warn(`[miser] Inspect the owner:  ss -ltnp 'sport = :${config.port}'`);
  }
} catch (_) { /* no lockfile = clean start */ }

const server = http.createServer(createProxy());
startDailyRollupInterval(getRawStatsSnapshot);

server.listen(config.port, '127.0.0.1', () => {
  writeLock();
  console.log(`[miser] v0.1.0 listening on 127.0.0.1:${config.port} (pid ${process.pid})`);
  console.log(`[miser] lockfile: ${LOCK_FILE}`);
  console.log(`[miser] compress: lossless dedup (no size ceiling); cache-hint ${config.cacheHint ? 'ON' : 'OFF'}`);
  console.log(`[miser] anthropic url: ${config.anthropicUrl}`);
  console.log(`[miser] ollama url: ${config.ollamaUrl}`);
  console.log(`[miser] fallback models: ${config.fallbackModels.join(', ')}`);
  console.log(`[miser] env: MISER_PRICING_JSON=${process.env.MISER_PRICING_JSON ? 'set' : 'unset'} MISER_PKACHU_TOKEN=${process.env.MISER_PKACHU_TOKEN ? 'set' : 'unset'} MISER_PKACHU_ENDPOINT=${process.env.MISER_PKACHU_ENDPOINT ? 'set' : 'unset'}`);
  console.log(`[miser] health: GET http://127.0.0.1:${config.port}/api/miser/health`);
  console.log(`[miser] quota:  GET http://127.0.0.1:${config.port}/api/miser/quota`);
  console.log(`[miser] trend:  GET http://127.0.0.1:${config.port}/api/miser/stats/trend`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[miser] FATAL: 127.0.0.1:${config.port} is already in use — another process owns the port.`);
    console.error(`[miser] Identify the owner:   ss -ltnp 'sport = :${config.port}'`);
    console.error(`[miser] If it is an orphaned miser, let systemd reconcile it:  systemctl --user restart miser`);
    console.error(`[miser] Do NOT blind-kill the port owner. systemd will retry per Restart=on-failure.`);
  } else {
    console.error('[miser] server error:', err.message);
  }
  process.exit(1);
});

let shuttingDown = false;

function closeServer() {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Safety net: never hang forever if in-flight connections stall close().
  setTimeout(() => {
    console.error('[miser] ERROR shutdown timed out; exiting');
    process.exit(0);
  }, 3000).unref();

  try {
    await closeServer();
  } catch (err) {
    console.error('[miser] ERROR server close failed:', err.message);
  }

  try {
    await withTimeout(flushNow(), 2500, 'stats flush');
  } catch (err) {
    console.error('[miser] ERROR final stats flush failed:', err.message);
  }

  clearLock();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('exit', clearLock);
