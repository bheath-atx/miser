'use strict';
// R15: CODEX-IQA-R14 B6. Dispatch-script proof must match the complete
// executable basename, never a substring inside a wrapper basename.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const e = require('../src/enforcement.js');
const a = e.__test;
const CLOCK = Date.parse('2026-09-15T00:00:00Z');

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
function deps() {
  return {
    enforcementConfig: config(),
    enforcementState: e.createEnforcementState({ nowMs: () => CLOCK }),
    nowFn: () => new Date(CLOCK),
    recordEnforcementEvent() {},
  };
}
function prompt(s) {
  return { model: 'test', system: 'ROLE: ORCH', messages: [{ role: 'user', content: s }] };
}
function verdict(r) {
  return r === null ? null : {
    reason: r.headers['x-miser-enforcement'],
    cls: r.headers['x-miser-redirect-class'] || '',
  };
}
function repeat(cmd, count) {
  const d = deps();
  const out = [];
  for (let n = 1; n <= count; n++) {
    const body = prompt('MISER_ASSIGNMENT=A coordinate this lane');
    for (let i = 0; i < n; i++) {
      body.messages.push(
        { role: 'assistant', content: [{ type: 'tool_use', id: `s${i}`, name: 'Bash', input: { command: cmd } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: `s${i}`, content: 'ok' }] },
      );
    }
    out.push(verdict(e.checkEnforcement('miser', 'orch', body, {}, 0, d, {})));
  }
  return out;
}
const REDIRECTED_TERMDECK = { reason: 'zero-llm-redirect', cls: 'POLL_TERMDECK' };

test('R15 B6: fake-spawn-lane wrapper cannot launder a TermDeck poll', () => {
  const witness = '/tmp/fake-spawn-lane.sh curl -s :3100/api/sessions/abc123';
  assert.equal(a.stageIsDispatchAction(witness), false);
  assert.equal(a.dispatchOkLaundersPoll(witness), true);
  for (const [i, value] of repeat(witness, 5).entries()) {
    assert.deepEqual(value, REDIRECTED_TERMDECK, `repeat ${i + 1}`);
  }
});

test('R15 B6: boundary-adjacent basenames are not dispatch scripts', () => {
  const controls = [
    '/tmp/spawn-lane.sh.bak curl -s :3100/api/sessions/abc123',
    '/tmp/td-injector curl -s :3100/api/sessions/abc123',
  ];
  for (const command of controls) {
    assert.equal(a.stageIsDispatchAction(command), false, command);
    for (const [i, value] of repeat(command, 3).entries()) {
      assert.deepEqual(value, REDIRECTED_TERMDECK, `${command} repeat ${i + 1}`);
    }
  }
});

test('R15 B6: only exact supported dispatch basenames qualify', () => {
  for (const command of [
    '/home/nacho/bin/spawn-lane.sh --boot x.md',
    '/home/nacho/bin/safe-reap.sh abc123',
    '/home/nacho/bin/td-inject abc123 hello',
    '/home/nacho/bin/td-inject.sh abc123 hello',
  ]) assert.equal(a.stageIsDispatchAction(command), true, command);

  for (const command of [
    '/tmp/fake-spawn-lane.sh --boot x.md',
    '/tmp/spawn-lane.sh.bak --boot x.md',
    '/tmp/fake-safe-reap.sh abc123',
    '/tmp/safe-reap.sh.old abc123',
    '/tmp/my-td-inject.sh abc123 hello',
    '/tmp/td-injector abc123 hello',
  ]) assert.equal(a.stageIsDispatchAction(command), false, command);
});
