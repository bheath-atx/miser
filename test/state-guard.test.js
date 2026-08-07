'use strict';

// AR17 / AR18 — the §3.4 preload's two additions, asserted as RULES.
//
// This file was named as the oracle for both ACs from R2 onward and was never
// written; BUILDER-AUDIT R1 caught that. test/live-file-guard.test.js is E3's
// companion and covers HOME-file isolation only — neither the env scrub nor the
// network guard had an assertion.
//
// Both are asserted through a CHILD PROCESS carrying the variables, because
// that is the only way to observe the preload doing its job: this process has
// already been scrubbed by the time any test runs, so asserting on
// `process.env` here would pass whether or not the scrub exists.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function runChild(code, extraEnv) {
  return spawnSync(
    process.execPath,
    ['--require', './test/live-file-guard.js', '-e', code],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...extraEnv } },
  );
}

test('AR17: the preload scrubs every /^MISER_ALERT_ROUTES/ key plus MISER_PKACHU_*, as a rule', () => {
  // The fifth variable is INVENTED. That is the point of the AC: a preload that
  // deletes a hard-coded list passes for the four real names and fails here,
  // which is what makes the guard future-proof instead of a snapshot. R3 added
  // two of these variables after the list was first written, so this is a
  // demonstrated failure mode, not a hypothetical one.
  const vars = {
    MISER_ALERT_ROUTES_ALLOW_REMOTE: '1',
    MISER_ALERT_ROUTES_UNROUTED: 'escalate',
    MISER_ALERT_ROUTES_STRICT: '1',
    MISER_ALERT_ROUTES_UNROUTED_MAX: '1',
    MISER_ALERT_ROUTES_ZZZ_FUTURE: '1',
    MISER_PKACHU_ENDPOINT: 'http://127.0.0.1:8001/should-be-scrubbed',
    MISER_PKACHU_TOKEN: '/tmp/should-be-scrubbed',
  };
  const names = Object.keys(vars);
  const child = runChild(
    `console.log(JSON.stringify(${JSON.stringify(names)}.filter(n => n in process.env)));`,
    vars,
  );
  assert.equal(child.status, 0, `child failed: ${child.stderr}`);
  const survivors = JSON.parse(child.stdout.trim().split('\n').pop());
  assert.deepEqual(survivors, [], 'every routing/pkachu var must be absent after the preload');
});

test('AR17: package.json preloads the guard, so the scrub cannot be bypassed by running node --test directly', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /--require \.\/test\/live-file-guard\.js/,
    'scripts.test must preload the guard');
});

test('AR18: the network guard blocks off-host and the pkachu relay port, and allows ordinary loopback', () => {
  // Destination-shaped allowlist (build-phase finding, §3.4): a blanket deny
  // failed 29 tests that legitimately drive a loopback echo upstream through
  // the real createProxy, so the guard blocks by DESTINATION rather than by
  // the mere act of opening a socket.
  // Every request below is destroyed immediately. Children must be FAST: E3's
  // guard also watches the live ~/.miser-stats.json for mtime changes, and the
  // miser service legitimately writes it while the suite runs, so a child that
  // lingers on a real DNS/TCP attempt fails on an unrelated assertion. Found by
  // this test taking 15s and tripping that check.
  const kill = ".on('error', () => {}).destroy()";
  const rows = [
    ['off-host http.request', `require('http').request('http://example.com/x')${kill}`, true],
    ['off-host https.get', `require('https').get('https://example.com/x')${kill}`, true],
    ['pkachu relay on loopback', `require('http').request('http://127.0.0.1:8001/v1/orch/x/reply')${kill}`, true],
    ['ordinary loopback', `require('http').request('http://127.0.0.1:9/nothing')${kill}`, false],
  ];

  for (const [name, expr, shouldBlock] of rows) {
    const child = runChild(
      `try { ${expr}; console.log('NO_THROW'); } catch (e) { console.log('THREW:' + (e.code || e.message)); }`,
      {},
    );
    assert.equal(child.status, 0, `${name}: child crashed: ${child.stderr}`);
    const out = child.stdout.trim().split('\n').pop();
    if (shouldBlock) {
      // The guard signals via err.code, not via the message text — asserting
      // the code is both the AC's wording and the more durable oracle, since
      // the message is prose that may legitimately be reworded.
      assert.equal(out, 'THREW:MISER_TEST_NETWORK_GUARD', `${name}: must be blocked`);
    } else {
      assert.equal(out, 'NO_THROW', `${name}: must be allowed — a blanket deny breaks 29 existing tests`);
    }
  }
});

test('AR18: MISER_TEST_ALLOW_NETWORK=1 overrides the guard', () => {
  const child = runChild(
    "try { require('http').request('http://example.com/x').on('error', () => {}).destroy();"
    + " console.log('NO_THROW'); } catch (e) { console.log('THREW:' + (e.code || e.message)); }",
    { MISER_TEST_ALLOW_NETWORK: '1' },
  );
  assert.equal(child.status, 0, `child crashed: ${child.stderr}`);
  assert.equal(child.stdout.trim().split('\n').pop(), 'NO_THROW', 'the documented override must work');
});
