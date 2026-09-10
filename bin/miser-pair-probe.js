#!/usr/bin/env node
'use strict';

// Read-only visibility: the same pinned mTLS transport and failover policy as
// the advisor. Optional WinRM reads require pywinrm and credentials in env.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createPairClient, parsePairAdvisor } = require('../src/pair-advisor');
const runFile = promisify(execFile);

const WINDOWS_PROBE = String.raw`
import json, os, winrm
endpoint = os.environ['WINRM_HOST']
if not endpoint.startswith(('http://','https://')):
    endpoint = 'http://' + endpoint + ':5985/wsman'
try:
    session = winrm.Session(endpoint, auth=(os.environ['WINRM_USER'], os.environ['WINRM_PASS']),
        transport='ntlm', operation_timeout_sec=10, read_timeout_sec=15)
    result = session.run_ps(r'''
$ErrorActionPreference = 'Stop'
$tasks = @(foreach ($name in @('NvidiaGpuPool-Ollama-PAIR-Engine','NvidiaGpuPool-PAIR-Broker')) {
  $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($t) { [pscustomobject]@{ Name=$name; Registered=$true; Enabled=$t.Settings.Enabled; State=[string]$t.State; WakeToRun=$t.Settings.WakeToRun } }
  else { [pscustomobject]@{ Name=$name; Registered=$false; Enabled=$false; State='Missing' } }
})
[pscustomobject]@{
  CheckedAt=(Get-Date).ToUniversalTime().ToString('o')
  Tasks=$tasks
  ActiveScheme=(powercfg /getactivescheme | Out-String)
  SleepStates=(powercfg /a | Out-String)
  SleepSettings=(powercfg /qh SCHEME_CURRENT SUB_SLEEP | Out-String)
  LidSettings=(powercfg /qh SCHEME_CURRENT SUB_BUTTONS LIDACTION | Out-String)
} | ConvertTo-Json -Depth 5 -Compress
''')
    if result.status_code != 0:
        print(json.dumps({'ok':False,'reason':'windows_read_failed'}))
    else:
        print(json.dumps({'ok':True,'snapshot':json.loads(result.std_out.decode('utf-8-sig'))}))
except Exception:
    print(json.dumps({'ok':False,'reason':'winrm_unavailable'}))
`;

async function windowsProbe() {
  const env = { PATH: process.env.PATH };
  for (const key of ['WINRM_HOST', 'WINRM_USER', 'WINRM_PASS']) {
    if (!process.env[key]) return { ok: false, reason: 'missing_winrm_environment' };
    env[key] = process.env[key];
  }
  try {
    const { stdout } = await runFile('python3', ['-c', WINDOWS_PROBE], { env, timeout: 20000, maxBuffer: 65536 });
    return JSON.parse(stdout);
  } catch (_) { return { ok: false, reason: 'windows_probe_failed_or_timed_out' }; }
}

async function probe(config, { windows = false, client = createPairClient(config), inspectWindows = windowsProbe } = {}) {
  const inference = await client.generate('Return exactly this JSON object: {"alive":true}', { numPredict: 32 });
  let answer;
  try { answer = JSON.parse(inference.text); } catch (_) { /* invalid below */ }
  const report = { checked_at: new Date().toISOString(), budget_ms: config.totalTimeoutMs,
    precision_inference: inference.ok && inference.target === 'precision' && answer?.alive === true,
    serving_target: inference.target || null, reason: inference.reason, attempts: inference.attempts || [],
    liveness: client.snapshot(), windows_checked: windows };
  if (windows) report.windows = await inspectWindows();
  const tasks = report.windows?.snapshot?.Tasks;
  report.tasks_registered_enabled_running = windows ? !!(report.windows?.ok && tasks?.length === 2
    && tasks.every(t => t.Registered === true && t.Enabled === true && t.State === 'Running')) : null;
  report.ok = report.precision_inference && (!windows || report.tasks_registered_enabled_running);
  report.acceptance = report.ok ? (windows ? 'PASS' : 'INFERENCE_ONLY_TASKS_UNCHECKED') : 'FAIL';
  report.sleep_resume_tested = false;
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const timeoutArg = args.find(arg => arg.startsWith('--timeout-ms='));
  const timeoutMs = timeoutArg ? Number(timeoutArg.slice('--timeout-ms='.length)) : 15000;
  if (args.some(arg => arg !== '--windows' && arg !== timeoutArg)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) {
    throw new Error('Usage: node bin/miser-pair-probe.js [--windows] [--timeout-ms=15000] (100..15000)');
  }
  const raw = process.env.MISER_PAIR_ADVISOR;
  const parsed = parsePairAdvisor(raw);
  if (raw && !parsed) throw new Error('Invalid or disabled MISER_PAIR_ADVISOR configuration');
  const config = { ...parsed, totalTimeoutMs: timeoutMs + 3500, precisionTimeoutMs: timeoutMs, fallbackTimeoutMs: 3500 };
  const report = await probe(config, { windows: args.includes('--windows') });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}

if (require.main === module) main().catch(err => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 2;
});

module.exports = { probe, windowsProbe };
