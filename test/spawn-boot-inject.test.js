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
  fs.writeFileSync(
    bootFile,
    'Use td-inject.sh to notify-back dispatcher-session-id.\nWrite a compact artifact and ORCH-RESULT.\n',
    'utf8',
  );

  const curlLog = path.join(root, 'curl.log');
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
  printf '{"id":"%s"}\\n' "\${FAKE_CHILD_ID:-child-1}"
  exit 0
fi
if [[ "$url" == */api/sessions/* ]]; then
  echo "status $url" >> "$FAKE_CURL_LOG"
  printf '{"meta":{"status":"%s"}}\\n' "\${FAKE_SESSION_STATUS:-thinking}"
  exit 0
fi
echo "unexpected $url" >> "$FAKE_CURL_LOG"
exit 2
`);
  writeExecutable(path.join(fakeBin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    FAKE_CURL_LOG: curlLog,
    FAKE_CURL_MODE: opts.mode || 'success',
    FAKE_CHILD_ID: opts.child || 'child-1',
    FAKE_SESSION_STATUS: opts.status || 'thinking',
    MISER_BIN_DIR: scriptBin,
    MISER_SPAWN_FAILURE_DIR: artifacts,
    MISER_BOOT_INJECT_WAIT_S: '0',
    MISER_BOOT_INJECT_POLL_SLEEP_S: '0',
    MISER_BOOT_INJECT_POLL_COUNT: '1',
  };
  delete env.TERMDECK_BASE;

  return { root, home, cwd, bootFile, curlLog, artifacts, env };
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

function artifactPath(fixture, child = 'child-1') {
  return path.join(fixture.artifacts, `boot-inject-${child}.md`);
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
  assert.match(artifact, /manual_recovery_command:/);
  assert.match(artifact, /td-inject\.sh child-1 "\$\(cat .+boot\.md\)" 3200/);
});

test('spawn-lane child-created but boot-unconfirmed writes artifact without duplicate injection', (t) => {
  const f = setupFixture(t, { status: 'idle' });
  const res = runScript('spawn-lane.sh', [
    '--parent', 'parent-1',
    '--project', 'aetheria',
    '--label', 'T1-builder',
    '--cwd', f.cwd,
    '--boot', f.bootFile,
    '--base', 'http://127.0.0.1:3200',
  ], f.env);

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /logged: child=child-1/);
  assert.match(res.stderr, /refusing duplicate boot injection/);
  assert.equal(countLog(f.curlLog, 'spawn '), 1);
  assert.equal(countLog(f.curlLog, 'input '), 2);

  const ledger = fs.readFileSync(path.join(f.home, '.termdeck', 'lane-spawns.jsonl'), 'utf8')
    .trim()
    .split(/\n/)
    .map(line => JSON.parse(line));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].child_session_id, 'child-1');
  assert.equal(ledger[0].parent_session_id, 'parent-1');

  const artifact = fs.readFileSync(artifactPath(f), 'utf8');
  assert.match(artifact, /attempts: 1/);
  assert.match(artifact, /last_status: idle/);
  assert.match(artifact, /cwd: .+work/);
  assert.match(artifact, /boot_file: .+boot\.md/);
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
