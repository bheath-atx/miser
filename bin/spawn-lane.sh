#!/usr/bin/env bash
# Atomic TermDeck panel spawn + lineage record, with optional bounded boot inject.

set -euo pipefail

PARENT=""
PROJECT=""
LABEL=""
CWD=""
ROLE="null"
TYPE="claude-code"
COMMAND="claude"
MODEL=""
BOOT_FILE=""
NO_INJECT=0
REASON=""
BASE="${TERMDECK_BASE:-http://127.0.0.1:3200}"
BASE_EXPLICIT=0
[[ -n "${TERMDECK_BASE:-}" ]] && BASE_EXPLICIT=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --parent)   PARENT="$2"; shift 2 ;;
    --base)     BASE="$2"; BASE_EXPLICIT=1; shift 2 ;;
    --project)  PROJECT="$2"; shift 2 ;;
    --label)    LABEL="$2"; shift 2 ;;
    --cwd)      CWD="$2"; shift 2 ;;
    --role)
      if [[ "$2" == "orchestrator" ]]; then
        echo "spawn-lane: WARN --role orchestrator blocked; use an -ORCH label instead" >&2
      else
        ROLE="$2"
      fi
      shift 2 ;;
    --type)     TYPE="$2"; shift 2 ;;
    --command)  COMMAND="$2"; shift 2 ;;
    --model)    MODEL="$2"; shift 2 ;;
    --boot)     BOOT_FILE="$2"; shift 2 ;;
    --no-inject) NO_INJECT=1; shift ;;
    --reason)   REASON="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,42p' "$0"
      exit 0 ;;
    *)
      echo "spawn-lane: unknown arg '$1' - try --help" >&2
      exit 1 ;;
  esac
done

if [[ $BASE_EXPLICIT -eq 0 && "${LABEL^^}" == *-ORCH ]]; then
  BASE="http://127.0.0.1:3100"
  echo "spawn-lane: label '$LABEL' looks like an orch panel -> targeting master instance $BASE" >&2
fi

for var in PARENT PROJECT LABEL CWD; do
  if [[ -z "${!var}" ]]; then
    echo "spawn-lane: missing --${var,,}" >&2
    exit 1
  fi
done

if [[ ! -d "$CWD" ]]; then
  echo "spawn-lane: cwd does not exist: $CWD" >&2
  exit 1
fi

if [[ -n "$MODEL" ]]; then
  if [[ ! "$MODEL" =~ ^(opus|sonnet|haiku)$ && "$MODEL" != claude-* ]]; then
    echo "spawn-lane: REFUSING invalid --model '$MODEL'." >&2
    echo "  Use a bare alias (opus|sonnet|haiku) or a fully-qualified claude-* id." >&2
    exit 1
  fi
fi

TOKEN=$(grep -E '^[[:space:]]*token:' "$HOME/.termdeck/config.yaml" 2>/dev/null | head -1 | awk '{print $2}' || true)
if [[ -z "$TOKEN" ]]; then
  echo "spawn-lane: no auth token in ~/.termdeck/config.yaml" >&2
  exit 1
fi

if [[ -n "$BOOT_FILE" && ! -r "$BOOT_FILE" ]]; then
  echo "spawn-lane: boot file unreadable: $BOOT_FILE" >&2
  exit 1
fi

if [[ -n "$BOOT_FILE" && "${LABEL^^}" != *-ORCH ]]; then
  BOOT_TEXT=$(<"$BOOT_FILE")
  if ! grep -Eiq '(td-inject\.sh|notify[- ]?back|Do not wait to be polled|dispatcher-session-id)' <<< "$BOOT_TEXT"; then
    echo "spawn-lane: REFUSING task boot without notify-back instruction: $BOOT_FILE" >&2
    exit 1
  fi
  if ! grep -Eiq '(ORCH-RESULT|SUMMARY|compact[- ]?(lane )?result|compact artifact)' <<< "$BOOT_TEXT"; then
    echo "spawn-lane: REFUSING task boot without compact result artifact contract: $BOOT_FILE" >&2
    exit 1
  fi
fi

REASON_DEFAULT="spawned via spawn-lane.sh by parent $PARENT"
[[ -z "$REASON" ]] && REASON="$REASON_DEFAULT"
if [[ -n "$MODEL" ]]; then
  printf -v MODEL_SHELL '%q' "$MODEL"
  COMMAND="$COMMAND --model $MODEL_SHELL"
fi

PAYLOAD=$(PARENT="$PARENT" PROJECT="$PROJECT" LABEL="$LABEL" CWD="$CWD" \
  ROLE="$ROLE" TYPE="$TYPE" COMMAND="$COMMAND" REASON="$REASON" \
  python3 -c '
import json, os
p = {
  "command": os.environ["COMMAND"],
  "cwd": os.environ["CWD"],
  "project": os.environ["PROJECT"],
  "label": os.environ["LABEL"],
  "type": os.environ["TYPE"],
  "reason": os.environ["REASON"],
}
role = os.environ["ROLE"]
if role != "null":
    p["role"] = role
print(json.dumps(p))
')

RESP=$(curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$BASE/api/sessions")

CHILD_ID=$(echo "$RESP" | python3 -c '
import sys, json
try:
    obj = json.loads(sys.stdin.read())
    sys.stdout.write(obj.get("id", ""))
except Exception:
    pass
')

if [[ -z "$CHILD_ID" ]]; then
  echo "spawn-lane: spawn POST failed - response: $RESP" >&2
  exit 1
fi

SPAWN_LOG="$HOME/.termdeck/lane-spawns.jsonl"
mkdir -p "$(dirname "$SPAWN_LOG")"
NOW_UTC=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

PARENT="$PARENT" CHILD_ID="$CHILD_ID" LABEL="$LABEL" PROJECT="$PROJECT" \
  CWD="$CWD" ROLE="$ROLE" NOW_UTC="$NOW_UTC" \
  python3 -c '
import json, os
role = os.environ["ROLE"]
rec = {
  "spawned_at": os.environ["NOW_UTC"],
  "parent_session_id": os.environ["PARENT"],
  "child_session_id": os.environ["CHILD_ID"],
  "child_label": os.environ["LABEL"],
  "child_project": os.environ["PROJECT"],
  "child_cwd": os.environ["CWD"],
  "child_role": None if role == "null" else role,
  "spawned_by_tool": "spawn-lane.sh",
}
print(json.dumps(rec))
' >> "$SPAWN_LOG"

echo "[spawn-lane] logged: child=$CHILD_ID label=$LABEL project=$PROJECT parent=$PARENT" >&2

if [[ "$PROJECT" == "pkachu" && ( "$ROLE" == "orchestrator" || "$LABEL" == *ORCH* ) && -z "$BOOT_FILE" ]]; then
  mkdir -p "$HOME/.tg"
  printf '%s\n' "$CHILD_ID" > "$HOME/.tg/orch-session.id"
  echo "[spawn-lane] pkachu orch link auto-updated: ~/.tg/orch-session.id -> $CHILD_ID" >&2
fi

if [[ -n "$BOOT_FILE" && "$NO_INJECT" == "1" ]]; then
  echo "[spawn-lane] --no-inject set: boot file recorded but NOT injected. Caller must run boot-inject.sh separately." >&2
fi

if [[ -n "$BOOT_FILE" && "$NO_INJECT" != "1" ]]; then
  BIN_DIR="${MISER_BIN_DIR:-$HOME/bin}"
  "$BIN_DIR/boot-inject.sh" \
    --child "$CHILD_ID" --boot "$BOOT_FILE" --parent "$PARENT" --base "$BASE" \
    --project "$PROJECT" --role "$ROLE" --label "$LABEL" --cwd "$CWD" \
    >/dev/null
fi

echo "$CHILD_ID"
