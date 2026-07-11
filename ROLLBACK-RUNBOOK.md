# Miser failover cutover — rollback / quick-fix runbook

Branch: `fix/miser-brick-failover` (commits 6581af0 → a0fa20e → cd109cc → 3b7e1d7).
Live baseline (frozen, known-good): **`3d5f0f1`** at `/home/nacho/miser`, run by
systemd user unit `miser` (`ExecStart=node /home/nacho/miser/src/index.js`,
`Restart=on-failure`, `MISER_PORT=20128`).

⚠️ INFRA FROZEN: all `systemctl restart miser` actions are **Brad's** (or done on
his explicit real-time go). A panel must not restart miser on its own.

## Why cutover is low-risk (verified 2026-07-11)
1. **`src/index.js` is byte-identical to baseline** — the server bootstrap,
   port-bind, and single-instance lock (the reason infra was frozen) are
   untouched by this branch.
2. **Normal Anthropic 2xx path is behaviorally identical** — the only change to
   `forwardToAnthropic` is a defensive teardown on a post-header upstream error.
   Normal traffic behaves exactly as the frozen build.
3. **All new behavior is confined to the 429-failover path.**
4. **Automatic self-heal:** on ANY Codex error (401/403/4xx/5xx/timeout/no
   token) the router falls over to hard-capped Ollama. A misbehaving Codex leg
   degrades to the local model — it does NOT brick.
5. **Boot-safe:** the full module graph loads without a require-time crash
   (`MISER_PORT=0 node -e "require('./src/proxy.js')"` → OK), so `node index.js`
   cannot crash-loop on boot.
6. **Live-verified request:** miser's exact Codex request (headers + body + SSE)
   returns 200 from the real backend (probe 2026-07-11).

## Cutover (Brad's go)
```bash
cd /home/nacho/miser
git checkout fix/miser-brick-failover      # switch live tree to the fix
systemctl --user restart miser             # Brad runs this
sleep 3
curl -s http://127.0.0.1:20128/api/miser/health   # expect {"ok":true,...}
systemctl --user status miser --no-pager | head -5 # expect active (running)
```
No unit/env changes needed — new config keys all have safe defaults; `~/.codex/
auth.json` is already present for the OAuth bearer.

## QUICK FIX IF IT FAILS

### Triage (10 seconds)
- **Normal traffic broken (panels error on ordinary requests / miser down /
  crash-loop):** → **ROLLBACK immediately** (Layer 1).
- **Only the 429-failover misbehaves, normal traffic fine:** the Codex leg
  already self-degrades to Ollama (Layer 0). Not urgent — you may roll back at
  leisure or investigate `journalctl --user -u miser`.

### Layer 0 — automatic (no action)
Codex error → hard-capped Ollama. Already live in the code; no brick.

### Layer 1 — full rollback to frozen known-good (~5 s, Brad runs restart)
```bash
cd /home/nacho/miser
git checkout 3d5f0f1                        # back to the exact frozen build
systemctl --user restart miser             # Brad runs this
sleep 3
curl -s http://127.0.0.1:20128/api/miser/health   # expect {"ok":true,...}
```
`git checkout 3d5f0f1` restores `src/` to the frozen tree verbatim; because
`index.js` never changed, the restarted process is identical to the pre-cutover
service. Confirm a real panel works after.

### If the working tree is dirty and checkout refuses
```bash
git -C /home/nacho/miser stash    # or: git -C /home/nacho/miser reset --hard 3d5f0f1
```

## Post-incident
Capture `journalctl --user -u miser -n 200` BEFORE rolling forward again. The
failure is almost certainly in the failover path (translate-responses / router
Codex leg); the wire format is pinned in `CODEX-WIRE-FORMAT-PINNED.md`.
