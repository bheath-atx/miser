'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const e=require('../src/enforcement.js');
const a=e.__test;
const CLOCK=Date.parse('2026-09-13T00:00:00Z');
function prompt(s){return {model:'test',system:'ROLE: ORCH',messages:[{role:'user',content:s}]};}
function tool(c){const b=prompt('MISER_ASSIGNMENT=A coordinate this lane');b.messages.push({role:'assistant',content:[{type:'tool_use',id:'iqa10',name:'Bash',input:{command:c}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'iqa10',content:'fixture'}]});return b;}
function answer(q,c){const config=e.parseEnforcement(JSON.stringify({'*':{mode:'observe',override:{overrideFile:path.join(__dirname,'../fixtures/no-overrides.json')}},miser:{mode:'throttle',poll:{maxLikelyPollsPer10Min:99,maxLikelyPollsPerHour:99},orchControl:{enabled:true,panels:['orch']},redirect:{mode:'enforce'}}}));const d={enforcementConfig:config,enforcementState:e.createEnforcementState({nowMs:()=>CLOCK}),nowFn:()=>new Date(CLOCK),recordEnforcementEvent(){}};assert.equal(e.checkEnforcement('miser','orch',prompt(q),{},0,d,{}),null);const r=e.checkEnforcement('miser','orch',tool(c),{},0,d,{});return r===null?null:{reason:r.headers['x-miser-enforcement'],cls:r.headers['x-miser-redirect-class']};}
const q='What is in the miser log?';
test('A1/B1: quoted continuation is inert; a signed-zero timeout still exposes the real tail head',()=>{const inert="curl --data-binary '$\\\n(git push origin main)' u";const b=tool(inert);assert.equal(a.hardSafetyReason(e.classifyRequest('miser','orch',b),b),'');const c="timeout ' -0e999' tail --f ~/.miser/miser.log";assert.equal(e.classifyRequest('miser','orch',tool(c)).commandClass,'POLL_MISER');assert.equal(a.isBoundedReadCommand(c),false);});
test('B2/B4: literal grep short-file bytes and complete log topic survive; sprint compounds do not',()=>{assert.notEqual(e.classifyRequest('miser','orch',tool('grep -nf=miser.log STATUS.md')).commandClass,'POLL_MISER');assert.equal(a.questionMentionsTopic('Please inspect miser-worker-prod_1.jsonl','POLL_MISER'),true);assert.equal(a.questionMentionsTopic('Please inspect miser-classifier and miser-routing','POLL_MISER'),false);});
test('B3-L: later --help makes long follow abbreviation a finite help invocation',()=>{const c='tail --f --help ~/.miser/miser.log';assert.equal(a.isBoundedReadCommand(c),true,c);assert.equal(answer(q,c),null,c);});
test('B3-L: later invalid option stops tail before any following',()=>{for(const c of ['tail --f --bad-option ~/.miser/miser.log','tail --f --lines ~/.miser/miser.log']){assert.equal(a.isBoundedReadCommand(c),true,c);assert.equal(answer(q,c),null,c);}});
test('B3-L: finite help invocation must not redirect a direct operator answer',()=>{const c='tail --f --help ~/.miser/miser.log';assert.equal(answer(q,c),null,c);});
test('B3-O: later --help makes traditional +1f a finite help invocation',()=>{const c='tail +1f --help ~/.miser/miser.log';assert.equal(a.isBoundedReadCommand(c),true,c);assert.equal(answer(q,c),null,c);});
test('B3-L/O controls: valid follow and -- filename boundary',()=>{for(const c of ['tail --f ~/.miser/miser.log','tail +1f ~/.miser/miser.log']){assert.equal(a.isBoundedReadCommand(c),false,c);assert.deepEqual(answer(q,c),{reason:'zero-llm-redirect',cls:'POLL_MISER'},c);}assert.equal(a.isBoundedReadCommand("tail -- '--f' ~/.miser/miser.log"),true);});
