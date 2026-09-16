'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const e = require('../src/enforcement.js');
const a = e.__test;
const CLOCK = Date.parse('2026-09-13T00:00:00Z');
function prompt(text) { return { model:'test', system:'ROLE: ORCH', messages:[{ role:'user', content:text }] }; }
function tool(command) {
  const body = prompt('MISER_ASSIGNMENT=A coordinate this lane');
  body.messages.push({ role:'assistant', content:[{ type:'tool_use', id:'r8', name:'Bash', input:{ command } }] },
    { role:'user', content:[{ type:'tool_result', tool_use_id:'r8', content:'fixture only' }] });
  return body;
}
function cls(command) { return e.classifyRequest('miser','orch',tool(command)).commandClass; }
function safety(command) { const body=tool(command); return a.hardSafetyReason(e.classifyRequest('miser','orch',body),body); }
function answer(question,command) {
  const config=e.parseEnforcement(JSON.stringify({ '*':{ mode:'observe', override:{overrideFile:path.join(__dirname,'../fixtures/no-overrides.json')} }, miser:{mode:'throttle',poll:{maxLikelyPollsPer10Min:99,maxLikelyPollsPerHour:99},orchControl:{enabled:true,panels:['orch']},redirect:{mode:'enforce'}} }));
  const deps={ enforcementConfig:config, enforcementState:e.createEnforcementState({nowMs:()=>CLOCK}),nowFn:()=>new Date(CLOCK),recordEnforcementEvent(){} };
  assert.equal(e.checkEnforcement('miser','orch',prompt(question),{},0,deps,{}),null);
  const result=e.checkEnforcement('miser','orch',tool(command),{},0,deps,{});
  return result===null?null:result.headers['x-miser-enforcement'];
}
test('A1: only unquoted and double-quoted lexical continuations join; single-quoted bytes remain inert',()=>{
  assert.equal(a.joinLineContinuations("curl -d '$\\\n(git push origin main)' u"),"curl -d '$\\\n(git push origin main)' u");
  assert.equal(a.joinLineContinuations('curl 3<\\\n&0 -d ok u'),'curl 3<&0 -d ok u');
  assert.equal(a.joinLineContinuations('curl -d "$\\\n(git push origin main)" u'),'curl -d "$(git push origin main)" u');
  for(const flag of ['-d','--data','--data-binary','--data-urlencode']) assert.equal(safety("curl "+flag+" '$\\\n(git push origin main)' u"),'');
  assert.equal(safety("curl -d '$\\\n(git push origin main)' u; cat -- -d ~/.ssh/id_rsa"),'sensitive-file-read');
});
test('B1: timeout negative zero matches installed coreutils including underflow, while negative nonzero is invalid',()=>{
  for(const d of [' -.0',' -00',' -0e-5',' -0x0.0p-2',' -0s',' -1e-9999',' -0x1p-1075',' -0x1p-1076']) assert.equal(cls(`timeout '${d}' tail -f ~/.miser/miser.log`),'POLL_MISER',d);
  for(const d of [' -1',' -0.0001',' -0x3p-1076',' -0x1p0']) assert.notEqual(cls(`timeout '${d}' tail -f ~/.miser/miser.log`),'POLL_MISER',d);
  assert.equal(cls(String.raw`env -S 'tail\_-f' ~/.miser/miser.log`),'POLL_MISER');
});
test('B2: grep and rg retain their distinct short -f equals argument bytes',()=>{
  for(const arg of ['-f=miser.log','-nf=miser.log']) assert.notEqual(cls(`grep ${arg} STATUS.md`),'POLL_MISER',arg);
  assert.equal(cls('rg -f=miser.log STATUS.md'),'POLL_MISER');
  assert.equal(cls('grep --file=miser.log STATUS.md'),'POLL_MISER');
  assert.notEqual(cls("grep -- '-f=miser.log' STATUS.md"),'POLL_MISER');
});
test('B3: stage-local follow flags survive even quote parity; quoted separator filenames stay bounded',()=>{
  for(const slashes of [2,4,6,8]) {
    const cmd="tail -n 50 ~/.miser/miser.log | printf '%s' \""+'\\'.repeat(slashes)+"\" '--' | tail -f file.txt";
    assert.equal(a.isBoundedReadCommand(cmd),false,cmd);
    assert.equal(answer('What is in the miser log?',cmd),'zero-llm-redirect',cmd);
  }
  for(const sep of ['|',';','&','\n']) {
    const bounded=`tail 'name${sep}-f' ~/.miser/miser.log`;
    const followed=`tail 'name${sep}-f' -f ~/.miser/miser.log`;
    assert.equal(a.isBoundedReadCommand(bounded),true,bounded);
    assert.equal(answer('What is in the miser log?',bounded),null,bounded);
    assert.equal(a.isBoundedReadCommand(followed),false,followed);
  }
  assert.equal(a.isBoundedReadCommand('tail -- "-f" ~/.miser/miser.log'),true);
  assert.equal(a.isBoundedReadCommand('env -- tail -f ~/.miser/miser.log'),false);
  const escapedQuote = 'tail "name\\\" -f" ~/.miser/miser.log';
  assert.equal(a.isBoundedReadCommand(escapedQuote),true,escapedQuote);
  assert.equal(answer('What is in the miser log?',escapedQuote),null,escapedQuote);
});
test('B4: full recognized underscore log basename remains topical; sprint compounds remain stripped',()=>{
  for(const file of ['miser-access-log_v2.log','miser-access-log_v2.log.1','miser-worker-prod_1.jsonl']) {
    assert.equal(a.questionMentionsTopic(`What does ${file} show?`,'POLL_MISER'),true,file);
    assert.equal(answer(`What does ${file} show?`,`tail -n 50 ${file}`),null,file);
  }
  for(const text of ['miser-classifier','miser-classifier and miser-routing','miser-classifier, miser-routing and miser-recovery']) assert.equal(a.questionMentionsTopic(`Are you still there in ${text}?`,'POLL_MISER'),false,text);
});
