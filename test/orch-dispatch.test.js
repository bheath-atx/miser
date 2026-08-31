'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const scriptBin = path.join(repoRoot, 'bin');

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, 'utf8');
  fs.chmodSync(file, 0o755);
}

function setup(t, sessions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `miser-orch-dispatch-${process.pid}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'fake-bin');
  const termdeck = path.join(home, '.termdeck');
  const outDir = path.join(root, 'prompts');
  const curlLog = path.join(root, 'curl.log');
  const injectLog = path.join(root, 'inject.log');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(termdeck, { recursive: true });
  fs.writeFileSync(path.join(termdeck, 'config.yaml'), 'token: test-token\n', 'utf8');
  fs.writeFileSync(path.join(root, 'sessions.json'), JSON.stringify(sessions), 'utf8');

  writeExecutable(path.join(fakeBin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
url="\${@: -1}"
echo "$url" >> "$FAKE_CURL_LOG"
if [[ "$url" == */api/sessions ]]; then
  cat "$FAKE_SESSIONS_JSON"
  exit 0
fi
exit 2
`);
  writeExecutable(path.join(fakeBin, 'td-inject.sh'), `#!/usr/bin/env bash
set -euo pipefail
printf 'sid=%s\\nport=%s\\ntext=%s\\n' "$1" "$3" "$2" > "$FAKE_INJECT_LOG"
`);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    MISER_BIN_DIR: scriptBin,
    MISER_TD_INJECT: path.join(fakeBin, 'td-inject.sh'),
    MISER_PROMPT_OUT_DIR: outDir,
    FAKE_CURL_LOG: curlLog,
    FAKE_INJECT_LOG: injectLog,
    FAKE_SESSIONS_JSON: path.join(root, 'sessions.json'),
  };
  delete env.TERMDECK_BASE;
  return { root, home, outDir, curlLog, injectLog, env };
}

function run(args, env) {
  return spawnSync('bash', [path.join(scriptBin, 'orch-dispatch.sh'), ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

test('generates prompt, resolves a unique ORCH session, and injects it', (t) => {
  const f = setup(t, [
    { id: 'sid-1', status: 'idle', meta: { project: 'Aetheria-Concierge', label: 'Aetheria-Concierge-ORCH' }, command: 'claude' },
  ]);

  const res = run([
    '--project', 'aetheria',
    '--label', 'ORCH',
    '--task', 'Dispatch Grok audit for PR351',
    '--pr', '351',
    '--fact', 'CI passed run 33345975040',
  ], f.env);

  assert.equal(res.status, 0, res.stderr);
  const promptPath = res.stdout.trim();
  assert.ok(promptPath.endsWith('-orch-dispatch.md'));
  const prompt = fs.readFileSync(promptPath, 'utf8');
  assert.match(prompt, /Dispatch Grok audit for PR351/);
  assert.match(prompt, /CI passed run 33345975040/);
  assert.match(prompt, /Maximum 8 tool calls before first dispatch/);

  const inject = fs.readFileSync(f.injectLog, 'utf8');
  assert.match(inject, /sid=sid-1/);
  assert.match(inject, /port=3100/);
  assert.match(inject, /Dispatch Grok audit for PR351/);
});

test('refuses duplicate prompt injection to the same session inside ttl', (t) => {
  const f = setup(t, [
    { id: 'sid-1', status: 'idle', meta: { project: 'Aetheria-Concierge', label: 'Aetheria-Concierge-ORCH' }, command: 'claude' },
  ]);
  const args = [
    '--project', 'aetheria',
    '--label', 'ORCH',
    '--task', 'Dispatch Grok audit for PR351',
    '--pr', '351',
    '--fact', 'CI passed run 33345975040',
  ];

  const first = run(args, f.env);
  assert.equal(first.status, 0, first.stderr);
  const second = run(args, f.env);

  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /duplicate prompt already injected to session sid-1/);
  assert.match(second.stderr, /refusing to spend another ORCH turn/);
});

test('force bypasses duplicate prompt injection refusal', (t) => {
  const f = setup(t, [
    { id: 'sid-1', status: 'idle', meta: { project: 'Aetheria-Concierge', label: 'Aetheria-Concierge-ORCH' }, command: 'claude' },
  ]);
  const args = [
    '--project', 'aetheria',
    '--label', 'ORCH',
    '--task', 'Dispatch Grok audit for PR351',
    '--pr', '351',
    '--fact', 'CI passed run 33345975040',
  ];

  assert.equal(run(args, f.env).status, 0);
  const forced = run([...args, '--force'], f.env);

  assert.equal(forced.status, 0, forced.stderr);
});

test('dry-run writes prompt but does not inject', (t) => {
  const f = setup(t, [
    { id: 'sid-1', status: 'idle', meta: { project: 'miser', label: 'miser-ORCH' }, command: 'claude' },
  ]);

  const res = run([
    '--project', 'miser',
    '--task', 'Dispatch audit',
    '--dry-run',
  ], f.env);

  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.existsSync(f.injectLog), false);
  assert.match(fs.readFileSync(res.stdout.trim(), 'utf8'), /dry-run|Dispatch audit/);
});

test('ambiguous ORCH match fails before injection', (t) => {
  const f = setup(t, [
    { id: 'sid-1', status: 'idle', meta: { project: 'aetheria', label: 'Aetheria-ORCH' } },
    { id: 'sid-2', status: 'idle', meta: { project: 'aetheria', label: 'Aetheria-OLD-ORCH' } },
  ]);

  const res = run([
    '--project', 'aetheria',
    '--task', 'Dispatch audit',
  ], f.env);

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /ambiguous ORCH session match/);
  assert.match(res.stderr, /pass --session <id> or narrow with --label/);
  assert.equal(fs.existsSync(f.injectLog), false);
});

test('falls back to a single live Claude project session when no ORCH label exists', (t) => {
  const f = setup(t, [
    { id: 'sid-claude', status: 'idle', meta: { project: 'Aetheria-Concierge', label: 'claude' }, command: 'claude' },
    { id: 'sid-codex', status: 'idle', meta: { project: 'Aetheria-Concierge', label: 'codex' }, command: 'codex' },
  ]);

  const res = run([
    '--project', 'aetheria',
    '--task', 'Dispatch audit',
  ], f.env);

  assert.equal(res.status, 0, res.stderr);
  const inject = fs.readFileSync(f.injectLog, 'utf8');
  assert.match(inject, /sid=sid-claude/);
});

test('explicit session skips lookup', (t) => {
  const f = setup(t, []);

  const res = run([
    '--project', 'aetheria',
    '--session', 'manual-sid',
    '--task', 'Dispatch audit',
    '--base', 'http://127.0.0.1:3200',
  ], f.env);

  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.existsSync(f.curlLog), false);
  const inject = fs.readFileSync(f.injectLog, 'utf8');
  assert.match(inject, /sid=manual-sid/);
  assert.match(inject, /port=3200/);
});
