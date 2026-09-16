'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const e = require('../src/enforcement.js');
const a = e.__test;
const CLOCK = Date.parse('2026-09-13T00:00:00Z');
function prompt(s) { return { model: 'test', system: 'ROLE: ORCH', messages: [{ role: 'user', content: s }] }; }
function tool(c) { const b = prompt('MISER_ASSIGNMENT=A coordinate this lane'); b.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'iqa9', name: 'Bash', input: { command: c } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'iqa9', content: 'fixture' }] }); return b; }
function cls(c) { return e.classifyRequest('miser', 'orch', tool(c)).commandClass; }
function safety(c) { const b = tool(c); return a.hardSafetyReason(e.classifyRequest('miser', 'orch', b), b); }
function answer(q,c) {
  const config = e.parseEnforcement(JSON.stringify({'*': {mode:'observe', override:{overrideFile:path.join(__dirname,'../fixtures/no-overrides.json')}}, miser:{mode:'throttle',poll:{maxLikelyPollsPer10Min:99,maxLikelyPollsPerHour:99},orchControl:{enabled:true,panels:['orch']},redirect:{mode:'enforce'}}}));
  const d={enforcementConfig:config,enforcementState:e.createEnforcementState({nowMs:()=>CLOCK}),nowFn:()=>new Date(CLOCK),recordEnforcementEvent(){}};
  assert.equal(e.checkEnforcement('miser','orch',prompt(q),{},0,d,{}),null);
  const r=e.checkEnforcement('miser','orch',tool(c),{},0,d,{});
  return r===null?null:{reason:r.headers['x-miser-enforcement'],cls:r.headers['x-miser-redirect-class']};
}
function follow(c) { const observed={cls:cls(c),bounded:a.isBoundedReadCommand(c),response:answer('What is in the miser log?',c)}; assert.deepEqual(observed,{cls:'POLL_MISER',bounded:false,response:{reason:'zero-llm-redirect',cls:'POLL_MISER'}},c); }
test('A1: literal single-quote bytes stay inert and real following read stays sensitive',()=>{
  assert.equal(safety("curl --data-urlencode '$\\\n(git push origin main)' u"),'');
  assert.equal(safety("curl --data-urlencode '$\\\n(git push origin main)' u; cat ~/.ssh/id_rsa"),'sensitive-file-read');
});
test('B1: accepted zero and rejected nonzero keep wrapper roles',()=>{
  assert.equal(cls("timeout ' -0x1p-1075' tail -F ~/.miser/miser.log"),'POLL_MISER');
  assert.notEqual(cls("timeout ' -0x3p-1076' tail -F ~/.miser/miser.log"),'POLL_MISER');
});
test('B2: grep short literal equals differs from rg and grep long form',()=>{
  assert.notEqual(cls('grep -f=miser.log STATUS.md'),'POLL_MISER');
  assert.equal(cls('rg -f=miser.log STATUS.md'),'POLL_MISER');
  assert.equal(cls('grep --file=miser.log STATUS.md'),'POLL_MISER');
});
test('B3: quoted stage data, per-stage --, and real later follow',()=>{
  assert.equal(a.isBoundedReadCommand("tail -n 5 -- 'part|-F' ~/.miser/miser.log"),true);
  assert.equal(a.isBoundedReadCommand("tail -n 5 -- 'part|-F' ~/.miser/miser.log | tail -F audit/fixture.log"),false);
  assert.equal(a.isBoundedReadCommand('journalctl -F -u miser'),true);
});
test('B4: complete log basenames retain topic; sprint names do not',()=>{
  assert.equal(a.questionMentionsTopic('What does miser-access-log_v2.log.1 show?','POLL_MISER'),true);
  assert.equal(a.questionMentionsTopic('What about miser-classifier and miser-routing?','POLL_MISER'),false);
});
test('B3-L: GNU tail unambiguous long follow abbreviation remains unbounded',()=>{
  follow('tail --follo ~/.miser/miser.log');
  follow('tail --follo=name ~/.miser/miser.log');
});
test('B3-O: GNU tail supported traditional +1f follow remains unbounded',()=>{
  follow('tail +1f ~/.miser/miser.log');
});
