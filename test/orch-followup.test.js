'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const script = path.join(repoRoot, 'bin', 'orch-followup.sh');

function writeExecutable(file, body) {
  fs.writeFileSync(file, body, 'utf8');
  fs.chmodSync(file, 0o755);
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `miser-orch-followup-${process.pid}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'fake-bin');
  const termdeck = path.join(home, '.termdeck');
  const laneRoot = path.join(root, 'lanes');
  const outDir = path.join(root, 'prompts');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(termdeck, { recursive: true });
  fs.mkdirSync(path.join(laneRoot, 'builder-pr351'), { recursive: true });
  fs.writeFileSync(path.join(termdeck, 'config.yaml'), 'token: test-token\n', 'utf8');
  fs.writeFileSync(path.join(laneRoot, 'builder-pr351', 'ORCH-RESULT.md'), [
    'VERDICT: READY',
    'PR #351',
    'PR URL: https://github.com/bheath-atx/aetheria-phase1/pull/351',
    'Tests: CI passed',
    '',
  ].join('\n'), 'utf8');

  writeExecutable(path.join(fakeBin, 'gh'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2 $3" == "pr view 351" ]]; then
  printf '%s\\n' '{"number":351,"title":"Sprint19 PR-4","state":"OPEN","headRefName":"fix/pr351","headRefOid":"abc123","baseRefName":"main","mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","isDraft":false,"url":"https://github.com/bheath-atx/aetheria-phase1/pull/351"}'
  exit 0
fi
if [[ "$1 $2" == "run list" ]]; then
  printf '%s\\n' '[{"databaseId":33345975040,"workflowName":"CI","status":"completed","conclusion":"success","headSha":"abc123","url":"https://github.com/bheath-atx/aetheria-phase1/actions/runs/33345975040","updatedAt":"2026-08-31T04:00:00Z"}]'
  exit 0
fi
exit 2
`);
  writeExecutable(path.join(fakeBin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
url="\${@: -1}"
if [[ "$url" == "http://127.0.0.1:3100/api/sessions" ]]; then
  printf '%s\\n' '[{"id":"orch-sid","status":"idle","meta":{"project":"Aetheria-Concierge","label":"claude"},"command":"claude"}]'
  exit 0
fi
if [[ "$url" == "http://127.0.0.1:3200/api/sessions" ]]; then
  printf '%s\\n' '[{"id":"builder-sid","status":"idle","meta":{"project":"Aetheria-Concierge","label":"S19-PR4"},"command":"codex"}]'
  exit 0
fi
exit 2
`);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    AETHERIA_LANE_ROOT: laneRoot,
    MISER_PROMPT_OUT_DIR: outDir,
  };
  return { env, outDir };
}

test('prints PR, CI, sessions, and matching artifact without injection', (t) => {
  const f = setup(t);
  const res = spawnSync('bash', [script, 'aetheria', 'what happened with PR351'], {
    cwd: repoRoot,
    env: f.env,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /PR #351: Sprint19 PR-4/);
  assert.match(res.stdout, /CI run 33345975040: status=completed conclusion=success/);
  assert.match(res.stdout, /orch-sid status=idle/);
  assert.match(res.stdout, /builder-sid status=idle/);
  assert.match(res.stdout, /ORCH-RESULT.md/);
  assert.match(res.stdout, /This report used shell\/GitHub\/TermDeck APIs only; no ORCH turn was spent/);
  assert.match(res.stderr, /orch-followup: report=/);
});
