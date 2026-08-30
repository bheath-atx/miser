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

function setupFixture(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `miser-spawn-boot-${process.pid}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'fake-bin');
  const termdeck = path.join(home, '.termdeck');
  const cwd = path.join(root, 'work');
  const artifacts = path.join(root, 'artifacts');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(termdeck, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(termdeck, 'config.yaml'), 'token: test-token\n', 'utf8');

  const bootFile = path.join(root, 'boot.md');
  const badBootFile = path.join(root, 'bad-boot.md');
  const noSummaryBootFile = path.join(root, 'no-summary-boot.md');
  fs.writeFileSync(
    bootFile,
    'Use td-inject.sh to notify-back dispatcher-session-id.\nWrite a compact artifact and ORCH-RESULT.\n',
    'utf8',
  );
  fs.writeFileSync(badBootFile, 'Do some work without a completion contract.\n', 'utf8');
  fs.writeFileSync(noSummaryBootFile, 'Use td-inject.sh to notify-back dispatcher-session-id.\n', 'utf8');

  const curlLog = path.join(root, 'curl.log');
  const sleepLog = path.join(root, 'sleep.log');
  const statusCountFile = path.join(root, 'status-count');
  writeExecutable(path.join(fakeBin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
url=""
for arg in "$@"; do
  case "$arg" in
    http://*|https://*) url="$arg" ;;
  esac
done
echo "url $url" >> "$FAKE_CURL_LOG"
if [[ "$url" == */api/sessions/*/input ]]; then
  echo "input $url" >> "$FAKE_CURL_LOG"
  if [[ "\${FAKE_CURL_MODE:-success}" == "input-fail" ]]; then
    exit 22
  fi
  exit 0
fi
if [[ "$url" == */api/sessions/*/poke ]]; then
  echo "poke $url" >> "$FAKE_CURL_LOG"
  exit 0
fi
if [[ "$url" == */api/sessions ]]; then
  echo "spawn $url" >> "$FAKE_CURL_LOG"
  if [[ "\${FAKE_CURL_MODE:-success}" == "spawn-fail" ]]; then
    exit 7
  fi
  printf '{"id":"%s"}\\n' "\${FAKE_CHILD_ID:-child-1}"
  exit 0
fi
if [[ "$url" == */api/sessions/*/buffer ]]; then
  echo "buffer $url" >> "$FAKE_CURL_LOG"
  printf '{"ok":true,"status":"%s","statusDetail":"%s","lastActivity":"%s","replyCount":%s,"inputBufferLength":%s,"inputBufferPreview":"%s"}\\n' \
    "\${FAKE_BUFFER_STATUS:-\${FAKE_SESSION_STATUS:-thinking}}" \
    "\${FAKE_BUFFER_STATUS_DETAIL:-}" \
    "\${FAKE_LAST_ACTIVITY:-2026-08-30T00:00:00Z}" \
    "\${FAKE_REPLY_COUNT:-2}" \
    "\${FAKE_INPUT_BUFFER_LENGTH:-0}" \
    "\${FAKE_INPUT_BUFFER_PREVIEW:-}"
  exit 0
fi
if [[ "$url" == */api/sessions/* ]]; then
  echo "status $url" >> "$FAKE_CURL_LOG"
  count=0
  if [[ -f "$FAKE_STATUS_COUNT_FILE" ]]; then
    count="$(cat "$FAKE_STATUS_COUNT_FILE")"
  fi
  count=$((count + 1))
  printf '%s' "$count" > "$FAKE_STATUS_COUNT_FILE"
  status="\${FAKE_SESSION_STATUS:-thinking}"
  if [[ -n "\${FAKE_THINKING_AFTER_STATUS:-}" && "$count" -ge "\${FAKE_THINKING_AFTER_STATUS}" ]]; then
    status="thinking"
  fi
  if [[ -n "\${FAKE_CODEX_TRANSCRIPT_CWD:-}" && "$count" -ge "\${FAKE_CODEX_TRANSCRIPT_AFTER_STATUS:-1}" ]]; then
    day_dir="$HOME/.codex/sessions/$(date -u +%Y/%m/%d)"
    mkdir -p "$day_dir"
    printf '{"type":"session_meta","payload":{"cwd":"%s"}}\\n' "$FAKE_CODEX_TRANSCRIPT_CWD" > "$day_dir/rollout-test-$count.jsonl"
  fi
  printf '{"meta":{"status":"%s","statusDetail":"%s","lastActivity":"%s","requestCount":%s,"replyCount":%s}}\\n' \
    "$status" \
    "\${FAKE_STATUS_DETAIL:-}" \
    "\${FAKE_LAST_ACTIVITY:-2026-08-30T00:00:00Z}" \
    "\${FAKE_REQUEST_COUNT:-0}" \
    "\${FAKE_REPLY_COUNT:-2}"
  exit 0
fi
echo "unexpected $url" >> "$FAKE_CURL_LOG"
exit 2
`);
  writeExecutable(path.join(fakeBin, 'sleep'), '#!/usr/bin/env bash\necho "sleep $*" >> "$FAKE_SLEEP_LOG"\nexit 0\n');

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    FAKE_CURL_LOG: curlLog,
    FAKE_SLEEP_LOG: sleepLog,
    FAKE_STATUS_COUNT_FILE: statusCountFile,
    FAKE_CURL_MODE: opts.mode || 'success',
    FAKE_CHILD_ID: opts.child || 'child-1',
    FAKE_SESSION_STATUS: opts.status || 'thinking',
    MISER_BIN_DIR: scriptBin,
    MISER_SPAWN_FAILURE_DIR: artifacts,
  };
  if (!opts.defaultTiming) {
    env.MISER_BOOT_INJECT_WAIT_S = '0';
    env.MISER_BOOT_INJECT_POLL_SLEEP_S = '0';
  }
  if (opts.pollCount !== null) env.MISER_BOOT_INJECT_POLL_COUNT = String(opts.pollCount || 1);
  if (opts.thinkingAfterStatus) env.FAKE_THINKING_AFTER_STATUS = String(opts.thinkingAfterStatus);
  if (opts.codexTranscript) {
    env.FAKE_CODEX_TRANSCRIPT_CWD = cwd;
    env.FAKE_CODEX_TRANSCRIPT_AFTER_STATUS = String(opts.codexTranscriptAfterStatus || 1);
  }
  delete env.TERMDECK_BASE;

  return { root, home, cwd, bootFile, badBootFile, noSummaryBootFile, curlLog, sleepLog, artifacts, env };
}

function runScript(script, args, env) {
  return spawnSync('bash', [path.join(scriptBin, script), ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

function logLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split(/\n/).filter(Boolean);
}

function countLog(file, prefix) {
  return logLines(file).filter(line => line.startsWith(prefix)).length;
}

function artifactPath(fixture, kind = 'boot-unconfirmed', child = 'child-1') {
  return path.join(fixture.artifacts, `${kind}-${child}.md`);
}

function transcriptDir(home, cwd) {
  return path.join(home, '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
}

test('boot-inject succeeds on first-attempt injection', (t) => {
  const f = setupFixture(t);
  const res = runScript('boot-inject.sh', [
    '--child', 'child-1',
    '--boot', f.bootFile,
    '--parent', 'parent-1',
    '--base', 'http://127.0.0.1:3200',
    '--project', 'aetheria',
    '--label', 'T1-builder',
  ], f.env);

  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'child-1');
  assert.match(res.stderr, /boot prompt confirmed landed/);
  assert.equal(countLog(f.curlLog, 'input '), 2);
  assert.equal(fs.existsSync(artifactPath(f)), false);
});

test('boot-inject fails after max two td-inject attempts and writes recovery artifact', (t) => {
  const f = setupFixture(t, { mode: 'input-fail' });
  const res = runScript('boot-inject.sh', [
    '--child', 'child-1',
    '--boot', f.bootFile,
    '--parent', 'parent-1',
    '--base', 'http://127.0.0.1:3200',
    '--project', 'aetheria',
    '--label', 'T1-builder',
    '--cwd', f.cwd,
  ], f.env);

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /not confirmed after 2 attempt/);
  assert.equal(countLog(f.curlLog, 'input '), 2);

  const artifact = fs.readFileSync(artifactPath(f), 'utf8');
  assert.match(artifact, /verdict: FAILED/);
  assert.match(artifact, /child_session_id: child-1/);
  assert.match(artifact, /parent_session_id: parent-1/);
  assert.match(artifact, /label: T1-builder/);
  assert.match(artifact, /project: aetheria/);
  assert.match(artifact, /attempts: 2/);
  assert.match(artifact, /manual_recovery_note:/);
  assert.match(artifact, /No successful boot post was observed/);
  assert.match(artifact, /td-inject\.sh child-1 "\$\(cat .+boot\.md\)" 3200/);
});

test('spawn-lane child-created but boot-unconfirmed writes artifact without duplicate injection', (t) => {
  const f = setupFixture(t, { status: 'idle', pollCount: 4 });
  const res = runScript('spawn-lane.sh', [
    '--parent', 'parent-1',
    '--project', 'aetheria',
    '--label', 'T1-builder',
    '--cwd', f.cwd,
    '--boot', f.bootFile,
    '--base', 'http://127.0.0.1:3200',
  ], f.env);

  assert.notEqual(res.status, 0);
  assert.equal(res.stdout.trim(), 'child-1');
  assert.match(res.stderr, /logged: child=child-1/);
  assert.match(res.stderr, /refusing duplicate boot injection/);
  assert.match(res.stderr, /child id: child-1/);
  assert.match(res.stderr, /failure artifact: .+boot-unconfirmed-child-1\.md/);
  assert.equal(countLog(f.curlLog, 'spawn '), 1);
  assert.equal(countLog(f.curlLog, 'input '), 2);
  assert.equal(countLog(f.curlLog, 'status '), 4);

  const ledger = fs.readFileSync(path.join(f.home, '.termdeck', 'lane-spawns.jsonl'), 'utf8')
    .trim()
    .split(/\n/)
    .map(line => JSON.parse(line));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].child_session_id, 'child-1');
  assert.equal(ledger[0].parent_session_id, 'parent-1');

  const artifact = fs.readFileSync(artifactPath(f), 'utf8');
  assert.match(artifact, /attempts: 1/);
  assert.match(artifact, /timestamp_utc: /);
  assert.match(artifact, /base_url: http:\/\/127\.0\.0\.1:3200/);
  assert.match(artifact, /command: claude/);
  assert.match(artifact, /last_status: idle/);
  assert.match(artifact, /cwd: .+work/);
  assert.match(artifact, /boot_file: .+boot\.md/);
  assert.match(artifact, /observed_confirmation_signals:/);
  assert.match(artifact, /confirmation_rule: termdeck_status_thinking/);
  assert.match(artifact, /termdeck_reply_count: 2/);
  assert.match(artifact, /input_buffer_length: 0/);
  assert.match(artifact, /panel_lookup:/);
  assert.match(artifact, /Open http:\/\/127\.0\.0\.1:3200 in a browser/);
  assert.match(artifact, /buffer_inspection_command:/);
  assert.match(artifact, /sessions_list_command:/);
  assert.match(artifact, /Inspect the panel manually first/);
  assert.match(artifact, /Only re-inject if the boot input is visibly absent or truncated/);
  assert.doesNotMatch(artifact, /manual_recovery_command:\ntd-inject/);
});

test('spawn-lane codex boot confirms from fresh Codex transcript without thinking status', (t) => {
  const f = setupFixture(t, { status: 'active', pollCount: 4, codexTranscript: true });
  const res = runScript('spawn-lane.sh', [
    '--parent', 'parent-1',
    '--project', 'termdeck-updates',
    '--label', 'MISER-BOOT-CANARY',
    '--cwd', f.cwd,
    '--boot', f.bootFile,
    '--base', 'http://127.0.0.1:3200',
    '--command', 'codex',
  ], f.env);

  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'child-1');
  assert.match(res.stderr, /confirmed_by=codex_transcript_created/);
  assert.equal(countLog(f.curlLog, 'spawn '), 1);
  assert.equal(countLog(f.curlLog, 'input '), 2);
  assert.equal(countLog(f.curlLog, 'status '), 1);
  assert.equal(fs.existsSync(artifactPath(f)), false);
});

test('spawn-lane codex unconfirmed boot fails closed and gives conditional reinject command', (t) => {
  const f = setupFixture(t, { status: 'active', pollCount: 3 });
  const res = runScript('spawn-lane.sh', [
    '--parent', 'none',
    '--project', 'termdeck-updates',
    '--label', 'MISER-BOOT-CANARY',
    '--cwd', f.cwd,
    '--boot', f.bootFile,
    '--base', 'http://127.0.0.1:3200',
    '--command', 'codex',
  ], f.env);

  assert.notEqual(res.status, 0);
  assert.equal(res.stdout.trim(), 'child-1');
  assert.match(res.stderr, /refusing duplicate boot injection/);
  assert.equal(countLog(f.curlLog, 'input '), 2);
  assert.equal(countLog(f.curlLog, 'status '), 3);

  const artifact = fs.readFileSync(artifactPath(f), 'utf8');
  assert.match(artifact, /child_session_id: child-1/);
  assert.match(artifact, /parent_session_id: none/);
  assert.match(artifact, /project: termdeck-updates/);
  assert.match(artifact, /label: MISER-BOOT-CANARY/);
  assert.match(artifact, /base_url: http:\/\/127\.0\.0\.1:3200/);
  assert.match(artifact, /command: codex/);
  assert.match(artifact, /last_status: active/);
  assert.match(artifact, /confirmation_rule: codex_transcript_created/);
  assert.match(artifact, /confirmed_by: none/);
  assert.match(artifact, /codex_transcript_path: none/);
  assert.match(artifact, /conditional_reinject_command:/);
  assert.match(artifact, /td-inject\.sh child-1 .+Read .+boot\.md and execute it\./);
  assert.doesNotMatch(artifact, /<session/);
  assert.doesNotMatch(artifact, /<child/);
});

test('spawn-lane --no-inject skips boot injection while preserving spawn ledger', (t) => {
  const f = setupFixture(t);
  const res = runScript('spawn-lane.sh', [
    '--parent', 'parent-1',
    '--project', 'aetheria',
    '--label', 'T1-builder',
    '--cwd', f.cwd,
    '--boot', f.bootFile,
    '--base', 'http://127.0.0.1:3200',
    '--no-inject',
  ], f.env);

  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'child-1');
  assert.match(res.stderr, /--no-inject set/);
  assert.equal(countLog(f.curlLog, 'spawn '), 1);
  assert.equal(countLog(f.curlLog, 'input '), 0);
  assert.equal(fs.existsSync(artifactPath(f)), false);

  const ledger = fs.readFileSync(path.join(f.home, '.termdeck', 'lane-spawns.jsonl'), 'utf8');
  assert.match(ledger, /"child_session_id": "child-1"/);
});

test('spawn-lane can spawn without a boot file or injection', (t) => {
  const f = setupFixture(t);
  const res = runScript('spawn-lane.sh', [
    '--parent', 'parent-1',
    '--project', 'aetheria',
    '--label', 'T1-builder',
    '--cwd', f.cwd,
    '--base', 'http://127.0.0.1:3200',
  ], f.env);

  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'child-1');
  assert.equal(countLog(f.curlLog, 'spawn '), 1);
  assert.equal(countLog(f.curlLog, 'input '), 0);
  assert.equal(fs.existsSync(artifactPath(f)), false);
});

test('boot-inject performs max one successful boot POST while waiting for slow confirmation', (t) => {
  const f = setupFixture(t, { status: 'idle', pollCount: 5, thinkingAfterStatus: 5 });
  const res = runScript('boot-inject.sh', [
    '--child', 'child-1',
    '--boot', f.bootFile,
    '--parent', 'parent-1',
    '--base', 'http://127.0.0.1:3200',
    '--project', 'aetheria',
    '--label', 'T1-builder',
  ], f.env);

  assert.equal(res.status, 0, res.stderr);
  assert.equal(countLog(f.curlLog, 'input '), 2);
  assert.equal(countLog(f.curlLog, 'status '), 5);
  assert.match(res.stderr, /boot prompt confirmed landed/);
});

test('boot-inject default post-success confirmation window preserves about 120 seconds', (t) => {
  const f = setupFixture(t, { status: 'idle', pollCount: null, defaultTiming: true });
  const res = runScript('boot-inject.sh', [
    '--child', 'child-1',
    '--boot', f.bootFile,
    '--parent', 'parent-1',
    '--base', 'http://127.0.0.1:3200',
    '--project', 'aetheria',
    '--label', 'T1-builder',
  ], f.env);

  assert.notEqual(res.status, 0);
  assert.equal(countLog(f.curlLog, 'input '), 2);
  assert.equal(countLog(f.curlLog, 'status '), 67);
  assert.equal(logLines(f.sleepLog).filter(line => line === 'sleep 20').length, 1);
  assert.equal(logLines(f.sleepLog).filter(line => line === 'sleep 1.5').length, 67);
});

test('spawn-lane writes a spawn POST failure artifact', (t) => {
  const f = setupFixture(t, { mode: 'spawn-fail' });
  const res = runScript('spawn-lane.sh', [
    '--parent', 'parent-1',
    '--project', 'aetheria',
    '--label', 'T1-builder',
    '--cwd', f.cwd,
    '--boot', f.bootFile,
    '--base', 'http://127.0.0.1:3200',
  ], f.env);

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /spawn POST failed/);
  assert.equal(countLog(f.curlLog, 'spawn '), 1);
  assert.equal(countLog(f.curlLog, 'input '), 0);

  const artifact = fs.readFileSync(path.join(f.artifacts, 'spawn-lane-aetheria-T1-builder.md'), 'utf8');
  assert.match(artifact, /failure_type: spawn_post/);
  assert.match(artifact, /child_session_id: unknown/);
  assert.match(artifact, /parent_session_id: parent-1/);
  assert.match(artifact, /attempts: 1/);
  assert.match(artifact, /manual_recovery_command:/);
});

test('boot-inject writes a model-brick artifact after landed boot', (t) => {
  const f = setupFixture(t);
  const dir = transcriptDir(f.home, f.cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.jsonl'), 'There is an issue with the selected model (bad-model).\n', 'utf8');

  const res = runScript('boot-inject.sh', [
    '--child', 'child-1',
    '--boot', f.bootFile,
    '--parent', 'parent-1',
    '--base', 'http://127.0.0.1:3200',
    '--project', 'aetheria',
    '--label', 'T1-builder',
    '--cwd', f.cwd,
  ], f.env);

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /model-brick-child-1\.md/);
  const artifact = fs.readFileSync(artifactPath(f, 'model-brick'), 'utf8');
  assert.match(artifact, /failure_type: model_brick/);
  assert.match(artifact, /child_session_id: child-1/);
  assert.match(artifact, /last_error: issue with the selected model \(bad-model\)/);
  assert.match(artifact, /manual_recovery_command:/);
});

test('spawn-lane routes ORCH labels to the master :3100 instance by default', (t) => {
  const f = setupFixture(t);
  const res = runScript('spawn-lane.sh', [
    '--parent', 'parent-1',
    '--project', 'pkachu',
    '--label', 'pkachu-ORCH',
    '--cwd', f.cwd,
  ], f.env);

  assert.equal(res.status, 0, res.stderr);
  assert.ok(logLines(f.curlLog).some(line => line.includes('http://127.0.0.1:3100/api/sessions')));
});

test('spawn-lane routes worker labels to the builder :3200 instance by default', (t) => {
  const f = setupFixture(t);
  const res = runScript('spawn-lane.sh', [
    '--parent', 'parent-1',
    '--project', 'aetheria',
    '--label', 'T1-builder',
    '--cwd', f.cwd,
  ], f.env);

  assert.equal(res.status, 0, res.stderr);
  assert.ok(logLines(f.curlLog).some(line => line.includes('http://127.0.0.1:3200/api/sessions')));
});

test('spawn-lane requires --parent before any spawn POST', (t) => {
  const f = setupFixture(t);
  const res = runScript('spawn-lane.sh', [
    '--project', 'aetheria',
    '--label', 'T1-builder',
    '--cwd', f.cwd,
  ], f.env);

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /missing --parent/);
  assert.equal(countLog(f.curlLog, 'spawn '), 0);
});

test('spawn-lane rejects malformed model aliases before spawning', (t) => {
  const f = setupFixture(t);
  const res = runScript('spawn-lane.sh', [
    '--parent', 'parent-1',
    '--project', 'aetheria',
    '--label', 'T1-builder',
    '--cwd', f.cwd,
    '--model', 'opus-5',
  ], f.env);

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /REFUSING invalid --model 'opus-5'/);
  assert.equal(countLog(f.curlLog, 'spawn '), 0);
});

test('spawn-lane validates notify-back and SUMMARY boot contracts before spawning', (t) => {
  const f = setupFixture(t);
  const missingNotify = runScript('spawn-lane.sh', [
    '--parent', 'parent-1',
    '--project', 'aetheria',
    '--label', 'T1-builder',
    '--cwd', f.cwd,
    '--boot', f.badBootFile,
  ], f.env);

  assert.notEqual(missingNotify.status, 0);
  assert.match(missingNotify.stderr, /REFUSING task boot without notify-back instruction/);
  assert.equal(countLog(f.curlLog, 'spawn '), 0);

  const missingSummary = runScript('spawn-lane.sh', [
    '--parent', 'parent-1',
    '--project', 'aetheria',
    '--label', 'T1-builder',
    '--cwd', f.cwd,
    '--boot', f.noSummaryBootFile,
  ], f.env);

  assert.notEqual(missingSummary.status, 0);
  assert.match(missingSummary.stderr, /REFUSING task boot without compact result artifact contract/);
  assert.equal(countLog(f.curlLog, 'spawn '), 0);
});
