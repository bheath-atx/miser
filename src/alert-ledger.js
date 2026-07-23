'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// At-most-once-per-(key, UTC-day) guard for outbound alerts (Sprint B §3).
// Key convention: `<feature>:<project>:<type>` (e.g. `budget:pkachu:warn`,
// `policy:aetheria:drift`).
//
// FACTORY-ONLY, no module-level singleton: requiring this file performs ZERO
// file I/O. index.js calls createLedger() explicitly — and only when at least
// one guardrail is configured — so a guardrails-OFF process never touches the
// ledger file. budgets.js / policy-watchdog.js receive the instance via
// guardDeps.ledger; they never import or instantiate it themselves.
//
// Durability contract (normative, §2.5):
// - in-memory mark is synchronous (zero I/O on the request path);
// - file write is fire-and-forget async (atomic temp+rename, like stats.js);
// - startup load is synchronous (like loadStats()); corrupt/missing file →
//   empty ledger + one warning (worst case: one duplicate alert, accepted).

function defaultLedgerFile() {
  return process.env.MISER_ALERT_LEDGER_FILE
    || path.join(os.homedir(), '.miser-alert-ledger.json');
}

function createLedger(filePath, nowFn = () => new Date()) {
  const file = filePath || defaultLedgerFile();
  const entries = new Map(); // key -> 'YYYY-MM-DD' (UTC day the alert was sent)
  let writeChain = Promise.resolve();

  function todayDay() {
    return nowFn().toISOString().slice(0, 10);
  }

  // Prune entries older than 2 days (on load and on every write). Only the
  // current UTC day matters for dedup; retention is pure hygiene.
  function prune() {
    const cutoff = new Date(nowFn());
    cutoff.setUTCHours(0, 0, 0, 0);
    cutoff.setUTCDate(cutoff.getUTCDate() - 2);
    const cutoffKey = cutoff.toISOString().slice(0, 10);
    for (const [key, day] of entries) {
      if (typeof day !== 'string' || day < cutoffKey) entries.delete(key);
    }
  }

  // Synchronous load (mirrors loadStats() in stats.js).
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, day] of Object.entries(parsed)) {
        if (typeof day === 'string') entries.set(key, day);
      }
    } else {
      console.warn(`[miser/alert-ledger] WARN corrupt ledger file ${file}; starting empty`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Non-ENOENT errors (disk failure, permission) → warn + empty ledger.
      // ENOENT is a clean start (no prior alerts this day) — intentionally silent.
      console.warn(`[miser/alert-ledger] WARN ledger load failed (${err.message}); starting empty`);
    }
    // ENOENT: clean start, no warning needed.
  }
  prune();

  async function writeSnapshot(snapshot) {
    const tmp = file + '.tmp.' + process.pid;
    try {
      await fsp.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
      await fsp.rename(tmp, file);
    } catch (err) {
      try { await fsp.unlink(tmp); } catch (_) {}
      throw err;
    }
  }

  function scheduleWrite() {
    prune();
    const snapshot = Object.fromEntries(entries);
    writeChain = writeChain
      .then(() => writeSnapshot(snapshot))
      .catch((err) => {
        console.warn(`[miser/alert-ledger] WARN ledger write failed: ${err.message}`);
      });
  }

  return {
    // true when no alert for this key has been sent during the current UTC day.
    shouldSend(key) {
      return entries.get(key) !== todayDay();
    },
    // Marks synchronously (in-memory), then schedules the async file write.
    markSent(key) {
      entries.set(key, todayDay());
      scheduleWrite();
    },
    // Drains pending writes — used by tests for deterministic persistence.
    flushNow() {
      return writeChain;
    },
  };
}

module.exports = { createLedger };
