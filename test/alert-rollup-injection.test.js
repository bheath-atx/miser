'use strict';

// AR24 — rollup route injection is real, and it WINS.
//
// §4 specifies this as "new rows in test/rollup.test.js". I put it in its own
// file instead, deliberately: AR15 requires test/rollup.test.js to pass
// UNMODIFIED as the non-regression signal, and "unmodified" is a stronger,
// easier-to-audit claim if the file is literally byte-untouched. Nothing about
// the oracle depends on which file it lives in.
//
// Codex's objection to AR15 was that unmodified tests cannot prove composition —
// correct. This is the composition oracle: it beats a DECOY env value, which is
// the only way to show the injected resolver is actually consulted rather than
// the env being read again behind it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { emitDailyRollup, defaultRouteFromEnv } = require('../src/daily-rollup.js');

const SRC_DIR = path.join(__dirname, '..', 'src');

// Same shape the existing rollup suite uses (test/rollup.test.js's `usage`
// helper), so buildRollupText actually produces text and the oracle exercises a
// real post rather than short-circuiting on no_data.
function statsFixture(day = '2026-08-04') {
  return { [day]: { alpha: { usage: { anthropic: { 'claude-sonnet-4-6': { input: 1_000_000 } } } } } };
}

test('AR24: an injected resolveRoute BEATS a decoy MISER_PKACHU_ENDPOINT', async () => {
  const prev = { e: process.env.MISER_PKACHU_ENDPOINT, t: process.env.MISER_PKACHU_TOKEN };
  const dedupFile = path.join(os.tmpdir(), `miser-ar24-dedup-${process.pid}-${Date.now()}`);
  try {
    // DECOY: if the rollup still read env behind the resolver, it would post here.
    process.env.MISER_PKACHU_ENDPOINT = 'http://127.0.0.1:9/DECOY-must-not-be-used';
    process.env.MISER_PKACHU_TOKEN = '/tmp/miser-ar24-decoy-token';

    // A REAL token file, so readToken succeeds and the assertion is direct: the
    // stub transport must receive the injected endpoint AND the injected token.
    const injectedTokenFile = path.join(os.tmpdir(), `miser-ar24-injected-token-${process.pid}`);
    fs.writeFileSync(injectedTokenFile, 'INJECTED-TOK', 'utf8');
    const injected = { endpoint: 'http://127.0.0.1:9/injected', tokenFile: injectedTokenFile };
    const seen = [];
    const stubPkachu = async (endpoint, token, text) => { seen.push({ endpoint, token, text }); };

    let asked = 0;
    const result = await emitDailyRollup(statsFixture(), stubPkachu, {
      now: new Date('2026-08-04T00:00:30Z'),
      dedupFile,
      resolveRoute: (project) => {
        asked += 1;
        // Fleet scope: the rollup folds every project into one digest, so it must
        // ask for the null-project route (case A), never fabricate a project.
        assert.equal(project, null, 'the rollup resolves the FLEET route (case A), not a per-project one');
        return injected;
      },
    });

    assert.equal(asked, 1, 'the injected resolver was actually consulted');
    assert.equal(result.emitted, true, `rollup should have emitted (got ${JSON.stringify(result)})`);
    assert.equal(seen.length, 1, 'exactly one post');
    assert.equal(seen[0].endpoint, injected.endpoint,
      'the stub received the INJECTED endpoint, not the decoy');
    assert.equal(seen[0].token, 'INJECTED-TOK',
      'and the INJECTED token file was read, not the decoy token');
    assert.notEqual(seen[0].endpoint, process.env.MISER_PKACHU_ENDPOINT, 'the decoy was not used');
    try { fs.unlinkSync(injectedTokenFile); } catch (_) {}
  } finally {
    if (prev.e === undefined) delete process.env.MISER_PKACHU_ENDPOINT; else process.env.MISER_PKACHU_ENDPOINT = prev.e;
    if (prev.t === undefined) delete process.env.MISER_PKACHU_TOKEN; else process.env.MISER_PKACHU_TOKEN = prev.t;
    try { fs.unlinkSync(dedupFile); } catch (_) {}
  }
});

test('AR24/AR15: WITHOUT injection the env path still yields reason:no_env (unchanged)', async () => {
  const prev = { e: process.env.MISER_PKACHU_ENDPOINT, t: process.env.MISER_PKACHU_TOKEN };
  const dedupFile = path.join(os.tmpdir(), `miser-ar24-noenv-${process.pid}-${Date.now()}`);
  try {
    delete process.env.MISER_PKACHU_ENDPOINT;
    delete process.env.MISER_PKACHU_TOKEN;
    const prevWarn = console.warn;
    console.warn = () => {};
    let out;
    try {
      out = await emitDailyRollup(statsFixture(), async () => {}, { now: new Date('2026-08-04T00:00:30Z'), dedupFile });
    } finally { console.warn = prevWarn; }
    // Both branches converge on the same function, so the un-injected path is not
    // a second policy — it is the same policy reached without the resolver.
    assert.equal(out.emitted, false);
    assert.equal(out.reason, 'no_env', 'the no_env shape is byte-identical to origin/main');
    assert.equal(defaultRouteFromEnv(), null, 'and the ONE env reader agrees');
  } finally {
    if (prev.e === undefined) delete process.env.MISER_PKACHU_ENDPOINT; else process.env.MISER_PKACHU_ENDPOINT = prev.e;
    if (prev.t === undefined) delete process.env.MISER_PKACHU_TOKEN; else process.env.MISER_PKACHU_TOKEN = prev.t;
    try { fs.unlinkSync(dedupFile); } catch (_) {}
  }
});

test('AR24: source shape — index.js injects resolveRoute, and the interval threads it', () => {
  const idx = fs.readFileSync(path.join(SRC_DIR, 'index.js'), 'utf8');
  assert.match(idx, /startDailyRollupInterval\(getRawStatsSnapshot,\s*\{/,
    'index.js passes an opts object into startDailyRollupInterval');
  assert.match(idx, /resolveRoute:/, 'and that object carries resolveRoute');

  const rollup = fs.readFileSync(path.join(SRC_DIR, 'daily-rollup.js'), 'utf8');
  assert.match(rollup, /resolveRoute: opts\.resolveRoute/,
    'startDailyRollupInterval threads opts.resolveRoute through to emitDailyRollup');
  assert.match(rollup, /opts\.resolveRoute \? opts\.resolveRoute\(null\) : defaultRouteFromEnv\(\)/,
    'emitDailyRollup prefers the injected resolver and falls back to the ONE env reader');

  // §2.6's accurate claim: exactly ONE IMPLEMENTATION reads MISER_PKACHU_*, and
  // both callers route through it (not "exactly one call site", which R2 overstated).
  const readers = [...rollup.matchAll(/process\.env\.MISER_PKACHU_ENDPOINT/g)].length;
  assert.equal(readers, 1, 'exactly one implementation reads MISER_PKACHU_ENDPOINT in daily-rollup.js');
  const routesSrc = fs.readFileSync(path.join(SRC_DIR, 'alert-routes.js'), 'utf8');
  assert.ok(!routesSrc.includes('process.env.MISER_PKACHU_ENDPOINT'),
    'alert-routes.js does NOT read the env itself — it consumes defaultRouteFromEnv');
});
