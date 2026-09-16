'use strict';
// R12: three live NACHO-ORCH false positives reproduced on 2026-09-14 while the
// panel was doing Brad-authorized fleet-recovery dispatch. Hit 2 = a bounded
// read losing its exemption purely by being batched. Hit 3/4 = a sensitive
// DIRECTORY prefix match gating path-only tools that emit no file content.
// NEW = one bounded post-dispatch confirmation read redirected as a poll.
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
      // Budgets raised so this file isolates the redirect/hard-safety surface
      // under test: an ORCH self-work/management WARNING is a different, wholly
      // pre-existing path (a bare `find .` alerts it on the R11 control too).
      orchControl: {
        enabled: true, panels: ['orch'],
        warnSelfWorkTurnsPerAssignment: 99, maxSelfWorkTurnsPerAssignment: 99,
        warnManagementTurnsPerAssignment: 99, maxManagementTurnsPerAssignment: 99,
      },
      redirect: { mode: 'enforce' },
    },
  }));
}
function deps() {
  return { enforcementConfig: config(), enforcementState: e.createEnforcementState({ nowMs: () => CLOCK }), nowFn: () => new Date(CLOCK), recordEnforcementEvent() {} };
}
function prompt(s) { return { model: 'test', system: 'ROLE: ORCH', messages: [{ role: 'user', content: s }] }; }
function tool(c) {
  const b = prompt('MISER_ASSIGNMENT=A coordinate this lane');
  b.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'r12', name: 'Bash', input: { command: c } }] },
                  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r12', content: 'fixture' }] });
  return b;
}
function verdict(r) { return r === null ? null : { reason: r.headers['x-miser-enforcement'], cls: r.headers['x-miser-redirect-class'] || '' }; }
// Ask a direct on-topic question (arms the bounded-read allowance), then run c.
function answer(q, c) {
  const d = deps();
  assert.equal(e.checkEnforcement('miser', 'orch', prompt(q), {}, 0, d, {}), null);
  return verdict(e.checkEnforcement('miser', 'orch', tool(c), {}, 0, d, {}));
}
// A bare command with no armed allowance -- used for the hard-safety cases.
function bare(c) {
  const d = deps();
  return verdict(e.checkEnforcement('miser', 'orch', tool(c), {}, 0, d, {}));
}
function reasonOf(c) { return a.hardSafetyReason({ commandClass: 'NEUTRAL', terminalShape: 'tool_result' }, tool(c)); }
// Multi-turn: each step is one Bash tool_use/tool_result pair; returns per-turn verdicts.
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
const MISER_Q = 'What is in the miser log?';
const REDIRECTED_MISER = { reason: 'zero-llm-redirect', cls: 'POLL_MISER' };
const REDIRECTED_TERMDECK = { reason: 'zero-llm-redirect', cls: 'POLL_TERMDECK' };

// ---------------------------------------------------------------- Hit 2
test('R12 Hit 2 witness: a bounded read keeps its exemption when batched', () => {
  const single = 'tail -30 ~/.miser/miser.log';
  assert.equal(a.isBoundedReadCommand(single), true);
  assert.equal(answer(MISER_Q, single), null);
  // The live witness shape: grep + find + ls|tail + the bounded tail, one call.
  const batched = 'grep -rl "spawn" ~/bin/x.sh; find . -name "BOOT-*.md"; ls -la *.log | tail -5; ' + single;
  assert.equal(a.isBoundedReadCommand(batched), true, batched);
  assert.equal(answer(MISER_Q, batched), null, batched);
  // && and || join the same way, and order does not matter.
  assert.equal(a.isBoundedReadCommand(`ls -la && ${single}`), true);
  assert.equal(a.isBoundedReadCommand(`${single} || echo none`), true);
  assert.equal(answer(MISER_Q, `${single} && head -5 STATUS.md`), null);
});

test('R12 Hit 2: batching still cannot launder an unbounded segment', () => {
  for (const c of [
    'ls -la; tail -f ~/.miser/miser.log',
    'tail -f ~/.miser/miser.log; ls -la',
    'tail -30 ~/.miser/miser.log; while true; do echo x; done',
    'tail -30 ~/.miser/miser.log && watch -n5 ls',
    'cat list.txt | xargs grep x; tail -30 ~/.miser/miser.log',
    'tail -30 ~/.miser/miser.log & tail -f ~/.miser/miser.log',
  ]) {
    assert.equal(a.isBoundedReadCommand(c), false, c);
    assert.deepEqual(answer(MISER_Q, c), REDIRECTED_MISER, c);
  }
  // Single-segment behaviour is unchanged, and a segment-less string is not a read.
  assert.equal(a.isBoundedReadCommand('tail -f ~/.miser/miser.log'), false);
  assert.equal(a.isBoundedReadCommand('tail -30 ~/.miser/miser.log'), true);
  assert.equal(a.isBoundedReadCommand(';;;'), false);
  assert.equal(a.isBoundedReadCommand('   '), false);
});

test('R12 Hit 2: batching relaxes WHO you may batch with, not HOW MANY polls you may run', () => {
  // The inherited PROPOSAL-v4 regressions stay true: the same subject read
  // twice in one call is repeat polling, not one batched bounded read.
  const dup = 'tail -n 50 ~/.miser/miser.log; tail -n 50 ~/.miser/miser.log';
  assert.equal(a.isBoundedReadCommand(dup), true, 'each segment is bounded');
  assert.equal(a.hasAtMostOneSubjectSegment(dup, 'POLL_MISER'), false);
  assert.deepEqual(answer(MISER_Q, dup), REDIRECTED_MISER);
  assert.deepEqual(answer(MISER_Q, 'tail -n 50 ~/.miser/miser.log & tail -n 50 ~/.miser/miser.log'), REDIRECTED_MISER);
  // Two DIFFERENT reads of the same subject are still two polls.
  assert.deepEqual(answer(MISER_Q, 'tail -30 ~/.miser/miser.log; head -5 ~/.miser/events.jsonl'), REDIRECTED_MISER);
  // One subject read plus unrelated bounded work is one poll.
  assert.equal(a.hasAtMostOneSubjectSegment('ls -la; tail -30 ~/.miser/miser.log', 'POLL_MISER'), true);
  assert.equal(answer(MISER_Q, 'ls -la; tail -30 ~/.miser/miser.log'), null);
  // A pipe is one logical read, not two segments.
  assert.equal(a.hasAtMostOneSubjectSegment('tail -30 ~/.miser/miser.log | grep warn', 'POLL_MISER'), true);
  // A class with no subject test is unconstrained by this rule.
  assert.equal(a.hasAtMostOneSubjectSegment('anything; anything', 'NEUTRAL'), true);
});

// -------------------------------------------------------------- Hit 3/4
test('R12 Hit 3/4 witnesses: path-only tools under a sensitive dir no longer trip', () => {
  for (const c of [
    'find ~/.termdeck -iname "*lineage*"',
    'grep -rl "orch" ~/.termdeck',
    'grep -rl "orch" /home/nacho/.termdeck',
    'ls -la ~/.termdeck',
    'find ~/.ssh -name "id_*.pub"',
    'grep --files-with-matches orch ~/.termdeck',
    'grep -RL orch ~/.termdeck',
  ]) {
    assert.equal(reasonOf(c), '', c);
    assert.notEqual((bare(c) || {}).reason, 'orch-hard-safety', c);
  }
});

test('R12 Hit 3/4 controls: genuine content reads under a sensitive dir still trip', () => {
  for (const c of [
    'cat ~/.termdeck/config.yaml',
    'tail -30 ~/.termdeck/config.yaml',
    'head -1 ~/.termdeck/config.yaml',
    'sed -n 1,5p ~/.termdeck/config.yaml',
    'nl ~/.termdeck/config.yaml',
    'grep token ~/.termdeck/config.yaml',
    'rg token ~/.termdeck',
    'cat ~/.ssh/id_rsa',
    'cat /home/nacho/.ssh/id_rsa',
    'cat ~/.claude.json',
    'cat ~/.gitconfig',
    // the live Hit-4 token-extraction shape: grep WITHOUT -l emits the token line
    'TOKEN=$(grep -m1 "^ *token:" ~/.termdeck/config.yaml | awk "{print \\$2}"); curl -s http://127.0.0.1:3200/api/sessions/abc',
    // a path-only head is not a free pass when another stage reads content
    'find ~/.termdeck -iname "*.yaml"; cat ~/.termdeck/config.yaml',
    'grep -rl orch ~/.termdeck | head -3; cat ~/.ssh/config',
    // find that can execute a reader, or write/destroy, is not path-only
    'find ~/.termdeck -name "*.yaml" -exec cat {} \;',
    'find ~/.ssh -name "id_rsa" -delete',
    // an unresolvable wrapper is never "provably" path-only
    'bash -c "cat ~/.ssh/id_rsa"',
    'sh -c "grep -rl x ~/.termdeck"',
    // a value-taking short option consumes the rest of its cluster: -e l is not -l
    'grep -el ~/.termdeck/config.yaml',
    'grep -m2 token ~/.termdeck/config.yaml',
  ]) {
    assert.equal(reasonOf(c), 'sensitive-file-read', c);
    assert.deepEqual(bare(c), { reason: 'orch-hard-safety', cls: '' }, c);
  }
});

test('R12 Hit 3/4: the suppression is proof-based, not head-based', () => {
  // Every sensitive-path stage must be provably path-only, or nothing is suppressed.
  assert.equal(a.sensitiveReadIsProvablyPathOnly('find ~/.termdeck -iname x'), true);
  assert.equal(a.sensitiveReadIsProvablyPathOnly('ls ~/.termdeck; find ~/.ssh -name x'), true);
  assert.equal(a.sensitiveReadIsProvablyPathOnly('ls ~/.termdeck; cat ~/.ssh/id_rsa'), false);
  assert.equal(a.sensitiveReadIsProvablyPathOnly('cat ~/.termdeck/config.yaml'), false);
  // No sensitive stage found by the splitter => unproven => caller keeps tripping.
  assert.equal(a.sensitiveReadIsProvablyPathOnly(''), false);
  // Commands that never referenced a sensitive path are untouched by all of this.
  assert.equal(reasonOf('cat README.md'), '');
  assert.equal(reasonOf('find . -name "BOOT-*.md"'), '');
  // Other hard-safety reasons are unaffected.
  assert.equal(reasonOf('git commit -m x'), 'git-write-operation');
  assert.equal(reasonOf('env | grep ANTHROPIC_TOKEN'), 'sensitive-env');
});

// ------------------------------------------------------- NEW: POLL_TERMDECK
const SPAWN = '~/bin/spawn-lane.sh --project x --panel t1 --boot BOOT.md';
const GET1 = 'curl -s -H "Authorization: Bearer $T" http://127.0.0.1:3200/api/sessions/b42ce915-3e6a-4bee-ad88-05bedab7cd59';
const LIST = 'curl -s -H "Authorization: Bearer $T" http://127.0.0.1:3200/api/sessions';

test('R12 NEW witness: one bounded single-session check after a dispatch is allowed', () => {
  // Without the dispatch, the identical read is still redirected -- this is the
  // exact live false positive, and the exemption is what the action buys.
  assert.deepEqual(sequence(['echo hello', GET1]).at(-1), REDIRECTED_TERMDECK);
  assert.equal(sequence([SPAWN, GET1]).at(-1), null);
  // td-inject.sh and safe-reap.sh arm it too (all are DISPATCH_OK actions).
  assert.equal(sequence(['~/bin/td-inject.sh abc "[DISPATCH] go"', GET1]).at(-1), null);
  assert.equal(sequence(['~/bin/safe-reap.sh b42ce915', GET1]).at(-1), null);
  // The dispatch must have actually RUN: prose naming spawn-lane.sh arms nothing.
  assert.deepEqual(sequence(['echo "next step: spawn-lane.sh --project x"', GET1]).at(-1), REDIRECTED_TERMDECK);
});

test('R12 NEW: the confirmation allowance is one-shot, bounded, GET-only and id-specific', () => {
  // A SECOND check is a poll again.
  assert.deepEqual(sequence([SPAWN, GET1, GET1]).at(-1), REDIRECTED_TERMDECK);
  // A bulk listing is never a confirmation, even right after a dispatch.
  assert.deepEqual(sequence([SPAWN, LIST]).at(-1), REDIRECTED_TERMDECK);
  // A mutating method is an action, not a confirmation.
  assert.deepEqual(sequence([SPAWN, GET1.replace('curl -s', 'curl -s -X DELETE')]).at(-1), REDIRECTED_TERMDECK);
  // Out of the turn window.
  assert.deepEqual(sequence([SPAWN, 'echo a', 'echo b', 'echo c', GET1]).at(-1), REDIRECTED_TERMDECK);
  // An unbounded segment in the same call forfeits it.
  assert.deepEqual(sequence([SPAWN, `${GET1}; tail -f ~/x.log`]).at(-1), REDIRECTED_TERMDECK);
  assert.deepEqual(sequence([SPAWN, `${GET1}; while true; do echo x; done`]).at(-1), REDIRECTED_TERMDECK);
  // Two session reads in one call is repeat polling, not one confirmation.
  assert.deepEqual(sequence([SPAWN, `${GET1}; ${GET1}`]).at(-1), REDIRECTED_TERMDECK);
});

test('R12 NEW: isSingleSessionStatusRead discriminates the shapes directly', () => {
  assert.equal(a.isSingleSessionStatusRead(GET1), true);
  assert.equal(a.isSingleSessionStatusRead(LIST), false);
  assert.equal(a.isSingleSessionStatusRead('curl :3100/api/sessions?limit=5'), false);
  assert.equal(a.isSingleSessionStatusRead('curl -X DELETE :3200/api/sessions/abc'), false);
  assert.equal(a.isSingleSessionStatusRead('curl --request POST :3200/api/sessions/abc'), false);
  assert.equal(a.isSingleSessionStatusRead(`${GET1}; ${LIST}`), false);
  assert.equal(a.isSingleSessionStatusRead(''), false);
  assert.equal(a.isSingleSessionStatusRead('curl :20128/health'), false);
  // Arming requires a real dispatch HEAD, never a mention in text.
  assert.equal(a.commandRunsDispatchAction('~/bin/spawn-lane.sh --project x'), true);
  assert.equal(a.commandRunsDispatchAction('cd /tmp && ~/bin/td-inject.sh abc "go"'), true);
  assert.equal(a.commandRunsDispatchAction('echo "next: spawn-lane.sh --project x"'), false);
  assert.equal(a.commandRunsDispatchAction('grep -c spawn-lane.sh ~/bin/notes.txt'), false);
  assert.equal(a.commandRunsDispatchAction(''), false);
});
