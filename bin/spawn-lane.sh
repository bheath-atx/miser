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
ARTIFACT_DIR="${MISER_SPAWN_FAILURE_DIR:-$HOME/.miser/spawn-failures}"
STARTED_AT_UTC=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

label_has_segment_ci() {
  local term="${1,,}" lower="${LABEL,,}"
  [[ "$lower" =~ (^|[-_.[:space:]])${term}($|[-_.[:space:]]) ]]
}

label_has_orch_segment() {
  [[ "$LABEL" =~ (^|[-_.[:space:]])ORCH($|[-_.[:space:]]) ]]
}

label_has_non_orch_segment() {
  [[ "$LABEL" =~ (^|[-_.[:space:]])[Nn][Oo][Nn][-_.[:space:]]*ORCH($|[-_.[:space:]]) ]]
}

is_orch_lane() {
  case "${ROLE,,}" in
    orch|orchestrator) return 0 ;;
  esac
  label_has_orch_segment && ! label_has_non_orch_segment
}

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

if [[ $BASE_EXPLICIT -eq 0 ]] && is_orch_lane; then
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

if [[ -n "$BOOT_FILE" ]]; then
  BOOT_TEXT=$(<"$BOOT_FILE")
  if is_orch_lane; then
    if ! grep -Eiq '^[[:space:]]*(MISER_BOOT_SETUP|ORCH_BOOT|PANEL_BOOT)[[:space:]]*$' <<< "$BOOT_TEXT"; then
      echo "spawn-lane: REFUSING ORCH boot without MISER_BOOT_SETUP/PANEL_BOOT marker: $BOOT_FILE" >&2
      exit 1
    fi
  elif ! grep -Eiq '(td-inject\.sh|notify[- ]?back|Do not wait to be polled|dispatcher-session-id)' <<< "$BOOT_TEXT"; then
    echo "spawn-lane: REFUSING task boot without notify-back instruction: $BOOT_FILE" >&2
    exit 1
  elif ! grep -Eiq '(ORCH-RESULT|SUMMARY|compact[- ]?(lane )?result|compact artifact)' <<< "$BOOT_TEXT"; then
    echo "spawn-lane: REFUSING task boot without compact result artifact contract: $BOOT_FILE" >&2
    exit 1
  fi
fi

REASON_DEFAULT="spawned via spawn-lane.sh by parent $PARENT"
[[ -z "$REASON" ]] && REASON="$REASON_DEFAULT"
COMMAND_ARG="$COMMAND"

project_slug() {
  case "${PROJECT,,}" in
    aetheria|aetheria-concierge) printf '%s' "aetheria" ;;
    *) printf '%s' "${PROJECT,,}" ;;
  esac
}

panel_slug() {
  if is_orch_lane; then
    printf '%s' "orch"
  elif label_has_segment_ci "architect"; then
    printf '%s' "architect"
  elif label_has_segment_ci "sprints"; then
    printf '%s' "sprints"
  else
    printf '%s' ""
  fi
}

route_claude_command() {
  local slug panel project_base_url base_url base_q
  [[ "${MISER_ROUTE_CLAUDE:-1}" == "0" ]] && return 0
  [[ "$COMMAND" == claude || "$COMMAND" == claude\ * ]] || return 0
  [[ "$COMMAND" == *ANTHROPIC_BASE_URL=* || "$COMMAND" == *ANTHROPIC_API_URL=* ]] && return 0

  slug="$(project_slug)"
  panel="$(panel_slug)"
  project_base_url="${MISER_CLAUDE_BASE_URL:-http://127.0.0.1:20128}/p/$slug"
  if [[ -n "$panel" ]]; then
    base_url="${project_base_url}--$panel"
  else
    base_url="$project_base_url"
  fi
  stage_claude_project_settings "$project_base_url"
  printf -v base_q '%q' "$base_url"
  COMMAND="env ANTHROPIC_BASE_URL=$base_q ANTHROPIC_API_URL=$base_q $COMMAND"
  echo "spawn-lane: routing Claude command through Miser project '$slug${panel:+--$panel}'" >&2
}

stage_claude_project_settings() {
  local base_url="$1" settings_dir settings_file
  [[ "${MISER_STAGE_CLAUDE_SETTINGS:-1}" == "0" ]] && return 0
  settings_dir="$CWD/.claude"
  settings_file="$settings_dir/settings.local.json"
  mkdir -p "$settings_dir"
  SETTINGS_FILE="$settings_file" BASE_URL="$base_url" python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["SETTINGS_FILE"])
base = os.environ["BASE_URL"]
try:
    data = json.loads(path.read_text()) if path.exists() else {}
    if not isinstance(data, dict):
        data = {}
except Exception:
    data = {}
env = data.get("env")
if not isinstance(env, dict):
    env = {}
data["env"] = env
env["ANTHROPIC_BASE_URL"] = base
env["ANTHROPIC_API_URL"] = base
path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
PY
  echo "spawn-lane: staged Claude cwd route $settings_file -> $base_url" >&2
}

route_claude_command
if [[ -n "$MODEL" ]]; then
  printf -v MODEL_SHELL '%q' "$MODEL"
  COMMAND="$COMMAND --model $MODEL_SHELL"
fi

safe_fragment() {
  local value="$1"
  value="${value//[^A-Za-z0-9_.-]/_}"
  [[ -n "$value" ]] || value="unknown"
  printf '%s' "$value"
}

spawn_command() {
  local bin_q parent_q project_q label_q cwd_q base_q boot_q reason_q type_q command_q model_q role_q
  printf -v bin_q '%q' "${MISER_BIN_DIR:-$HOME/bin}/spawn-lane.sh"
  printf -v parent_q '%q' "$PARENT"
  printf -v project_q '%q' "$PROJECT"
  printf -v label_q '%q' "$LABEL"
  printf -v cwd_q '%q' "$CWD"
  printf -v base_q '%q' "$BASE"
  printf -v type_q '%q' "$TYPE"
  printf -v command_q '%q' "$COMMAND_ARG"
  printf '%s --parent %s --project %s --label %s --cwd %s --base %s --type %s --command %s' \
    "$bin_q" "$parent_q" "$project_q" "$label_q" "$cwd_q" "$base_q" "$type_q" "$command_q"
  if [[ "$ROLE" != "null" ]]; then
    printf -v role_q '%q' "$ROLE"
    printf ' --role %s' "$role_q"
  fi
  if [[ -n "$MODEL" ]]; then
    printf -v model_q '%q' "$MODEL"
    printf ' --model %s' "$model_q"
  fi
  if [[ -n "$BOOT_FILE" ]]; then
    printf -v boot_q '%q' "$BOOT_FILE"
    printf ' --boot %s' "$boot_q"
  fi
  if [[ "$NO_INJECT" == "1" ]]; then
    printf ' --no-inject'
  fi
  if [[ "$REASON" != "$REASON_DEFAULT" ]]; then
    printf -v reason_q '%q' "$REASON"
    printf ' --reason %s' "$reason_q"
  fi
}

write_spawn_failure_artifact() {
  local last_error="$1"
  local last_status="$2"
  local safe_project safe_label artifact manual
  safe_project="$(safe_fragment "$PROJECT")"
  safe_label="$(safe_fragment "$LABEL")"
  artifact="$ARTIFACT_DIR/spawn-lane-${safe_project}-${safe_label}.md"
  manual="$(spawn_command)"
  mkdir -p "$ARTIFACT_DIR"
  {
    echo "# spawn failure"
    echo
    echo "verdict: FAILED"
    echo "failure_type: spawn_post"
    echo "timestamp_utc: $STARTED_AT_UTC"
    echo "child_session_id: unknown"
    echo "label: ${LABEL:-unknown}"
    echo "project: ${PROJECT:-unknown}"
    echo "cwd: ${CWD:-unknown}"
    echo "parent_session_id: ${PARENT:-unknown}"
    echo "base_url: $BASE"
    echo "command: ${COMMAND_ARG:-unknown}"
    echo "boot_file: ${BOOT_FILE:-none}"
    echo "attempts: 1"
    echo "last_status: ${last_status:-unknown}"
    echo "last_error: ${last_error:-unknown}"
    echo
    echo "manual_recovery_command:"
    echo "$manual"
  } > "$artifact"
  echo "[spawn-lane] failure artifact: $artifact" >&2
}

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

SPAWN_STATUS=0
RESP=$(curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$BASE/api/sessions") || SPAWN_STATUS=$?

if [[ "$SPAWN_STATUS" != "0" ]]; then
  write_spawn_failure_artifact "spawn POST failed with curl status $SPAWN_STATUS" "curl_status_$SPAWN_STATUS"
  echo "spawn-lane: spawn POST failed - curl status $SPAWN_STATUS" >&2
  exit 1
fi

CHILD_ID=$(echo "$RESP" | python3 -c '
import sys, json
try:
    obj = json.loads(sys.stdin.read())
    sys.stdout.write(obj.get("id", ""))
except Exception:
    pass
')

if [[ -z "$CHILD_ID" ]]; then
  write_spawn_failure_artifact "spawn POST returned no child id" "missing_child_id"
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

if [[ "$PROJECT" == "pkachu" ]] && is_orch_lane && [[ -z "$BOOT_FILE" ]]; then
  mkdir -p "$HOME/.tg"
  printf '%s\n' "$CHILD_ID" > "$HOME/.tg/orch-session.id"
  echo "[spawn-lane] pkachu orch link auto-updated: ~/.tg/orch-session.id -> $CHILD_ID" >&2
fi

if [[ -n "$BOOT_FILE" && "$NO_INJECT" == "1" ]]; then
  echo "[spawn-lane] --no-inject set: boot file recorded but NOT injected. Caller must run boot-inject.sh separately." >&2
fi

if [[ -n "$BOOT_FILE" && "$NO_INJECT" != "1" ]]; then
  BIN_DIR="${MISER_BIN_DIR:-$HOME/bin}"
  BOOT_ERR=$(mktemp "${TMPDIR:-/tmp}/miser-boot-inject.XXXXXX")
  if ! "$BIN_DIR/boot-inject.sh" \
    --child "$CHILD_ID" --boot "$BOOT_FILE" --parent "$PARENT" --base "$BASE" \
    --project "$PROJECT" --role "$ROLE" --label "$LABEL" --cwd "$CWD" --command "$COMMAND_ARG" \
    >/dev/null 2> >(tee "$BOOT_ERR" >&2); then
    BOOT_ARTIFACT=$(awk -F': ' '/failure artifact:/ {print $2}' "$BOOT_ERR" | tail -1)
    rm -f "$BOOT_ERR"
    echo "[spawn-lane] child id: $CHILD_ID" >&2
    if [[ -n "$BOOT_ARTIFACT" ]]; then
      echo "[spawn-lane] failure artifact: $BOOT_ARTIFACT" >&2
    fi
    echo "$CHILD_ID"
    exit 1
  fi
  rm -f "$BOOT_ERR"
fi

echo "$CHILD_ID"
