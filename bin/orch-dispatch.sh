#!/usr/bin/env bash
# One-command ORCH prompt generation + injection.

set -euo pipefail

PROJECT=""
KIND="orch-dispatch"
TASK=""
PR=""
FACTS_FILE=""
FACT_LINES=()
SESSION=""
LABEL=""
BASE="${TERMDECK_BASE:-http://127.0.0.1:3100}"
OUT_DIR="${MISER_PROMPT_OUT_DIR:-/tmp/miser-prompts}"
DRY_RUN=0
FORCE=0
DEDUP_TTL_SEC="${MISER_ORCH_DISPATCH_DEDUP_TTL_SEC:-600}"

usage() {
  cat <<'EOF'
Usage:
  orch-dispatch.sh --project <name> --task <text> [options]

Common:
  orch-dispatch.sh --project Aetheria-Concierge --label ORCH \
    --task "Dispatch Grok audit for PR351" --pr 351 \
    --fact "CI passed run 33345975040" \
    --fact "Builder result: /tmp/.../ORCH-RESULT.md"

Options:
  --kind <kind>       Prompt kind for make-lane-prompt (default: orch-dispatch)
  --pr <id-or-url>    PR id/url passed into the generated prompt
  --facts <file>      Compact facts file
  --fact <text>       Add one compact fact line; repeatable
  --session <id>      Inject into this TermDeck session id, skip lookup
  --label <pattern>   Require label contains this substring during lookup
  --base <url>        TermDeck base (default: http://127.0.0.1:3100)
  --out-dir <dir>     Prompt/facts output directory (default: /tmp/miser-prompts)
  --dry-run           Generate prompt and print the command target, but do not inject
  --force             Bypass duplicate-dispatch refusal
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --kind) KIND="$2"; shift 2 ;;
    --task) TASK="$2"; shift 2 ;;
    --pr) PR="$2"; shift 2 ;;
    --facts) FACTS_FILE="$2"; shift 2 ;;
    --fact) FACT_LINES+=("$2"); shift 2 ;;
    --session) SESSION="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "orch-dispatch: unknown arg '$1'" >&2; usage >&2; exit 1 ;;
  esac
done

[[ -z "$PROJECT" ]] && { echo "orch-dispatch: missing --project" >&2; exit 1; }
[[ -z "$TASK" ]] && { echo "orch-dispatch: missing --task" >&2; exit 1; }

BIN_DIR="${MISER_BIN_DIR:-$HOME/bin}"
MAKE_PROMPT="$BIN_DIR/make-lane-prompt"
TD_INJECT="${MISER_TD_INJECT:-$BIN_DIR/td-inject.sh}"
[[ -x "$MAKE_PROMPT" ]] || MAKE_PROMPT="$BIN_DIR/make-lane-prompt.js"
[[ -x "$MAKE_PROMPT" ]] || { echo "orch-dispatch: make-lane-prompt not executable under $BIN_DIR" >&2; exit 1; }
[[ $DRY_RUN -eq 1 || -x "$TD_INJECT" ]] || { echo "orch-dispatch: td-inject.sh not executable under $BIN_DIR" >&2; exit 1; }

mkdir -p "$OUT_DIR"
SAFE_PROJECT=$(PROJECT="$PROJECT" python3 - <<'PY'
import os, re
print(re.sub(r'[^A-Za-z0-9_.-]+', '-', os.environ['PROJECT']).strip('-') or 'project')
PY
)
STAMP=$(date -u +"%Y%m%dT%H%M%SZ")

if [[ -z "$FACTS_FILE" ]]; then
  FACTS_FILE="$OUT_DIR/${SAFE_PROJECT}-${STAMP}-facts.md"
  {
    if [[ ${#FACT_LINES[@]} -eq 0 ]]; then
      echo "No separate facts supplied. Use only the task text."
    else
      for fact in "${FACT_LINES[@]}"; do
        printf -- '- %s\n' "$fact"
      done
    fi
  } > "$FACTS_FILE"
elif [[ ! -r "$FACTS_FILE" ]]; then
  echo "orch-dispatch: facts file unreadable: $FACTS_FILE" >&2
  exit 1
fi

PROMPT_FILE="$OUT_DIR/${SAFE_PROJECT}-${STAMP}-${KIND}.md"
PROMPT_ARGS=(--project "$PROJECT" --kind "$KIND" --task "$TASK" --facts "$FACTS_FILE" --out "$PROMPT_FILE")
[[ -n "$PR" ]] && PROMPT_ARGS+=(--pr "$PR")
"$MAKE_PROMPT" "${PROMPT_ARGS[@]}"

TOKEN=$(grep -E '^[[:space:]]*token:' "$HOME/.termdeck/config.yaml" 2>/dev/null | head -1 | awk '{print $2}' || true)
if [[ -z "$TOKEN" ]]; then
  echo "orch-dispatch: no auth token in ~/.termdeck/config.yaml" >&2
  exit 1
fi

if [[ -z "$SESSION" ]]; then
  SESSIONS_JSON=$(curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/api/sessions")
  RESOLVE_OUTPUT=$(PROJECT="$PROJECT" LABEL="$LABEL" SESSIONS_JSON="$SESSIONS_JSON" python3 - <<'PY'
import json, os, sys

project = os.environ['PROJECT'].lower()
label_filter = os.environ.get('LABEL', '').lower()
aliases = {project}
if project in {'aetheria', 'aetheria-concierge'}:
    aliases.update({'aetheria', 'aetheria-concierge'})

try:
    sessions = json.loads(os.environ['SESSIONS_JSON'])
except Exception as exc:
    print(f'ERROR\tinvalid sessions JSON: {exc}')
    raise SystemExit(0)

matches = []
fallbacks = []
for s in sessions:
    meta = s.get('meta') or {}
    meta_project = str(meta.get('project') or s.get('project') or '').lower()
    label = str(meta.get('label') or s.get('label') or '').lower()
    command = str(s.get('command') or meta.get('command') or '').lower()
    status = str(s.get('status') or meta.get('status') or '').lower()
    sid = str(s.get('id') or '')
    if not sid:
        continue
    if meta_project not in aliases:
        continue
    if label_filter and label_filter not in label:
        continue
    if status in {'closed', 'exited', 'dead'}:
        continue
    row = (sid, status, label or '-', meta_project or '-', command or '-')
    if not label_filter and 'orch' not in label:
        if command.startswith('claude'):
            fallbacks.append(row)
        continue
    matches.append(row)

if not matches and len(fallbacks) == 1:
    matches = fallbacks

if len(matches) == 1:
    print('OK\t' + '\t'.join(matches[0]))
elif not matches:
    print('ERROR\tno matching ORCH session found')
else:
    print('ERROR\tambiguous ORCH session match')
    for row in matches:
        print('MATCH\t' + '\t'.join(row))
PY
)
  if [[ "$RESOLVE_OUTPUT" != OK$'\t'* ]]; then
    echo "$RESOLVE_OUTPUT" >&2
    echo "orch-dispatch: pass --session <id> or narrow with --label <substring>" >&2
    exit 1
  fi
  SESSION=$(awk -F'\t' 'NR==1 {print $2}' <<<"$RESOLVE_OUTPUT")
fi

PORT=$(BASE="$BASE" python3 - <<'PY'
from urllib.parse import urlparse
import os
u = urlparse(os.environ['BASE'])
print(u.port or (443 if u.scheme == 'https' else 80))
PY
)

echo "orch-dispatch: prompt=$PROMPT_FILE" >&2
echo "orch-dispatch: facts=$FACTS_FILE" >&2
echo "orch-dispatch: session=$SESSION base=$BASE" >&2

if [[ $DRY_RUN -eq 1 ]]; then
  echo "orch-dispatch: dry-run; not injecting" >&2
  echo "$PROMPT_FILE"
  exit 0
fi

PROMPT_HASH=$(sha256sum "$PROMPT_FILE" | awk '{print $1}')
DEDUP_DIR="$OUT_DIR/.orch-dispatch-injections"
DEDUP_KEY=$(PROJECT="$PROJECT" SESSION="$SESSION" HASH="$PROMPT_HASH" python3 - <<'PY'
import os, re
raw = f"{os.environ['PROJECT']}--{os.environ['SESSION']}--{os.environ['HASH']}"
print(re.sub(r'[^A-Za-z0-9_.-]+', '-', raw).strip('-') or 'dispatch')
PY
)
DEDUP_FILE="$DEDUP_DIR/$DEDUP_KEY"
if [[ $FORCE -ne 1 && -f "$DEDUP_FILE" ]]; then
  NOW=$(date +%s)
  LAST=$(stat -c %Y "$DEDUP_FILE" 2>/dev/null || echo 0)
  AGE=$((NOW - LAST))
  if [[ "$DEDUP_TTL_SEC" =~ ^[0-9]+$ && "$AGE" -lt "$DEDUP_TTL_SEC" ]]; then
    echo "orch-dispatch: duplicate prompt already injected to session $SESSION ${AGE}s ago; refusing to spend another ORCH turn" >&2
    echo "orch-dispatch: previous=$DEDUP_FILE" >&2
    echo "orch-dispatch: use --force only if you intentionally want a second ORCH management turn" >&2
    exit 1
  fi
fi

"$TD_INJECT" "$SESSION" "$(<"$PROMPT_FILE")" "$PORT"
mkdir -p "$DEDUP_DIR"
{
  printf 'project=%s\n' "$PROJECT"
  printf 'session=%s\n' "$SESSION"
  printf 'prompt=%s\n' "$PROMPT_FILE"
  printf 'hash=%s\n' "$PROMPT_HASH"
  printf 'created_at=%s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
} > "$DEDUP_FILE"
echo "$PROMPT_FILE"
