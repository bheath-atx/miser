'use strict';
// R14: the CODEX-IQA-R13 BLOCKERs that were still open, each pinned by an
// executable witness.
//   6  text-only dispatch laundering through a PIPELINE (IQA-R13 enforcement.js:941,945,1383)
//   4  curl -K/--config accepted as "provably plain GET"  (IQA-R13 enforcement.js:1839,1861)
// Every assertion below FAILS on the unmodified R13 candidate except where a
// comment marks it as a control that must not move.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const e = require('../src/enforcement.js');
const a = e.__test;
const CLOCK = Date.parse('2026-09-14T00:00:00Z');

function config() {
  return e.parseEnforcement(JSON.stringify({
    '*': { mode: 'observe', override: { overrideFile: path.join(__dirname, '../fixtures/no-overrides.json') } },
    miser: {
      mode: 'throttle',
      poll: { maxLikelyPollsPer10Min: 99, maxLikelyPollsPerHour: 99 },
      orchControl: {
        enabled: true, panels: ['orch'],
        warnSelfWorkTurnsPerAssignment: 99, maxSelfWorkTurnsPerAssignment: 99,
        warnManagementTurnsPerAssignment: 99, maxManagementTurnsPerAssignment: 99,
      },
      redirect: { mode: 'enforce' },
    },
  }));
}
function deps() { return { enforcementConfig: config(), enforcementState: e.createEnforcementState({ nowMs: () => CLOCK }), nowFn: () => new Date(CLOCK), recordEnforcementEvent() {} }; }
function prompt(s) { return { model: 'test', system: 'ROLE: ORCH', messages: [{ role: 'user', content: s }] }; }
function verdict(r) { return r === null ? null : { reason: r.headers['x-miser-enforcement'], cls: r.headers['x-miser-redirect-class'] || '' }; }
function sequence(steps) {
  const d = deps();
  const out = [];
  for (let n = 1; n <= steps.length; n++) {
    const b = prompt('MISER_ASSIGNMENT=A coordinate this lane');
    steps.slice(0, n).forEach((cmd, i) => {
      b.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `s${i}`, name: 'Bash', input: { command: cmd } }] },
                      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `s${i}`, content: 'ok' }] });
    });
    out.push(verdict(e.checkEnforcement('miser', 'orch', b, {}, 0, d, {})));
  }
  return out;
}
function repeat(cmd, n) { return sequence(new Array(n).fill(cmd)); }
const REDIRECTED_TERMDECK = { reason: 'zero-llm-redirect', cls: 'POLL_TERMDECK' };

// ------------------------------------------------------- BLOCKER 6
test('R14 B6: the exact IQA-R13 witness trips EVERY turn, not just once', () => {
  const witness = 'echo "spawn-lane.sh" | curl -s :3100/api/sessions/abc123';
  // No dispatch action runs anywhere in it, so nothing can be armed.
  assert.equal(a.commandRunsDispatchAction(witness), false);
  assert.equal(a.dispatchOkLaundersPoll(witness), true, 'the curl STAGE is an unrelated poll');
  // IQA-R13 asked specifically for the repeated form: 5 turns, all redirected.
  for (const [i, v] of repeat(witness, 5).entries()) {
    assert.deepEqual(v, REDIRECTED_TERMDECK, `turn ${i + 1} must be classified as polling`);
  }
});

test('R14 B6: the poll is caught whichever side of the pipe it sits on', () => {
  const reversed = 'curl -s :3100/api/sessions/abc123 | grep spawn-lane.sh';
  assert.equal(a.dispatchOkLaundersPoll(reversed), true);
  for (const [i, v] of repeat(reversed, 3).entries()) {
    assert.deepEqual(v, REDIRECTED_TERMDECK, `reversed turn ${i + 1}`);
  }
});

test('R14 B6: extra pipe stages and xargs do not launder it either', () => {
  const chained = 'echo "spawn-lane.sh" | cat | curl -s :3100/api/sessions/abc123';
  const viaXargs = 'printf "td-inject.sh\\n" | xargs -I{} curl -s :3100/api/sessions/abc123';
  for (const cmd of [chained, viaXargs]) {
    assert.equal(a.dispatchOkLaundersPoll(cmd), true, cmd);
    for (const [i, v] of repeat(cmd, 3).entries()) {
      assert.deepEqual(v, REDIRECTED_TERMDECK, `${cmd} turn ${i + 1}`);
    }
  }
});

test('R14 B6: a laundering pipeline inside a compound command is caught too', () => {
  const compound = 'ls -1 /tmp; echo "~/bin/spawn-lane.sh --boot x.md" | curl -s :3100/api/sessions/abc123';
  assert.equal(a.dispatchOkLaundersPoll(compound), true);
  for (const [i, v] of repeat(compound, 3).entries()) {
    assert.deepEqual(v, REDIRECTED_TERMDECK, `compound turn ${i + 1}`);
  }
});

test('R14 B6: dispatch proof is anchored on the stage HEAD, not on stage text', () => {
  // Printing a script name proves nothing...
  assert.equal(a.stageIsDispatchAction('echo "spawn-lane.sh"'), false);
  assert.equal(a.stageIsDispatchAction('grep spawn-lane.sh /tmp/log'), false);
  assert.equal(a.stageIsDispatchAction('printf "td-inject.sh\\n"'), false);
  // ...running it does.
  assert.equal(a.stageIsDispatchAction('~/bin/spawn-lane.sh --boot x.md'), true);
  assert.equal(a.stageIsDispatchAction('td-inject abc123 "hello"'), true, 'bare spelling still counts');
  assert.equal(a.stageIsDispatchAction('~/bin/safe-reap.sh abc123'), true);
  assert.equal(a.stageIsDispatchAction('curl -X POST :8001/v1/orch/nacho-orch/reply -d x'), true);
  // An unrecognized head fails CLOSED: it is not a dispatch.
  assert.equal(a.stageIsDispatchAction('jq -r .id'), false);
  assert.equal(a.stageIsDispatchAction(''), false);
});

test('R14 B6: a quoted pipe character is not a stage boundary', () => {
  // CONTROL: `|` inside quotes must not split the dispatch into fake stages.
  const inject = '~/bin/td-inject.sh abc123 "status: replyCount|lastActivity"';
  assert.equal(a.dispatchOkLaundersPoll(inject), false);
  assert.equal(sequence([inject])[0], null);
});

test('R14 B6: an unreachable laundering pipeline neither polls nor is redirected', () => {
  // CONTROL for R13 BLOCKER 3a: the shell skips the whole segment, so there is
  // no poll to redirect.
  const skipped = 'false && echo "spawn-lane.sh" | curl -s :3100/api/sessions/abc123';
  assert.equal(a.dispatchOkLaundersPoll(skipped), false);
  assert.equal(sequence([skipped])[0], null);
});

// ------------------------------- BLOCKER 6: the legitimate case R13 preserved
test('R14 B6 control: a PIPED real dispatch + its one confirmation read is allowed', () => {
  const piped = '~/bin/spawn-lane.sh --boot x.md | tail -1; curl -s :3100/api/sessions/abc123';
  assert.equal(a.commandRunsDispatchAction(piped), true, 'the dispatch really runs in stage 1');
  assert.equal(sequence([piped])[0], null, 'dispatch+confirm may share one call');
});

test('R14 B6 control: a piped dispatch still arms exactly ONE later confirmation', () => {
  const v = sequence([
    '~/bin/spawn-lane.sh --boot x.md | tee /tmp/spawn.log',
    'curl -s :3100/api/sessions/abc123',
    'curl -s :3100/api/sessions/abc123',
  ]);
  assert.equal(v[0], null, 'the dispatch itself is not a poll');
  assert.equal(v[1], null, 'first confirmation read is allowed');
  assert.deepEqual(v[2], REDIRECTED_TERMDECK, 'the second is a poll');
});

test('R14 B6 control: the piped allowance is still bounded', () => {
  const dispatch = '~/bin/spawn-lane.sh --boot x.md | tail -1';
  // ...not three reads, and not a mutation, in that same call.
  assert.deepEqual(sequence([`${dispatch}; curl -s :3100/api/sessions/a :3100/api/sessions/b`])[0],
    REDIRECTED_TERMDECK);
  assert.deepEqual(sequence([`${dispatch}; curl -XDELETE :3100/api/sessions/a`])[0],
    REDIRECTED_TERMDECK);
  // ...and a Miser read riding along gets no dispatch credit (BLOCKER 1 scope).
  assert.notEqual(sequence([`${dispatch}; curl -s :3100/api/sessions/abc123; tail -30 ~/.miser/miser.log`])[0], null);
});

// ------------------------------------------------------- BLOCKER 4
test('R14 B4: external curl configuration is not provably a plain GET', () => {
  for (const c of ['curl -K request.conf :3100/api/sessions/abc123',
                   'curl --config request.conf :3100/api/sessions/abc123',
                   'curl --config=request.conf :3100/api/sessions/abc123',
                   'curl -sK req.conf :3100/api/sessions/abc123',
                   'curl -Kreq.conf :3100/api/sessions/abc123']) {
    assert.equal(a.curlStageIsPlainGet(c), false, c);
    assert.equal(a.isSingleSessionStatusRead(c), false, c);
    assert.deepEqual(sequence(['~/bin/spawn-lane.sh --boot x.md', c])[1], REDIRECTED_TERMDECK, c);
  }
});

test('R14 B4 control: ordinary GET spellings are unaffected', () => {
  for (const c of ['curl -s :3100/api/sessions/abc123',
                   'curl --silent :3100/api/sessions/abc123',
                   'curl -s -H "Authorization: Bearer x" :3100/api/sessions/abc123',
                   'curl -G -d q=1 :3100/api/sessions/abc123',
                   'curl -so /tmp/out :3100/api/sessions/abc123']) {
    assert.equal(a.curlStageIsPlainGet(c), true, c);
    assert.equal(a.isSingleSessionStatusRead(c), true, c);
  }
  // And the R13 mutation refusals still hold.
  for (const c of ['curl -XDELETE :3100/api/sessions/abc123',
                   'curl -sXPOST :3100/api/sessions/abc123',
                   'curl -d @body.json :3100/api/sessions/abc123',
                   'curl --head :3100/api/sessions/abc123']) {
    assert.equal(a.curlStageIsPlainGet(c), false, c);
  }
});
