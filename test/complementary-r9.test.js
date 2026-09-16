'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const e=require('../src/enforcement.js');
const a=e.__test;
const CLOCK=Date.parse('2026-09-13T00:00:00Z');
function prompt(s){return {model:'test',system:'ROLE: ORCH',messages:[{role:'user',content:s}]};}
function tool(c){const b=prompt('MISER_ASSIGNMENT=A coordinate this lane');b.messages.push({role:'assistant',content:[{type:'tool_use',id:'r9',name:'Bash',input:{command:c}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'r9',content:'fixture'}]});return b;}
function answer(q,c){const config=e.parseEnforcement(JSON.stringify({'*':{mode:'observe',override:{overrideFile:path.join(__dirname,'../fixtures/no-overrides.json')}},miser:{mode:'throttle',poll:{maxLikelyPollsPer10Min:99,maxLikelyPollsPerHour:99},orchControl:{enabled:true,panels:['orch']},redirect:{mode:'enforce'}}}));const d={enforcementConfig:config,enforcementState:e.createEnforcementState({nowMs:()=>CLOCK}),nowFn:()=>new Date(CLOCK),recordEnforcementEvent(){}};assert.equal(e.checkEnforcement('miser','orch',prompt(q),{},0,d,{}),null);const r=e.checkEnforcement('miser','orch',tool(c),{},0,d,{});return r===null?null:{reason:r.headers['x-miser-enforcement'],cls:r.headers['x-miser-redirect-class']};}
function assertFollow(command){assert.equal(a.isBoundedReadCommand(command),false,command);assert.deepEqual(answer('What is in the miser log?',command),{reason:'zero-llm-redirect',cls:'POLL_MISER'},command);}
function assertBounded(command){assert.equal(a.isBoundedReadCommand(command),true,command);assert.equal(answer('What is in the miser log?',command),null,command);}
test('B3-F: GNU tail -F and valid short clusters are active follow, including a quoted data filename',()=>{
 for(const args of ['-F','-qF','-Fq','-Fn50','-n 50 -F']) assertFollow(`tail ${args} ~/.miser/miser.log`);
 assertFollow("tail -n 50 -F 'part|-f' ~/.miser/miser.log");
});
test('B3-F: GNU long equivalent and inherited lowercase follow remain unbounded',()=>{
 for(const args of ['--follow=name --retry','--follow=descriptor','-f','-fn50']) assertFollow(`tail -n 50 ${args} ~/.miser/miser.log`);
});
test('B3-F: end-of-options and quoted filename data do not become follow flags',()=>{
 for(const args of ["-- '-F'","-- '-qF'","-- 'nameF.log'","'nameF.log'","'part|F.log'"]) assertBounded(`tail -n 50 ${args} ~/.miser/miser.log`);
 assertBounded('tail -n 50 ~/.miser/miser.log');
 // -n consumes the rest; 50F is an invalid number, not a follow option.
 assertBounded('tail -n50F ~/.miser/miser.log');
 assertBounded('tail -n -F ~/.miser/miser.log');
});
test('B3-F: uppercase F is tail-specific; journalctl field listing remains bounded',()=>{
 assert.equal(a.isBoundedReadCommand('journalctl -F -u miser'),true);
 assert.equal(a.isBoundedReadCommand('journalctl -f -u miser'),false);
});
