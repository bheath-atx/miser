'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const script = path.join(repoRoot, 'bin', 'make-lane-prompt.js');

function run(args) {
  return spawnSync('node', [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

test('orch-dispatch prompt blocks source inspection and caps pre-dispatch tools', () => {
  const res = run([
    '--project', 'aetheria',
    '--kind', 'orch-dispatch',
    '--task', 'Sprint19 PR-4 Grok audit dispatch',
    '--pr', '351',
  ]);

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Maximum 4 tool calls before first dispatch/);
  assert.match(res.stdout, /Do not read artifact paths from this prompt before dispatch/);
  assert.match(res.stdout, /Pass artifact paths to the builder\/auditor briefing/);
  assert.match(res.stdout, /MISER_ASSIGNMENT=aetheria-sprint19-pr-4-grok-audit-dispatch-\d{17}/);
  assert.match(res.stdout, /DISPATCH_FINALIZE MISER_ASSIGNMENT=aetheria-sprint19-pr-4-grok-audit-dispatch-\d{17} CHILD_SESSION=pending/);
  assert.match(res.stdout, /BRAD_APPROVED_CONTINUE MISER_ASSIGNMENT=aetheria-sprint19-pr-4-grok-audit-dispatch-\d{17}/);
  assert.match(res.stdout, /Forbidden: grep\/read src\/, app\/, services\/, migrations\/, tests\/, logs, CI/);
  assert.match(res.stdout, /Do not run CI polling loops/);
  assert.match(res.stdout, /After dispatch, stop and report exactly this status block/);
  assert.match(res.stdout, /STATUS: DISPATCHED \| BLOCKED/);
  assert.match(res.stdout, /TASK: Sprint19 PR-4 Grok audit dispatch/);
  assert.match(res.stdout, /NEXT_GATE: <one exact next gate/);
  assert.match(res.stdout, /FOLLOWUP_COMMAND: orch-followup\.sh aetheria "what happened with PR351"/);
  assert.match(res.stdout, /STOP: yes/);
});

test('orch-dispatch accepts explicit assignment for deterministic callers', () => {
  const res = run([
    '--project', 'aetheria',
    '--kind', 'orch-dispatch',
    '--task', 'Sprint19 PR-4 Grok audit dispatch',
    '--pr', '351',
    '--assignment', 'operator-approved-pr351-rerun',
  ]);

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /MISER_ASSIGNMENT=operator-approved-pr351-rerun/);
  assert.match(res.stdout, /DISPATCH_FINALIZE MISER_ASSIGNMENT=operator-approved-pr351-rerun CHILD_SESSION=pending/);
  assert.match(res.stdout, /BRAD_APPROVED_CONTINUE MISER_ASSIGNMENT=operator-approved-pr351-rerun/);
  assert.doesNotMatch(res.stdout, /operator-approved-pr351-rerun-\d/);
});

test('codex-builder prompt includes spawn-lane boot validation phrases', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-lane-prompt-${process.pid}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const facts = path.join(dir, 'facts.md');
  fs.writeFileSync(facts, '- Build only PR-4.\n- Do not merge.\n', 'utf8');

  const res = run([
    '--project', 'aetheria',
    '--kind', 'codex-builder',
    '--task', 'Sprint19 PR-4 protected voice handoff',
    '--facts', facts,
    '--parent', 'parent-123',
    '--result', '/tmp/aetheria-pr4/ORCH-RESULT.md',
    '--summary', '/tmp/aetheria-pr4/SUMMARY.md',
    '--notify-url', 'POST :8001/v1/orch/aetheria/reply',
    '--notify-token-file', '~/.tg/orch-aetheria-reply.token',
  ]);

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /dispatcher-session-id: parent-123/);
  assert.match(res.stdout, /notify-back/);
  assert.match(res.stdout, /Do not wait to be polled/);
  assert.match(res.stdout, /ORCH-RESULT/);
  assert.match(res.stdout, /SUMMARY/);
  assert.match(res.stdout, /You may inspect repo\/source files as needed/);
  assert.match(res.stdout, /Do not inspect fleet\/session state/);
});

test('audit prompt is read-only one-shot with verdict structure', () => {
  const res = run([
    '--project', 'aetheria',
    '--kind', 'grok-audit',
    '--task', 'Audit Sprint19 PR-4',
    '--pr', 'https://github.com/bheath-atx/aetheria-phase1/pull/351',
    '--result', '/tmp/aetheria-pr351-grok/GROK-AUDIT.md',
  ]);

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /bounded Grok audit lane/);
  assert.match(res.stdout, /Read-only: no edits, commits, pushes, merges/);
  assert.match(res.stdout, /Default to REVISE unless/);
  assert.match(res.stdout, /VERDICT: APPROVE or REVISE/);
  assert.match(res.stdout, /Stop after notify-back/);
});

test('writes output file and creates parent directory', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `miser-lane-prompt-out-${process.pid}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'nested', 'PROMPT.md');

  const res = run([
    '--project', 'miser',
    '--kind', 'codex-audit',
    '--task', 'Audit prompt compiler',
    '--out', out,
  ]);

  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, '');
  const body = fs.readFileSync(out, 'utf8');
  assert.match(body, /miser codex-audit Prompt/);
  assert.match(body, /bounded Codex audit lane/);
});

test('rejects missing required args and unknown kind', () => {
  const missing = run(['--project', 'aetheria', '--kind', 'codex-builder']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /missing --task/);

  const unknown = run([
    '--project', 'aetheria',
    '--kind', 'builder-ish',
    '--task', 'x',
  ]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown --kind 'builder-ish'/);
});
