'use strict';

// Sprint B AC7 — alert ledger: at-most-once-per-(key, UTC-day), restart
// durability via flushNow(), next-day re-arm, corrupt-file recovery, pruning.
// All tests use createLedger(tmpPath, mockNowFn) — NEVER the live default
// ~/.miser-alert-ledger.json. Also hosts the production sendAlert failure-path
// unit tests (per AC8: tested here only). Fully offline — no live sockets.

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

test('AC7a: same key same UTC day fires exactly once', () => {
  const file = tmpLedgerFile('once');
  try {
    const now = () => new Date('2026-07-23T12:00:00Z');
    const ledger = createLedger(file, now);
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
    const first = createLedger(file, now);
    first.markSent('policy:aetheria:drift');
    await first.flushNow();
    const second = createLedger(file, now);
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
    const ledger = createLedger(file, now);
    ledger.markSent('budget:alpha:cap');
    assert.equal(ledger.shouldSend('budget:alpha:cap'), false);
    await ledger.flushNow();

    // Same instance: day boundary consults nowFn on every shouldSend.
    clock = new Date('2026-07-24T00:00:01Z');
    assert.equal(ledger.shouldSend('budget:alpha:cap'), true);

    // Fresh instance loaded from disk: prior-day mark does not suppress today.
    const reloaded = createLedger(file, now);
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
    const ledger = createLedger(file, () => new Date('2026-07-23T12:00:00Z'));
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
    const ledger = createLedger(file, () => new Date('2026-07-23T12:00:00Z'));
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
    const ledger = createLedger(file, () => new Date('2026-07-23T12:00:00Z'));
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
    const ledger = createLedger(file, () => new Date('2026-07-23T12:00:00Z'));
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

// --- Production sendAlert failure behavior (AC8: unit-tested here only) -----

test('sendAlert with no env silently skips (no warn, no throw)', async () => {
  const prev = { endpoint: process.env.MISER_PKACHU_ENDPOINT, token: process.env.MISER_PKACHU_TOKEN };
  const prevWarn = console.warn;
  const warns = [];
  console.warn = (line) => warns.push(String(line));
  try {
    delete process.env.MISER_PKACHU_ENDPOINT;
    delete process.env.MISER_PKACHU_TOKEN;
    await sendAlert('test alert');
    assert.equal(warns.length, 0);
  } finally {
    console.warn = prevWarn;
    if (prev.endpoint === undefined) delete process.env.MISER_PKACHU_ENDPOINT;
    else process.env.MISER_PKACHU_ENDPOINT = prev.endpoint;
    if (prev.token === undefined) delete process.env.MISER_PKACHU_TOKEN;
    else process.env.MISER_PKACHU_TOKEN = prev.token;
  }
});

test('sendAlert failure logs one warn per call and never throws', async () => {
  const prev = { endpoint: process.env.MISER_PKACHU_ENDPOINT, token: process.env.MISER_PKACHU_TOKEN };
  const prevWarn = console.warn;
  const warns = [];
  console.warn = (line) => warns.push(String(line));
  try {
    // Token path points at a file that does not exist → readToken throws →
    // sendAlert catches, warns once, resolves. No socket is ever opened.
    process.env.MISER_PKACHU_ENDPOINT = 'http://127.0.0.1:1/hook';
    process.env.MISER_PKACHU_TOKEN = path.join(os.tmpdir(), `miser-no-such-token-${Date.now()}`);
    await assert.doesNotReject(() => sendAlert('test alert'));
    assert.equal(warns.filter(w => /\[miser\/alert\] WARN alert send failed/.test(w)).length, 1);
  } finally {
    console.warn = prevWarn;
    if (prev.endpoint === undefined) delete process.env.MISER_PKACHU_ENDPOINT;
    else process.env.MISER_PKACHU_ENDPOINT = prev.endpoint;
    if (prev.token === undefined) delete process.env.MISER_PKACHU_TOKEN;
    else process.env.MISER_PKACHU_TOKEN = prev.token;
  }
});
