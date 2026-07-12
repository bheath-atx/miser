# miser — Mac Implementation Spec for Josh

**From:** Brad Heath  
**Date:** 2026-07-05  
**Repo:** https://github.com/bheath-atx/miser  
**Context:** miser is a local token compression + provider routing proxy Brad built for the TermDeck stack. Phase 1 is live on R730 (Linux). This doc covers what Josh needs to add for Mac support and potential native TermDeck stack integration.

---

## What miser does

miser is a transparent proxy that sits between Claude Code and the Anthropic API. Claude Code points `ANTHROPIC_BASE_URL` at miser (localhost:20128) instead of Anthropic directly. miser then:

1. **Compresses long contexts** — drops oldest conversation turns when token count exceeds 32K (configurable). Targets 30–40% reduction on long orch sessions. No effect on short sessions.
2. **Routes with fallback** — forwards to Anthropic API as primary. On 429 (quota exhausted), automatically falls back to local Ollama models. Session never stops.
3. **Tracks quota** — logs token spend per TermDeck project tag. Exposes `/api/miser/quota` endpoint.

Zero npm dependencies. Pure Node.js built-ins. ~600 lines total across 7 source files.

---

## Current R730 (Linux) implementation

```
Claude Code panel
    │  ANTHROPIC_BASE_URL=http://127.0.0.1:20128
    ▼
miser (Node.js, port 20128)
    │  compress if >32K tokens (turn-truncation)
    ├─ primary: Anthropic API (api.anthropic.com)
    └─ fallback on 429: CPU-lane Ollama :11435
         qwen2.5-coder:14b → qwen2.5:7b → qwen2.5:3b
```

**R730-specific:** The R730 has a dedicated CPU-lane Ollama instance on `:11435` (socket-2, NUMA-isolated from the GPU). All miser work runs CPU-only, zero GPU impact. Service managed via systemd user unit.

**`~/.termdeck/secrets.env`** contains `ANTHROPIC_BASE_URL=http://127.0.0.1:20128`. TermDeck sources this file on startup; all spawned panels inherit the var automatically.

---

## Mac implementation — what needs to change

The Node.js proxy code is 100% cross-platform. Three Mac-specific pieces needed:

### 1. Ollama target (config change only)

On Mac, Ollama runs as a standard app (menubar) or via Homebrew on `:11434` — there's no dedicated CPU lane. Change the default:

```
# R730 Linux
MISER_OLLAMA_URL=http://127.0.0.1:11435   ← CPU-lane

# Mac
MISER_OLLAMA_URL=http://127.0.0.1:11434   ← standard Ollama
```

This is already an env var — no code change required, just a different default or config value.

### 2. Service management: launchd instead of systemd

Replace `miser.service` (systemd) with `miser.plist` (launchd):

```xml
<!-- ~/Library/LaunchAgents/com.bheath-atx.miser.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.bheath-atx.miser</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/miser/src/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MISER_PORT</key><string>20128</string>
    <key>MISER_OLLAMA_URL</key><string>http://127.0.0.1:11434</string>
    <key>MISER_FALLBACK_MODELS</key><string>qwen2.5-coder:14b,qwen2.5:7b,qwen2.5:3b</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>
  <string>/tmp/miser.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/miser.log</string>
</dict>
</plist>
```

Install commands:
```bash
cp miser.plist ~/Library/LaunchAgents/com.bheath-atx.miser.plist
launchctl load ~/Library/LaunchAgents/com.bheath-atx.miser.plist
```

### 3. Ollama model availability

Mac users need to pull the fallback models if not already present:

```bash
ollama pull qwen2.5-coder:14b
ollama pull qwen2.5:7b
ollama pull qwen2.5:3b
```

---

## What Josh needs to add to the repo

| File | Purpose |
|---|---|
| `miser.plist` | launchd service template for Mac (mirrors `miser.service`) |
| `install-mac.sh` | Mac install script: check Node, check Ollama, pull models, copy plist, launchctl load, write secrets.env |
| `install-linux.sh` | Linux install script: check Node, check Ollama, copy .service, systemctl enable (currently manual) |
| README update | Mac install section alongside existing Linux section |

Optionally: a `miser install` CLI subcommand that detects `process.platform` and runs the right installer automatically — same pattern as `termdeck-stack start/stop/status`.

---

## TermDeck native integration (future)

The current miser is standalone — no TermDeck code changes needed. Future integration Josh could consider:

- **config.yaml `miser:` block** — TermDeck reads `~/.termdeck/config.yaml` and injects `ANTHROPIC_BASE_URL` automatically when miser is configured, instead of relying on `secrets.env`
- **Session meta fields** — miser writes `miserModel`, `compressedK`, `rawK` to `x-miser-*` response headers; TermDeck could pick these up and expose in the session overlay (similar to FR-5 `contextK`)
- **Flashback toast** — surface a toast when fallback activates (miserModel ≠ primary model)
- **Stack service** — add miser as a 4th service in `termdeck-stack start` alongside mnestra

None of this is required for Mac users to use miser today. It's a roadmap item once the standalone version is proven.

---

## Open questions for Josh

1. **Node path on Mac** — `/usr/local/bin/node` (Intel Homebrew) vs `/opt/homebrew/bin/node` (Apple Silicon). The plist needs the right path, or use `$(which node)` resolution in the install script.
2. **Install script scope** — just the plist + model pull, or full `npm install` + clone flow?
3. **termdeck-stack integration timing** — add miser to `termdeck-stack start` now, or after standalone is battle-tested on both platforms?

---

## Repo

https://github.com/bheath-atx/miser

Phase 1 live. 17 tests passing. CI on GitHub Actions.  
Brad will share the finished service files with Josh when Mac implementation is complete.
