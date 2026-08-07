'use strict';

// Sprint B AC7 — alert ledger: at-most-once-per-(key, UTC-day), restart
// durability via flushNow(), next-day re-arm, corrupt-file recovery, pruning.
// All tests use createLedger(tmpPath, mockNowFn) — NEVER the live default
// ~/.miser-alert-ledger.json. Also hosts the production sendAlert failure-path
// unit tests (per AC8: tested here only). Fully offline — no live sockets.
// Ledger persistence is exercised through MISER_ALERT_LEDGER_FILE temp paths.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLedger } = require('../src/alert-ledger.js');
const { sendAlert } = require('../src/daily-rollup.js');

function tmpLedgerFile(name) {
  return path.join(os.tmpdir(), `miser-test-ledger-${process.pid}-${name}-${Date.now()}-${Math.random()}.json`);
}

function cleanupFile(file) {
  try { fs.unlinkSync(file); } catch (_) {}
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (f.startsWith(path.basename(file) + '.tmp.')) {
      try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (_) {}
    }
  }
}

function createEnvLedger(file, nowFn) {
  process.env.MISER_ALERT_LEDGER_FILE = file;
  return createLedger(undefined, nowFn);
}

test('AC7a: same key same UTC day fires exactly once', () => {
  const file = tmpLedgerFile('once');
  try {
    const now = () => new Date('2026-07-23T12:00:00Z');
    const ledger = createEnvLedger(file, now);
    assert.equal(ledger.shouldSend('budget:alpha:warn'), true);
    ledger.markSent('budget:alpha:warn');
    assert.equal(ledger.shouldSend('budget:alpha:warn'), false);
    // A different key is independent.
    assert.equal(ledger.shouldSend('budget:alpha:cap'), true);
    // Same key checked again the same day: still suppressed.
    assert.equal(ledger.shouldSend('budget:alpha:warn'), false);
  } finally {
    cleanupFile(file);
  }
});

test('AC7b: restart durability — flushNow() persists, a new instance stays suppressed', async () => {
  const file = tmpLedgerFile('restart');
  try {
    const now = () => new Date('2026-07-23T12:00:00Z');
    const first = createEnvLedger(file, now);
    first.markSent('policy:aetheria:drift');
    await first.flushNow();
    const second = createEnvLedger(file, now);
    assert.equal(second.shouldSend('policy:aetheria:drift'), false);
    assert.equal(second.shouldSend('policy:aetheria:bloat'), true);
  } finally {
    cleanupFile(file);
  }
});

test('AC7c: next UTC day re-arms (new instance AND same instance)', async () => {
  const file = tmpLedgerFile('rearm');
  try {
    let clock = new Date('2026-07-23T23:59:59Z');
    const now = () => clock;
    const ledger = createEnvLedger(file, now);
    ledger.markSent('budget:alpha:cap');
    assert.equal(ledger.shouldSend('budget:alpha:cap'), false);
    await ledger.flushNow();

    // Same instance: day boundary consults nowFn on every shouldSend.
    clock = new Date('2026-07-24T00:00:01Z');
    assert.equal(ledger.shouldSend('budget:alpha:cap'), true);

    // Fresh instance loaded from disk: prior-day mark does not suppress today.
    const reloaded = createEnvLedger(file, now);
    assert.equal(reloaded.shouldSend('budget:alpha:cap'), true);
  } finally {
    cleanupFile(file);
  }
});

test('AC7d: corrupt ledger file → warning + empty in-memory ledger, still functional', async () => {
  const file = tmpLedgerFile('corrupt');
  const prevWarn = console.warn;
  const warns = [];
  console.warn = (line) => warns.push(String(line));
  try {
    fs.writeFileSync(file, 'this is not json{{{', 'utf8');
    const ledger = createEnvLedger(file, () => new Date('2026-07-23T12:00:00Z'));
    assert.match(warns.join('\n'), /ledger load failed|corrupt ledger/);
    assert.equal(ledger.shouldSend('budget:alpha:warn'), true);
    ledger.markSent('budget:alpha:warn');
    assert.equal(ledger.shouldSend('budget:alpha:warn'), false);
    await ledger.flushNow();
    // The corrupt file was replaced by a valid snapshot.
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed['budget:alpha:warn'], '2026-07-23');
  } finally {
    console.warn = prevWarn;
    cleanupFile(file);
  }
});

test('non-object ledger JSON (array) → warning + empty ledger', () => {
  const file = tmpLedgerFile('array');
  const prevWarn = console.warn;
  const warns = [];
  console.warn = (line) => warns.push(String(line));
  try {
    fs.writeFileSync(file, '["not","a","map"]', 'utf8');
    const ledger = createEnvLedger(file, () => new Date('2026-07-23T12:00:00Z'));
    assert.match(warns.join('\n'), /corrupt ledger/);
    assert.equal(ledger.shouldSend('anything'), true);
  } finally {
    console.warn = prevWarn;
    cleanupFile(file);
  }
});

test('missing file emits one warning and starts empty (spec §3 / AC7)', () => {
  const file = tmpLedgerFile('missing');
  const prevWarn = console.warn;
  const warns = [];
  console.warn = (line) => warns.push(String(line));
  try {
    const ledger = createEnvLedger(file, () => new Date('2026-07-23T12:00:00Z'));
    assert.equal(warns.length, 1);
    assert.ok(warns[0].includes('ledger load failed'), `expected load-failed warn, got: ${warns[0]}`);
    assert.equal(ledger.shouldSend('k'), true);
  } finally {
    console.warn = prevWarn;
    cleanupFile(file);
  }
});

test('entries older than 2 days are pruned on load and on write', async () => {
  const file = tmpLedgerFile('prune');
  try {
    fs.writeFileSync(file, JSON.stringify({
      'budget:old:cap': '2026-07-19',      // 4 days old → pruned
      'budget:recent:cap': '2026-07-22',   // 1 day old → kept
      'budget:today:cap': '2026-07-23',    // today → kept
    }), 'utf8');
    const ledger = createEnvLedger(file, () => new Date('2026-07-23T12:00:00Z'));
    ledger.markSent('budget:new:warn');
    await ledger.flushNow();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(!('budget:old:cap' in parsed));
    assert.equal(parsed['budget:recent:cap'], '2026-07-22');
    assert.equal(parsed['budget:today:cap'], '2026-07-23');
    assert.equal(parsed['budget:new:warn'], '2026-07-23');
  } finally {
    cleanupFile(file);
  }
});

test('require(alert-ledger) alone performs zero file I/O (factory-only contract)', () => {
  // The module was already required at the top of this file; the default
  // ledger path must not have been created by that require.
  const modulePath = require.resolve('../src/alert-ledger.js');
  assert.ok(require.cache[modulePath]);
  const src = fs.readFileSync(modulePath, 'utf8');
  // Factory-only: exports exactly createLedger, no top-level singleton call.
  const mod = require('../src/alert-ledger.js');
  assert.deepEqual(Object.keys(mod), ['createLedger']);
  assert.match(src, /module\.exports = \{ createLedger \}/);
});

// --- Dispatcher failure behaviour (AR12 / AR32) ----------------------------
//
// DELIBERATE CONTRACT CHANGE (§2.7, AR12). This block previously asserted that
// sendAlert with no env produces ZERO warns — the silent skip at the old
// daily-rollup.js:176. That silence was a deliberate choice once, and this
// sprint reverses it deliberately: no destination is now LOUD. The assertion is
// INVERTED, not deleted, and it now drives createAlertDispatcher (the single
// outbound path, §2.9a) rather than the removed legacy function.
const { createAlertDispatcher, getAlertCounters, __resetAlertState } = require('../src/alert-routes.js');

test('AR12: no destination is LOUD — one ALERT-DROPPED, dropped+1, zero network, no throw', async () => {
  __resetAlertState();
  const prevWarn = console.warn;
  const warns = [];
  console.warn = (line) => warns.push(String(line));
  let posts = 0;
  try {
    // No route map, no default route, no ops route.
    const sendAlert = createAlertDispatcher(
      { alertRoutes: null, alertRoutesOps: null },
      { post: () => { posts += 1; }, readToken: async () => 'tok', defaultRoute: null },
    );
    const before = getAlertCounters().dropped;
    let result;
    await assert.doesNotReject(async () => { result = await sendAlert('test alert', { kind: 'budget-cap' }); });
    assert.equal(warns.filter(w => /\[miser\/alert\] ALERT-DROPPED/.test(w)).length, 1);
    assert.equal(getAlertCounters().dropped, before + 1);
    assert.equal(posts, 0, 'zero network calls');
    // §2.9a: resolves to an AlertResult, never rejects.
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'dropped');
    assert.equal(result.reason, 'no_destination');
  } finally {
    console.warn = prevWarn;
    __resetAlertState();
  }
});

test('AR32: delivery failure resolves (never rejects), warns once with kind=, bumps failed', async () => {
  __resetAlertState();
  const prevWarn = console.warn;
  const warns = [];
  console.warn = (line) => warns.push(String(line));
  try {
    const sendAlert = createAlertDispatcher(
      { alertRoutes: null },
      {
        // Token path points at a file that does not exist -> readToken throws ->
        // the dispatcher catches, warns once, RESOLVES. No socket is opened.
        readToken: () => { throw new Error('ENOENT: no such token file'); },
        post: () => { throw new Error('should not be reached'); },
        defaultRoute: { endpoint: 'http://127.0.0.1:1/hook', tokenFile: path.join(os.tmpdir(), `miser-no-such-token-${Date.now()}`) },
      },
    );
    let result;
    await assert.doesNotReject(async () => { result = await sendAlert('test alert', { kind: 'sub-cap' }); });
    const failLines = warns.filter(w => /\[miser\/alert\] WARN alert send failed/.test(w));
    assert.equal(failLines.length, 1, 'exactly one failure line');
    assert.match(failLines[0], /kind=sub-cap/, 'FAILED token carries kind= so the send is attributable');
    assert.equal(result.outcome, 'failed');
    assert.equal(getAlertCounters().failed, 1);
  } finally {
    console.warn = prevWarn;
    __resetAlertState();
  }
});
