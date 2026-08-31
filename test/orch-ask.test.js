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

function setup(t, codexJson = '{"task":"Dispatch Grok audit for PR351","pr":"351","facts":["CI passed","Do not poll CI"]}') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `miser-orch-ask-${process.pid}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'fake-bin');
  const outDir = path.join(root, 'prompts');
  const codexLog = path.join(root, 'codex.log');
  const dispatchLog = path.join(root, 'dispatch.log');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  writeExecutable(path.join(fakeBin, 'codex'), `#!/usr/bin/env bash
set -euo pipefail
out=""
prev=""
for arg in "$@"; do
  if [[ "$prev" == "-o" ]]; then out="$arg"; fi
  prev="$arg"
done
echo "$*" > "$FAKE_CODEX_LOG"
printf '%s\n' "$FAKE_CODEX_JSON" > "$out"
`);

  writeExecutable(path.join(fakeBin, 'orch-dispatch.sh'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$FAKE_DISPATCH_LOG"
echo "/tmp/generated-prompt.md"
`);

  return {
    root,
    home,
    outDir,
    codexLog,
    dispatchLog,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
      MISER_BIN_DIR: fakeBin,
      MISER_CODEX_BIN: path.join(fakeBin, 'codex'),
      MISER_ORCH_DISPATCH: path.join(fakeBin, 'orch-dispatch.sh'),
      MISER_PROMPT_OUT_DIR: outDir,
      FAKE_CODEX_LOG: codexLog,
      FAKE_DISPATCH_LOG: dispatchLog,
      FAKE_CODEX_JSON: codexJson,
    },
  };
}

function run(args, env, input = '') {
  return spawnSync('bash', [path.join(scriptBin, 'orch-ask.sh'), ...args], {
    cwd: repoRoot,
    env,
    input,
    encoding: 'utf8',
  });
}

test('normalizes free text with Codex and dispatches generated facts', (t) => {
  const f = setup(t);
  const res = run(['aetheria', 'run grok on PR351, CI passed, do not poll'], f.env);

  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), '/tmp/generated-prompt.md');
  const codex = fs.readFileSync(f.codexLog, 'utf8');
  assert.match(codex, /exec/);
  assert.match(codex, /--ephemeral/);
  assert.match(codex, /--sandbox read-only/);

  const dispatch = fs.readFileSync(f.dispatchLog, 'utf8');
  assert.match(dispatch, /--project\nAetheria-Concierge/);
  assert.match(dispatch, /--label\nORCH/);
  assert.match(dispatch, /--task\nDispatch Grok audit for PR351/);
  assert.match(dispatch, /--pr\n351/);

  const factsPath = dispatch.match(/--facts\n([^\n]+)/)[1];
  const facts = fs.readFileSync(factsPath, 'utf8');
  assert.match(facts, /CI passed/);
  assert.match(facts, /Do not poll CI/);
});

test('accepts stdin request and explicit session', (t) => {
  const f = setup(t, '{"task":"Dispatch builder for pkachu local synthesis","pr":"","facts":["Use Qwen or Gemma","Avoid Claude burn"]}');
  const res = run(['pkachu', '--session', 'sid-123', '--dry-run'], f.env, 'build local qwen/gemma query option');

  assert.equal(res.status, 0, res.stderr);
  const dispatch = fs.readFileSync(f.dispatchLog, 'utf8');
  assert.match(dispatch, /--project\npkachu/);
  assert.match(dispatch, /--session\nsid-123/);
  assert.match(dispatch, /--dry-run/);
  assert.match(dispatch, /Dispatch builder for pkachu local synthesis/);
});

test('fails closed when Codex returns invalid JSON', (t) => {
  const f = setup(t, 'not json');
  const res = run(['aetheria', 'run grok'], f.env);

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Codex returned no JSON object/);
  assert.equal(fs.existsSync(f.dispatchLog), false);
});

test('requires request text', (t) => {
  const f = setup(t);
  const res = run(['aetheria'], f.env);

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /missing request text/);
});
