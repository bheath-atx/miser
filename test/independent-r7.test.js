'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const e = require('../src/enforcement.js');
const a = e.__test;
const evidence = [];
const CLOCK = Date.parse('2026-09-13T00:00:00Z');
function prompt(text) {
  return { model: 'test', system: 'ROLE: ORCH', messages: [{ role: 'user', content: text }] };
}
function tool(command) {
  const body = prompt('MISER_ASSIGNMENT=A coordinate this lane');
  body.messages.push(
    { role: 'assistant', content: [{ type: 'tool_use', id: 'iqa', name: 'Bash', input: { command } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'iqa', content: 'fixture output only' }] },
  );
  return body;
}
function deps() {
  const enforcementConfig = e.parseEnforcement(JSON.stringify({
    '*': { mode: 'observe', override: { overrideFile: path.join(__dirname, '../fixtures/no-overrides.json') } },
    miser: { mode: 'throttle', poll: { maxLikelyPollsPer10Min: 99, maxLikelyPollsPerHour: 99 },
      orchControl: { enabled: true, panels: ['orch'] }, redirect: { mode: 'enforce' } },
  }));
  return { enforcementConfig, enforcementState: e.createEnforcementState({ nowMs: () => CLOCK }), nowFn: () => new Date(CLOCK), recordEnforcementEvent() {} };
}
function check(body, d) { return e.checkEnforcement('miser', 'orch', body, {}, 0, d, {}); }
function response(result) { return result === null ? null : { reason: result.headers['x-miser-enforcement'], cls: result.headers['x-miser-redirect-class'] }; }
function classify(command) {
  const body = tool(command);
  const c = e.classifyRequest('miser', 'orch', body);
  return { cls: c.commandClass, safety: a.hardSafetyReason(c, body) };
}
function answering(command, question = 'What is in the miser log right now?') {
  const d = deps();
  const q = check(prompt(question), d);
  return { question: response(q), bounded: a.isBoundedReadCommand(command), cls: classify(command).cls, response: response(check(tool(command), d)) };
}
function scenario(id, name, input, expected, fn) {
  test(`${id}: ${name}`, () => {
    const actual = fn();
    evidence.push({ id, name, input, expected, actual });
    assert.deepEqual(actual, expected, JSON.stringify(input));
  });
}
after(() => {
  const evidencePath = path.join(__dirname, '../audit/independent-evidence.json');
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
});
function safety(name, command, reason) { scenario('A1', name, command, reason, () => classify(command).safety); }
function poll(id, name, command, wanted = true) { scenario(id, name, command, wanted, () => classify(command).cls === 'POLL_MISER'); }
function answer(id, name, command, bounded, question) {
  scenario(id, name, { command, question }, { question: null, bounded, cls: 'POLL_MISER', response: bounded ? null : { reason: 'zero-llm-redirect', cls: 'POLL_MISER' } }, () => answering(command, question));
}

// A1: replay the exact prior regression and redirection family before challenging v7's join.
for (const redir of ['3<\\\n&0', '<\\\n&-', '2>\\\n&1', '&\\\n>sink', '3<\\\n\\\n&0']) {
  safety('continued redirection ' + JSON.stringify(redir), `curl ${redir} -d '{"text":"git push origin main"}' u`, '');
}
for (const redir of ['<&-', '3<&-', '<&2', '2>&1', '&>sink', '&>>sink']) {
  safety('R5/R6 redirection ' + redir, `curl ${redir} -d '{"text":"git push origin main"}' u`, '');
}
for (const count of [1, 3, 5]) {
  safety('R5 escaped > real cat boundary, slashes=' + count, 'curl x' + '\\'.repeat(count) + '>& cat -- -d ~/.ssh/id_rsa', 'sensitive-file-read');
}
for (const separator of [';', '&', '\n', '&&', '||', '|']) {
  safety('actual subsequent command ' + JSON.stringify(separator), `curl -d ok u ${separator} cat -- -d ~/.ssh/id_rsa`, 'sensitive-file-read');
}
for (const flag of ['-d', '--data-binary', '--data-urlencode']) {
  safety('NEW single-quoted literal dollar/continuation with ' + flag, "curl " + flag + " '$\\\n(git push origin main)' u", '');
}
safety('NEW wget single-quoted literal dollar/continuation', "wget --post-data '$\\\n(git push origin main)' u", '');
safety('double-quoted actual live substitution survives join', 'curl -d "$\\\n(git push origin main)" u', 'git-write-operation');
safety('escaped-backslash leaves actual newline boundary', 'curl -d ok u\\\\\ncat -- -d ~/.ssh/id_rsa', 'sensitive-file-read');
safety('original inert prose request payload', `curl -d '{"text":"a real git push --force origin main must still get blocked"}' u`, '');

// B1: installed env grammar witnesses form the oracle for the published escape table.
const envCases = [
  [String.raw`argvdump a\_b`, ['argvdump', 'a', 'b']],
  [String.raw`argvdump a\_\_b`, ['argvdump', 'a', 'b']],
  [String.raw`argvdump "a\_b"`, ['argvdump', 'a b']],
  [String.raw`argvdump 'a\_b'`, ['argvdump', String.raw`a\_b`]],
  [String.raw`argvdump "" a`, ['argvdump', '', 'a']],
  [String.raw`"argvdump" a`, ['argvdump', 'a']],
];
for (const [escape, literal] of Object.entries({ f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '#': '#', '$': '$', '"': '"', "'": "'", '\\': '\\' })) {
  for (const quoting of ['', '"']) envCases.push(['argvdump ' + quoting + 'a\\' + escape + 'b' + quoting, ['argvdump', 'a' + literal + 'b']]);
}
for (const [value, tokens] of envCases) scenario('B1', 'env escape grammar ' + JSON.stringify(value), value, tokens, () => a.splitEnvDashSValue(value));
for (const command of [String.raw`env -S 'tail\_-f' ~/.miser/miser.log`, String.raw`env -S'tail\_\_-f' ~/.miser/miser.log`, String.raw`env --split-string='tail\_-f' ~/.miser/miser.log`, `env -u FOO timeout .5 tail -f ~/.miser/miser.log`]) poll('B1', 'wrapped real read ' + command, command);
poll('B1', 'invalid backslash-space is not a valid poll', String.raw`env -S 'tail\ -f' ~/.miser/miser.log`, false);
for (const duration of [' 5', '\t5', '\n5', '\r5', '\v5', '\f5', ' +5', '+inf', '0x.8p0', '5.', '1e2']) {
  poll('B1', 'valid duration ' + JSON.stringify(duration), `timeout '${duration}' tail -f ~/.miser/miser.log`);
}
for (const duration of [' -0', '\t-0', ' -0.0', ' -0e5', ' -0x0p0']) {
  poll('B1', 'NEW valid negative zero duration ' + JSON.stringify(duration), `timeout '${duration}' tail -f ~/.miser/miser.log`);
}
for (const duration of ['5 ', ' 5 ', ' -1']) poll('B1', 'invalid duration ' + JSON.stringify(duration), `timeout '${duration}' tail -f ~/.miser/miser.log`, false);

// B2: -- belongs to the command, while -f's value remains a real read.
for (const cmd of ['grep', 'rg']) {
  for (const pattern of ['-f/.miser/', '-fmiser.log', '--file=miser.log', '--regexp=/.miser/']) {
    poll('B2', cmd + ' literal pattern after -- ' + pattern, `${cmd} -- '${pattern}' STATUS.md`, false);
  }
  for (const args of ['-f ~/.miser/miser.log STATUS.md', '-nf ~/.miser/miser.log STATUS.md', '-nfrex ~/.miser/miser.log STATUS.md', '-e first -f ~/.miser/miser.log STATUS.md', '--file=rex ~/.miser/miser.log STATUS.md', '--file rex ~/.miser/miser.log STATUS.md', '-e first -- ~/.miser/miser.log']) poll('B2', cmd + ' genuine file ' + args, `${cmd} ${args}`);
  poll('B2', cmd + ' pattern-value -- is not end of flags', `${cmd} -e -- -f ~/.miser/miser.log STATUS.md`);
  poll('B2', cmd + ' quoted second pattern stays inert', `${cmd} -e first -ne /.miser/ STATUS.md`, false);
}
poll('B2', 'NEW GNU grep short -f literal leading equals', 'grep -f=miser.log STATUS.md', false);
poll('B2', 'GNU grep bundled -nf preserves same leading equals', 'grep -nf=miser.log STATUS.md', false);
poll('B2', 'ripgrep supports optional = after short -f', 'rg -f=miser.log STATUS.md');
poll('B2', 'original sprint STATUS path collision', 'grep -n "^## " /home/nacho/sprints/20260912-miser-classifier-content-match-investigation/STATUS.md | tail -30', false);

// B3: check boundedness and the actual redirect headers, not a generic non-null budget warning.
for (const separator of ['|', ';', '&', '\n']) {
  answer('B3', 'quoted separator before actual follow ' + JSON.stringify(separator), `tail 'a${separator}b' -f ~/.miser/miser.log`, false);
  answer('B3', 'NEW separator manufactures a flag in filename ' + JSON.stringify(separator), `tail 'name${separator}-f' ~/.miser/miser.log`, true);
}
for (const slashCount of [1, 2, 3]) {
  answer('B3', 'R6 single-quote stage closure slash-count=' + slashCount, "tail -n 50 ~/.miser/miser.log | printf '%s' '" + '\\'.repeat(slashCount) + "' '--' | tail -f file.txt", false);
}
for (const slashCount of [2, 4, 6]) {
  answer('B3', 'NEW double-quote stage closure slash-count=' + slashCount, "tail -n 50 ~/.miser/miser.log | printf '%s' \"" + '\\'.repeat(slashCount) + "\" '--' | tail -f file.txt", false);
}
for (const command of [
  `env -- tail -f ~/.miser/miser.log`, `printf '%s' '--' | tail -f ~/.miser/miser.log`,
  `env -S 'tail "-f"' ~/.miser/miser.log`, `tail -n 50 ~/.miser/miser.log | tail -f file.txt`,
]) answer('B3', 'prior real follow regression ' + command, command, false);
for (const command of [`tail -n 50 -- "-f" ~/.miser/miser.log`, `tail -- "--follow" ~/.miser/miser.log`]) answer('B3', 'R5 own -- still bounded ' + command, command, true);

// B4: recognized log basenames must retain their topic, and sprint mentions must not replenish.
for (const prefix of ['miser-worker', 'miser-access-log']) {
  for (const ext of ['.log', '.log.1', '.log.gz', '.jsonl', '.json', '.txt']) {
    const file = prefix + ext;
    answer('B4', 'existing log shape ' + file, `tail -n 50 ${file}`, true, `What does ${file} show?`);
  }
}
answer('B4', 'extensionless -log', 'tail -n 50 ~/.miser/miser-access-log', true, 'What does miser-access-log show?');
for (const file of ['miser-access-log_v2.log', 'miser-access-log_v2.log.1', 'miser-worker-prod_1.log', 'miser-worker-prod_1.jsonl']) {
  answer('B4', 'NEW underscore in recognized multi-hyphen basename ' + file, `tail -n 50 ${file}`, true, `What does ${file} show?`);
}
for (const mention of ['miser-classifier', 'miser-classifier and miser-routing', 'miser-classifier, miser-routing and miser-recovery']) {
  scenario('B4', 'sprint mentions never replenish: ' + mention, mention, { question: null, read: { reason: 'zero-llm-redirect', cls: 'POLL_MISER' } }, () => {
    const d = deps();
    assert.equal(check(prompt('What is in the miser log right now?'), d), null);
    assert.equal(check(tool('tail -n 50 ~/.miser/miser.log'), d), null);
    return { question: response(check(prompt(`Are you still there in the ${mention} sprint?`), d)), read: response(check(tool('tail -n 50 ~/.miser/miser.log'), d)) };
  });
}
