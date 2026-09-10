# PAIR advisor: operation and rollback

Status: isolated, uncommitted patch in `/home/nacho/miser-smart-enforcement-pair-build`,
branch `feat/pair-async-advisor`, based on `451bd49e9f7a635e14f0b52d0046573b25518467`.
Brad completed peer trust; see the sprint's `PAIR-TRUST-ACCEPTANCE.md`.
The live Miser checkout, service, PAIR configuration, tasks and power settings were not changed.
Codex inversion-QA → voice-pass → Grok builder-audit must finish before merge/cutover.
Brad owns any installation, service environment change and restart.

## Behavior and boundaries

The proxy awaits the advisor only when the deterministic result would be a watcher redirect
for a protected ORCH's bounded external metadata lookup. Accepted shell shape:

```bash
for repo in rtk-ai/rtk juliusbrussee/caveman headroomlabs-ai/headroom; do gh repo view "$repo" --json nameWithOwner,description,stargazerCount,forkCount,licenseInfo,updatedAt,url; done
```

The grammar permits one to five distinct literal `owner/repo` names and known metadata fields.
It rejects additional statements, substitutions, redirections, pipes, other flags, local paths,
unknown tool arguments and mixed tool batches. Other command spellings keep existing enforcement.
The model must return valid JSON with `intent=external_verification`, `action=allow`,
`should_count=false` and confidence ≥0.75. It cannot verify a repository's trustworthiness.
Hard safety, writes, local sweeps, output limits, worker role exemptions and existing budget
state remain deterministic. Only the approved read is exempt from counting; budgets are not reset.
Boot `Read` behavior stays narrow; marked `head -n N` of a known setup file is limited to 200 lines.
Unmarked shell commands receive no new boot exemption.

## Enablement after review

Set this in Miser's **service environment**, preserving existing `MISER_ENFORCEMENT` policy:

```text
MISER_PAIR_ADVISOR={"enabled":true}
```

Unset, false or invalid configuration disables the caller. Existing policy must have
`redirect.mode` set to `warn` or `enforce` for advisor eligibility; this patch does not enable
enforcement or edit live policy. An interactive shell export does not change an existing service.
For a different normal-user PAIR directory, add an absolute `configDir` in that JSON.

| Setting | Default | Permitted range |
| --- | --- | --- |
| `totalTimeoutMs` | 20000 | 100–20000 |
| `precisionTimeoutMs` | 15000 | 50–15000 |
| `fallbackTimeoutMs` | 5000 | 50–5000 |
| `livenessTtlMs`, `decisionTtlMs` | 30000 | 100–60000 |
| `maxConcurrent` | 2 | 1–4 |
| `maxCacheEntries` | 128 | 1–256 |

The total deadline includes both routes. Each inference includes async certificate reads,
connection, headers and response body. Normal unrelated requests do not wait for the advisor.
Identical pending lookups share inference; capacity overflow keeps deterministic enforcement.
Recent failures suppress repeated attempts for 30 seconds, including across different prompts.
Verdict caching also covers malformed/low-confidence replies. No request is retried on an endpoint.

Precision: `https://100.115.118.29:11434`, `qwen3:4b`. The client reads its existing local
PAIR identity and trusted peer record from `~/.config/Nvidia Corporation/Personal AI Router`.
It requires matching cluster IDs, expected node UUIDs, CA/expiry validation, the exact Precision
certificate pin and local client certificate/key. No certificate or key is copied into Miser.
There is no plaintext remote ingress or TLS verification bypass.

Per730: `http://127.0.0.1:11434`, `qwen2.5:1.5b-instruct`, only after a Precision deadline,
connection unavailability or HTTP 408/429/502/503/504. A recent unavailable cache entry permits
that same failover until expiry. Trust/configuration errors and malformed opinions keep the
deterministic result; they do not select another model. Successful calls always prefer Precision.

## Read-only checks from Per730

```bash
node /home/nacho/miser-smart-enforcement-pair-build/bin/miser-pair-probe.js
node /home/nacho/miser-smart-enforcement-pair-build/bin/miser-pair-probe.js --windows
```

The second command needs `pywinrm` and `WINRM_HOST`, `WINRM_USER`, `WINRM_PASS` already loaded
securely in its environment. It uses NTLM and reads both scheduled tasks and power settings.
Credentials are not command arguments or report fields. The probe never changes Windows settings.
Without `--windows`, success is labeled `INFERENCE_ONLY_TASKS_UNCHECKED`; full `PASS` requires
Precision inference and both tasks registered/enabled/Running. A Per730-only success fails
Precision acceptance. Exit 0 means the requested checks passed, 1 means failed, 2 means usage/config error.
`--timeout-ms=N` bounds Precision at 100–15000 ms; diagnostic failover gets up to another 3500 ms.
WinRM has a separate 20-second deadline. Schedule the probe externally only if desired; no schedule
was installed. It reports fresh visibility and does not seed the running proxy's in-memory cache.

After installation, `curl -fsS http://127.0.0.1:20128/api/miser/health` adds `pairAdvisor`: active requests, bounded cache size and
per-target liveness with `fresh`/`state`/expiry. No network probe runs merely to read health.
Eligible inference itself refreshes liveness; a cached model decision requires no GPU call.
Enforcement events distinguish `advisor_allow` from `advisor_fallback`, retaining deterministic
control responses with `retryable=false`. Prompts, tool output and credentials are not logged.

## Precision power findings — 2026-09-10 02:20 UTC

Both `NvidiaGpuPool-Ollama-PAIR-Engine` and `NvidiaGpuPool-PAIR-Broker` were registered,
enabled and Running. Both have `WakeToRun=false`. Active scheme is Balanced; Windows reports
S0 Low Power Idle with network connectivity, not S3. Read-only evidence is
`/home/nacho/sprints/20260909-miser-smart-enforcement-pair/advisor-live-windows-probe.json`.

| Setting | Plugged in (AC) | Battery (DC) |
| --- | --- | --- |
| Idle sleep | Never (0 s) | 30 min (1800 s) |
| Lid close | Do nothing | Sleep |
| Hibernate timer | Never (0 s) | 2147483647 s |
| Hidden unattended sleep timeout | 120 s | 120 s |

Operational recommendation for Brad: retain the existing awake-on-AC settings and use Per730
failover during battery sleep. No power change is needed for the currently observed ordinary
AC idle/lid policy. This is an inference from settings; physical idle/lid/resume was not tested.
S0 networking does not establish that PAIR/Ollama can execute inference during sleep: Windows
can pause desktop applications and throttle services. See [Microsoft's Modern Standby app behavior](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/integrating-apps-with-modern-standby).

The hidden 120-second timer applies after an unattended wake. If Brad wants the Precision to
remain available after that kind of wake, an AC-only unattended-timeout change is a separate
decision after a controlled test; preserve battery policy. A keep-alive ping is not a verified
substitute. See [Microsoft's unattended idle timeout definition](https://learn.microsoft.com/en-us/windows-hardware/customize/power-settings/sleep-settings-sleep-unattended-idle-timeout).

## Rollback

After cutover, remove `MISER_PAIR_ADVISOR` or set `{"enabled":false}` in the service environment;
Brad restarts Miser using the existing service procedure. This immediately removes inference
from enforcement and restores deterministic watcher decisions, including the original metadata
false positive. It does not undo the deterministic role and marked-boot fixes in this patch.
If a full code rollback is needed, restore the exact checkout/environment captured immediately
before this cutover. Do not use the historical July commit IDs as this change's baseline.
PAIR trust and Windows tasks remain installed; do not run peer-trust rollback to disable the advisor.
