'use strict';
// R11 B3-L: follow recognition is not the verdict. GNU tail keeps parsing, and a
// later token can make it exit before it ever follows. Every expectation here is
// pinned to the installed tail 9.4 matrix in audit/vendor-tail-r11.json.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const e = require('../src/enforcement.js');
const a = e.__test;
const CLOCK = Date.parse('2026-09-13T00:00:00Z');
function prompt(s) { return { model:'test', system:'ROLE: ORCH', messages:[{role:'user',content:s}] }; }
function tool(c) { const b=prompt('MISER_ASSIGNMENT=A coordinate this lane'); b.messages.push({role:'assistant',content:[{type:'tool_use',id:'r11',name:'Bash',input:{command:c}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'r11',content:'fixture'}]}); return b; }
function answer(q,c) { const config=e.parseEnforcement(JSON.stringify({'*':{mode:'observe',override:{overrideFile:path.join(__dirname,'../fixtures/no-overrides.json')}},miser:{mode:'throttle',poll:{maxLikelyPollsPer10Min:99,maxLikelyPollsPerHour:99},orchControl:{enabled:true,panels:['orch']},redirect:{mode:'enforce'}}})); const d={enforcementConfig:config,enforcementState:e.createEnforcementState({nowMs:()=>CLOCK}),nowFn:()=>new Date(CLOCK),recordEnforcementEvent(){}}; assert.equal(e.checkEnforcement('miser','orch',prompt(q),{},0,d,{}),null); const r=e.checkEnforcement('miser','orch',tool(c),{},0,d,{}); return r===null?null:{reason:r.headers['x-miser-enforcement'],cls:r.headers['x-miser-redirect-class']}; }
const Q = 'What is in the miser log?';
function assertFollow(c) { assert.equal(a.isBoundedReadCommand(c),false,c); assert.deepEqual(answer(Q,c),{reason:'zero-llm-redirect',cls:'POLL_MISER'},c); }
function assertBounded(c) { assert.equal(a.isBoundedReadCommand(c),true,c); assert.equal(answer(Q,c),null,c); }

test('B3-L R11 witness: a later --help/--version after a follow abbreviation is a finite invocation', () => {
  // vendor: `tail --f --help FIXTURE` exits 0 and never reads/follows.
  assertBounded('tail --f --help ~/.miser/miser.log');
  assertBounded('tail --f --version ~/.miser/miser.log');
  assertBounded('tail --follow=name --help ~/.miser/miser.log');
  assertBounded('tail -f --help ~/.miser/miser.log');
  assertBounded('tail -F --help ~/.miser/miser.log');
  assertBounded('tail +1f --help ~/.miser/miser.log');
});

test('B3-L R11: a later unrecognized or ambiguous long option stops tail before following', () => {
  // vendor: exit 1, "unrecognized option" / "option '--s' is ambiguous".
  assertBounded('tail --f --bad-option ~/.miser/miser.log');
  assertBounded('tail --f --s ~/.miser/miser.log');
  assertBounded('tail -f --nope=1 ~/.miser/miser.log');
});

test('B3-L R11: a later rejected or missing option value stops tail before following', () => {
  // vendor: --lines swallows the path -> "invalid number of lines" -> exit 1.
  assertBounded('tail --f --lines ~/.miser/miser.log');
  assertBounded('tail --f --pid=notanumber ~/.miser/miser.log');
  assertBounded('tail --f --sleep-interval=abc ~/.miser/miser.log');
  assertBounded('tail -f -n abc ~/.miser/miser.log');
  assert.equal(a.isBoundedReadCommand('tail --f --lines'), true);   // missing argument
  assert.equal(a.isBoundedReadCommand('tail -f -n'), true);         // missing argument
});

test('B3-L R11 controls: a follow nothing later negates is still unbounded', () => {
  // vendor: every one of these still ran to the outer timeout (exit 124).
  assertFollow('tail --f ~/.miser/miser.log');
  assertFollow('tail --f --lines 2 ~/.miser/miser.log');
  assertFollow('tail --f --lines=2 ~/.miser/miser.log');
  assertFollow('tail --f --sleep-interval=0.4 ~/.miser/miser.log');
  assertFollow('tail --f --retry ~/.miser/miser.log');
  assertFollow('tail --f --verbose ~/.miser/miser.log');
  assertFollow('tail -f -n 2 ~/.miser/miser.log');
  assertFollow('tail +1f ~/.miser/miser.log');
  assert.equal(a.isBoundedReadCommand('tail --f --'), false); // follows stdin
});

test('B3-L R11: negation is per stage and unexpanded values are not treated as a stop', () => {
  // A --help in one stage cannot excuse a real follow in another stage.
  assert.equal(a.isBoundedReadCommand('tail --help ~/.miser/miser.log | tail --f audit/fixture.log'), false);
  assert.equal(a.isBoundedReadCommand('tail --f ~/.miser/miser.log | tail --help audit/fixture.log'), false);
  // A value we cannot resolve must not be used as an excuse to drop the follow.
  assertFollow('tail --f --pid=$PID ~/.miser/miser.log');
  assertFollow('tail -f -n $LINES ~/.miser/miser.log');
  // Quoted lookalikes and end-of-options still cannot manufacture or cancel.
  assertBounded("tail -- '--f' --help ~/.miser/miser.log");
  assert.equal(a.isBoundedReadCommand("tail --f -- '--help' ~/.miser/miser.log"), false);
});
