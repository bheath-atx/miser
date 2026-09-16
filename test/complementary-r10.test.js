'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const e = require('../src/enforcement.js');
const a = e.__test;
const CLOCK = Date.parse('2026-09-13T00:00:00Z');
function prompt(s) { return { model:'test', system:'ROLE: ORCH', messages:[{role:'user',content:s}] }; }
function tool(c) { const b=prompt('MISER_ASSIGNMENT=A coordinate this lane'); b.messages.push({role:'assistant',content:[{type:'tool_use',id:'r10',name:'Bash',input:{command:c}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'r10',content:'fixture'}]}); return b; }
function answer(q,c) { const config=e.parseEnforcement(JSON.stringify({'*':{mode:'observe',override:{overrideFile:path.join(__dirname,'../fixtures/no-overrides.json')}},miser:{mode:'throttle',poll:{maxLikelyPollsPer10Min:99,maxLikelyPollsPerHour:99},orchControl:{enabled:true,panels:['orch']},redirect:{mode:'enforce'}}})); const d={enforcementConfig:config,enforcementState:e.createEnforcementState({nowMs:()=>CLOCK}),nowFn:()=>new Date(CLOCK),recordEnforcementEvent(){}}; assert.equal(e.checkEnforcement('miser','orch',prompt(q),{},0,d,{}),null); const r=e.checkEnforcement('miser','orch',tool(c),{},0,d,{}); return r===null?null:{reason:r.headers['x-miser-enforcement'],cls:r.headers['x-miser-redirect-class']}; }
function assertFollow(c) { assert.equal(a.isBoundedReadCommand(c),false,c); assert.deepEqual(answer('What is in the miser log?',c),{reason:'zero-llm-redirect',cls:'POLL_MISER'},c); }
function assertBounded(c) { assert.equal(a.isBoundedReadCommand(c),true,c); assert.equal(answer('What is in the miser log?',c),null,c); }
test('B3-L: every installed unique --follow prefix and valid value prefix remains unbounded',()=>{
 for(const opt of ['--f','--fo','--fol','--foll','--follo','--follow','--f=n','--f=nam','--follo=name','--f=d','--f=desc','--follo=descriptor']) assertFollow(`tail ${opt} ~/.miser/miser.log`);
 assertFollow('env -- tail --follo ~/.miser/miser.log');
 assertFollow("printf '%s' '--' | tail --follo ~/.miser/miser.log");
});
test('B3-L: invalid and ambiguous spellings, unrelated unique options and consumed values remain bounded',()=>{
 for(const opt of ['--follow=','--f=bogus','--f=ne','--follox','--s','--F','--q','--retry']) assertBounded(`tail ${opt} ~/.miser/miser.log`);
 for(const opt of ['--lines','--bytes','--sleep-interval','--pid','--max-unchanged-stats','--li','--pi']) assertBounded(`tail ${opt} --f ~/.miser/miser.log`);
 assertBounded("tail -- '--follo' ~/.miser/miser.log");
 assertBounded("tail -- '--f' ~/.miser/miser.log");
 assert.equal(a.isBoundedReadCommand('journalctl --follo -u miser'),true);
 assert.equal(a.isBoundedReadCommand('journalctl --follow -u miser'),false);
});
test('B3-O: supported traditional plus follow syntax, with optional digits and b/c/l, remains unbounded',()=>{
 for(const opt of ['+f','+bf','+cf','+lf','+0f','+1f','+2f','+10f','+1bf','+1cf','+1lf']) assertFollow(`tail ${opt} ~/.miser/miser.log`);
 assertFollow("tail '+1f' ~/.miser/miser.log");
 assertFollow('timeout 0 tail +1f ~/.miser/miser.log');
 assertFollow("printf '%s' '--' | tail +1f ~/.miser/miser.log");
});
test('B3-O: traditional lookalike filenames and invalid multi-operand shapes remain bounded',()=>{
 for(const opt of ['+1','+1l','+1F','+1fc','+1Ff']) assertBounded(`tail ${opt} ~/.miser/miser.log`);
 assertBounded("tail -- '+1f' ~/.miser/miser.log");
 assertBounded('tail ./+1f ~/.miser/miser.log');
 assertBounded('tail +1f ~/.miser/miser.log second.log');
 assertBounded('tail -n 2 +1f ~/.miser/miser.log');
 assertBounded('tail ~/.miser/miser.log +1f');
 assert.equal(a.isBoundedReadCommand('journalctl +1f -u miser'),true);
});
test('B3-L/O: inherited -F, lowercase follow, and per-stage end-of-options controls persist',()=>{
 for(const opt of ['-F','-qF','-Fq','-f','--follow=name']) assertFollow(`tail ${opt} ~/.miser/miser.log`);
 assertBounded("tail -n 50 -- '-F' ~/.miser/miser.log");
 assertBounded("tail -n 50 -- '+1f' ~/.miser/miser.log");
 assertBounded("tail 'part|+1f' ~/.miser/miser.log");
});
