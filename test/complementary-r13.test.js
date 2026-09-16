'use strict';
// R13: the six CODEX-IQA-R12 BLOCKERs, each pinned by an executable witness.
//   1  cross-class exemption laundering        (IQA-R12 enforcement.js:1314,1636)
//   2  nested command substitution             (IQA-R12 enforcement.js:2664,2674)
//  3a  unreachable dispatch arms allowance     (IQA-R12 enforcement.js:883)
//  3b  GET-only validator accepts mutations    (IQA-R12 enforcement.js:1685)
//  3c  cardinality counted per segment         (IQA-R12 enforcement.js:1643,1688)
//  3d  text-only mention as general bypass     (IQA-R12 enforcement.js:864,1310)
// Every assertion below FAILS on the unmodified R12 candidate except where a
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
function tool(c) {
  const b = prompt('MISER_ASSIGNMENT=A coordinate this lane');
  b.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'r13', name: 'Bash', input: { command: c } }] },
                  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r13', content: 'fixture' }] });
  return b;
}
function verdict(r) { return r === null ? null : { reason: r.headers['x-miser-enforcement'], cls: r.headers['x-miser-redirect-class'] || '' }; }
function answer(q, c) {
  const d = deps();
  assert.equal(e.checkEnforcement('miser', 'orch', prompt(q), {}, 0, d, {}), null);
  return verdict(e.checkEnforcement('miser', 'orch', tool(c), {}, 0, d, {}));
}
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
function reasonOf(c) { return a.hardSafetyReason({ commandClass: 'NEUTRAL', terminalShape: 'tool_result' }, tool(c)); }
const REDIRECTED_CI = { reason: 'zero-llm-redirect', cls: 'POLL_CI' };
const REDIRECTED_TERMDECK = { reason: 'zero-llm-redirect', cls: 'POLL_TERMDECK' };
const CI_Q = 'what is the CI status of the run?';
const MISER_Q = 'What is in the miser log?';

// ------------------------------------------------------- BLOCKER 1
test('R13 B1: a CI authorization cannot launder an unrelated Miser read', () => {
  // The exact IQA-R12 witness.
  const laundered = 'gh run view 1; tail -30 ~/.miser/miser.log';
  assert.equal(a.isBoundedReadCommand(laundered), true, 'still a bounded read');
  assert.deepEqual(answer(CI_Q, laundered), REDIRECTED_CI,
    'the Miser segment must not ride along on the CI question');
  // Both protected classes are seen, not just the classified one.
  assert.deepEqual([...a.protectedClassesInCommand(laundered)].sort(), ['POLL_CI', 'POLL_MISER']);
});

test('R13 B1: the reverse direction laundering is closed too', () => {
  assert.notEqual(answer(MISER_Q, 'tail -30 ~/.miser/miser.log; gh run view 1'), null,
    'a Miser question must not excuse a CI poll riding along');
});

test('R13 B1 control: each class alone still earns its own exemption', () => {
  assert.equal(answer(CI_Q, 'gh run view 1'), null);
  assert.equal(answer(MISER_Q, 'tail -30 ~/.miser/miser.log'), null);
});

test('R13 B1 control: R12 Hit 2 batched bounded read is still exempt', () => {
  // Must not regress: unrelated NON-protected work batched with one bounded read.
  const batched = 'grep -rl "spawn" ~/bin/x.sh; find . -name "BOOT-*.md"; ls -la *.log | tail -5; tail -30 ~/.miser/miser.log';
  assert.equal(answer(MISER_Q, batched), null);
});

test('R13 B1: asking about BOTH topics exempts both, and burns both one-shots', () => {
  const both = 'gh run view 1; tail -30 ~/.miser/miser.log';
  const d = deps();
  assert.equal(e.checkEnforcement('miser', 'orch', prompt('what is the CI status and what is in the miser log?'), {}, 0, d, {}), null);
  const b = prompt('MISER_ASSIGNMENT=A coordinate this lane');
  b.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'x0', name: 'Bash', input: { command: both } }] },
                  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x0', content: 'ok' }] });
  assert.equal(verdict(e.checkEnforcement('miser', 'orch', b, {}, 0, d, {})), null, 'both asked -> both exempt');
  // Re-spending either class on the next turn is refused.
  b.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'tail -30 ~/.miser/miser.log' } }] },
                  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x1', content: 'ok' }] });
  assert.notEqual(verdict(e.checkEnforcement('miser', 'orch', b, {}, 0, d, {})), null,
    'POLL_MISER one-shot was consumed by the combined call');
});

// ------------------------------------------------------- BLOCKER 2
test('R13 B2: command substitution reading a private key is never "path-only"', () => {
  // The exact IQA-R12 witness: outer shape is `grep -l`, inner reads the key.
  const witness = 'printf x | grep -l --label="$(cat ~/.ssh/id_rsa)" x';
  assert.equal(a.sensitiveReadIsProvablyPathOnly(witness), false);
  assert.equal(reasonOf(witness), 'sensitive-file-read');
});

test('R13 B2: a substitution in ANY segment, not just the matched stage, disproves it', () => {
  const witness = 'X=$(cat ~/.ssh/id_rsa); grep -l "$X" ~/.termdeck';
  assert.equal(a.sensitiveReadIsProvablyPathOnly(witness), false);
  assert.equal(reasonOf(witness), 'sensitive-file-read');
  assert.equal(a.commandHasUnresolvableSubstitution(witness), true);
  assert.equal(a.commandHasUnresolvableSubstitution('grep -rl spawn ~/.termdeck'), false);
});

test('R13 B2: backtick substitution and parse overflow both fail closed', () => {
  assert.equal(a.sensitiveReadIsProvablyPathOnly('grep -l `cat ~/.ssh/id_rsa` ~/.termdeck'), false);
  const overflow = `grep -l "$(${'cat '.repeat(9000)}x)" ~/.termdeck`;
  assert.equal(a.commandHasUnresolvableSubstitution(overflow), true, 'too long to parse -> unproven');
  assert.equal(a.sensitiveReadIsProvablyPathOnly(overflow), false);
});

test('R13 B2: --label replaces the emitted path, so -l is no longer path-only', () => {
  assert.equal(a.sensitiveReadIsProvablyPathOnly('grep -l --label=whatever foo ~/.termdeck'), false);
  assert.equal(reasonOf('grep -l --label=whatever foo ~/.termdeck'), 'sensitive-file-read');
});

test('R13 B2 NIT: the exact spaced `grep -e l ~/.termdeck/...` form trips', () => {
  // IQA-R12 asked for this verbatim; round 12 only pinned the glued `-el`.
  assert.equal(reasonOf('grep -e l ~/.termdeck/config.yaml'), 'sensitive-file-read');
  assert.equal(a.sensitiveReadIsProvablyPathOnly('grep -e l ~/.termdeck/config.yaml'), false);
  assert.equal(reasonOf('grep -el ~/.termdeck/config.yaml'), 'sensitive-file-read');
});

test('R13 B2 controls: genuine path-only reads stay suppressed', () => {
  for (const c of ['ls -la ~/.termdeck', 'find ~/.termdeck -iname "*.yaml"', 'grep -rl spawn ~/.termdeck']) {
    assert.equal(reasonOf(c), '', c);
  }
  for (const c of ['tail -30 ~/.termdeck/config.yaml', 'cat ~/.ssh/id_rsa', 'bash -c "cat ~/.ssh/id_rsa"',
                   'find ~/.termdeck -exec cat {} ;']) {
    assert.equal(reasonOf(c), 'sensitive-file-read', c);
  }
});

// ------------------------------------------------------- BLOCKER 3a
test('R13 B3a: a dispatch that provably never runs arms nothing', () => {
  for (const dispatch of ['false && ~/bin/spawn-lane.sh --boot x.md', 'true || ~/bin/spawn-lane.sh --boot x.md']) {
    assert.equal(a.commandRunsDispatchAction(dispatch), false, dispatch);
    assert.deepEqual(sequence([dispatch, 'curl -s :3100/api/sessions/abc123'])[1], REDIRECTED_TERMDECK, dispatch);
  }
});

test('R13 B3a: reachability follows real AND-OR list semantics', () => {
  const runs = c => a.commandRunsDispatchAction(c);
  assert.equal(runs('~/bin/spawn-lane.sh x'), true);
  assert.equal(runs('mkdir -p q && ~/bin/spawn-lane.sh x'), true, 'unknown predecessor must still arm');
  assert.equal(runs('anything || ~/bin/spawn-lane.sh x'), true, 'may run -> arms');
  assert.equal(runs('false && echo a || ~/bin/spawn-lane.sh x'), true, 'skipped && branch leaves list false');
  assert.equal(runs('true || echo a && ~/bin/spawn-lane.sh x'), true, 'skipped || branch leaves list true');
  assert.equal(runs('false && ~/bin/spawn-lane.sh x; echo done'), false);
  assert.equal(runs('echo hi; ~/bin/spawn-lane.sh x'), true, 'a new list after ; is unconditional');
  assert.equal(runs('echo "~/bin/spawn-lane.sh x"'), false, 'quoted mention is an argument, not a head');
});

test('R13 B3a: the operator-retaining splitter records the joining operator', () => {
  assert.deepEqual(a.commandTopLevelSegmentsWithOps('a && b || c ; d').map(p => p.op), [null, '&&', '||', ';']);
  assert.deepEqual(a.reachableTopLevelSegments('false && a || b').map(p => p.runs), [true, false, true]);
});

// ------------------------------------------------------- BLOCKER 3b
test('R13 B3b: every curl method-changing form is refused the read exemption', () => {
  const mutating = [
    'curl -XDELETE :3100/api/sessions/abc123', 'curl -XPOST :3100/api/sessions/abc123',
    'curl -X POST :3100/api/sessions/abc123', 'curl --request=DELETE :3100/api/sessions/abc123',
    'curl --request PUT :3100/api/sessions/abc123', 'curl -d name=x :3100/api/sessions/abc123',
    'curl --data name=x :3100/api/sessions/abc123', 'curl --data-binary @f :3100/api/sessions/abc123',
    'curl -F f=@x :3100/api/sessions/abc123', 'curl --form f=x :3100/api/sessions/abc123',
    'curl -T x.txt :3100/api/sessions/abc123', 'curl --upload-file x :3100/api/sessions/abc123',
    'curl --head :3100/api/sessions/abc123', 'curl -I :3100/api/sessions/abc123',
    'curl -sXDELETE :3100/api/sessions/abc123',
  ];
  for (const c of mutating) assert.equal(a.isSingleSessionStatusRead(c), false, c);
  // ...and none of them can collect the post-dispatch allowance either.
  assert.deepEqual(sequence(['~/bin/spawn-lane.sh --boot x.md', 'curl -XDELETE :3100/api/sessions/abc123'])[1],
    REDIRECTED_TERMDECK);
});

test('R13 B3b controls: real GET confirmation reads still pass', () => {
  for (const c of ['curl -s :3100/api/sessions/abc123',
                   'curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:3100/api/sessions/abc123',
                   'curl -sG -d a=1 :3100/api/sessions/abc123']) {
    assert.equal(a.isSingleSessionStatusRead(c), true, c);
    assert.equal(a.curlStageIsPlainGet(c), true, c);
  }
});

// ------------------------------------------------------- BLOCKER 3c
test('R13 B3c: three URLs in ONE curl invocation are three requests, not one', () => {
  const three = 'curl -s :3100/api/sessions/aaa :3100/api/sessions/bbb :3100/api/sessions/ccc';
  assert.equal(a.isSingleSessionStatusRead(three), false);
  assert.deepEqual(sequence(['~/bin/spawn-lane.sh --boot x.md', three])[1], REDIRECTED_TERMDECK);
});

test('R13 B3c: curl brace/bracket globbing expands to several requests, so it is refused', () => {
  for (const c of ['curl -s :3100/api/sessions/aa{1,2}', 'curl -s :3100/api/sessions/node[1-3]']) {
    assert.equal(a.isSingleSessionStatusRead(c), false, c);
  }
});

test('R13 B3c: two session reads split across segments are still two requests', () => {
  assert.equal(a.isSingleSessionStatusRead('curl -s :3100/api/sessions/a; curl -s :3100/api/sessions/b'), false);
  assert.equal(a.isSingleSessionStatusRead('curl -s :3100/api/sessions/abc123'), true, 'control');
  assert.equal(a.isSingleSessionStatusRead('curl -s :3100/api/sessions'), false, 'bulk list control');
});

// ------------------------------------------------------- BLOCKER 3d
test('R13 B3d: echoing a script name does not buy a poll, repeated or not', () => {
  // IQA-R12 asked specifically for the REPEATED form to trip as a real poll.
  const echoCurl = 'echo "spawn-lane.sh"; curl -s :3100/api/sessions/abc123';
  const verdicts = sequence([echoCurl, echoCurl, echoCurl, echoCurl]);
  for (const [i, v] of verdicts.entries()) {
    assert.deepEqual(v, REDIRECTED_TERMDECK, `turn ${i + 1} must be classified as polling`);
  }
  assert.equal(a.dispatchOkLaundersPoll(echoCurl), true);
});

test('R13 B3d: a poll inside the dispatch command itself stays DISPATCH_OK', () => {
  // td-inject's MESSAGE BODY may legitimately mention replyCount; that must not
  // demote a genuine dispatch into a poll.
  const inject = '~/bin/td-inject.sh abc123 "check replyCount when you can"';
  assert.equal(a.dispatchOkLaundersPoll(inject), false);
  assert.equal(sequence([inject])[0], null);
});

test('R13 B3d: a real dispatch still buys exactly ONE bounded confirmation read', () => {
  const v = sequence(['~/bin/spawn-lane.sh --boot x.md', 'curl -s :3100/api/sessions/abc123', 'curl -s :3100/api/sessions/abc123']);
  assert.equal(v[1], null, 'first confirmation read is allowed');
  assert.deepEqual(v[2], REDIRECTED_TERMDECK, 'the second is a poll');
});

test('R13 B3d: dispatch and its one confirmation read may share a single call', () => {
  assert.equal(sequence(['~/bin/spawn-lane.sh --boot x.md; curl -s :3100/api/sessions/abc123'])[0], null);
  // ...but not three reads, and not a mutation, in that same call.
  assert.deepEqual(sequence(['~/bin/spawn-lane.sh --boot x.md; curl -s :3100/api/sessions/a :3100/api/sessions/b'])[0],
    REDIRECTED_TERMDECK);
  assert.deepEqual(sequence(['~/bin/spawn-lane.sh --boot x.md; curl -XDELETE :3100/api/sessions/a'])[0],
    REDIRECTED_TERMDECK);
});

test('R13 B3d: the confirmation allowance covers POLL_TERMDECK only', () => {
  // A Miser read riding along with the confirmation gets no dispatch credit.
  assert.notEqual(sequence(['~/bin/spawn-lane.sh --boot x.md',
    'curl -s :3100/api/sessions/abc123; tail -30 ~/.miser/miser.log'])[1], null);
});
