'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const e=require('../src/enforcement.js');
const a=e.__test;
const CLOCK=Date.parse('2026-09-13T00:00:00Z');
function prompt(s){return {model:'test',system:'ROLE: ORCH',messages:[{role:'user',content:s}]};}
function tool(c){const b=prompt('MISER_ASSIGNMENT=A coordinate this lane');b.messages.push({role:'assistant',content:[{type:'tool_use',id:'new',name:'Bash',input:{command:c}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'new',content:'fixture'}]});return b;}
function cls(c){return e.classifyRequest('miser','orch',tool(c)).commandClass;}
function safety(c){const b=tool(c);return a.hardSafetyReason(e.classifyRequest('miser','orch',b),b);}
function answer(q,c){const config=e.parseEnforcement(JSON.stringify({'*':{mode:'observe',override:{overrideFile:path.join(__dirname,'../fixtures/no-overrides.json')}},miser:{mode:'throttle',poll:{maxLikelyPollsPer10Min:99,maxLikelyPollsPerHour:99},orchControl:{enabled:true,panels:['orch']},redirect:{mode:'enforce'}}}));const d={enforcementConfig:config,enforcementState:e.createEnforcementState({nowMs:()=>CLOCK}),nowFn:()=>new Date(CLOCK),recordEnforcementEvent(){}};assert.equal(e.checkEnforcement('miser','orch',prompt(q),{},0,d,{}),null);const r=e.checkEnforcement('miser','orch',tool(c),{},0,d,{});return r===null?null:{reason:r.headers['x-miser-enforcement'],cls:r.headers['x-miser-redirect-class']};}
test('A1: inert single-quoted continuation; executable double-quoted substitution',()=>{assert.equal(safety("curl --data-binary '$\\\n(git push origin main)' u"),'');assert.equal(safety('curl -d "$\\\n(git push origin main)" u'),'git-write-operation');});
test('A1: escaped redirection stays inert; real sensitive read stays protected',()=>{assert.equal(safety(String.raw`curl x\>& cat -- -d ~/.ssh/id_rsa`),'sensitive-file-read');});
test('B1: signed zero wraps real follow; invalid negative nonzero does not',()=>{assert.equal(cls("timeout ' -0x1p-1075' tail -f ~/.miser/miser.log"),'POLL_MISER');assert.notEqual(cls("timeout ' -0x3p-1076' tail -f ~/.miser/miser.log"),'POLL_MISER');});
test('B2: grep versus rg short equals and long equals keep file roles',()=>{assert.notEqual(cls('grep -f=miser.log STATUS.md'),'POLL_MISER');assert.equal(cls('rg -f=miser.log STATUS.md'),'POLL_MISER');assert.equal(cls('grep --file=miser.log STATUS.md'),'POLL_MISER');});
test('B3: quoted filename flags inert; genuine lower-case follow unbounded',()=>{assert.equal(a.isBoundedReadCommand("tail 'part|-f' ~/.miser/miser.log"),true);assert.equal(a.isBoundedReadCommand('tail -- "-f" ~/.miser/miser.log'),true);assert.equal(a.isBoundedReadCommand('tail -n 20 -f ~/.miser/miser.log'),false);});
test('B4: recognized log topic survives while sprint compounds do not',()=>{assert.equal(a.questionMentionsTopic('What does miser-worker-prod_1.jsonl say?','POLL_MISER'),true);assert.equal(a.questionMentionsTopic('Any news on miser-classifier and miser-routing?','POLL_MISER'),false);});
test('B3 NEW: tail -F is unbounded and must not earn bounded-read exemption',()=>{const c='tail -n 50 -F ~/.miser/miser.log';const observed={cls:cls(c),bounded:a.isBoundedReadCommand(c),response:answer('What is in the miser log?',c)};assert.deepEqual(observed,{cls:'POLL_MISER',bounded:false,response:{reason:'zero-llm-redirect',cls:'POLL_MISER'}});});
