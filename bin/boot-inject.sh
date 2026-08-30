#!/usr/bin/env bash
# Deferred boot-prompt inject + bounded confirmation for a spawned panel.

set -uo pipefail

CHILD=""
BOOT_FILE=""
PARENT=""
BASE="http://127.0.0.1:3100"
PROJECT=""
ROLE=""
LABEL=""
CWD=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --child)   CHILD="$2"; shift 2 ;;
    --boot)    BOOT_FILE="$2"; shift 2 ;;
    --parent)  PARENT="$2"; shift 2 ;;
    --base)    BASE="$2"; shift 2 ;;
    --project) PROJECT="$2"; shift 2 ;;
    --role)    ROLE="$2"; shift 2 ;;
    --label)   LABEL="$2"; shift 2 ;;
    --cwd)     CWD="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,38p' "$0"
      exit 0 ;;
    *)
      echo "boot-inject: unknown arg '$1'" >&2
      exit 1 ;;
  esac
done

for var in CHILD BOOT_FILE PARENT; do
  if [[ -z "${!var}" ]]; then
    echo "boot-inject: missing --${var,,}" >&2
    exit 1
  fi
done
[[ -r "$BOOT_FILE" ]] || { echo "boot-inject: boot file unreadable: $BOOT_FILE" >&2; exit 1; }

if [[ -n "$LABEL" && "${LABEL^^}" != *-ORCH ]]; then
  BOOT_TEXT_PRECHECK=$(<"$BOOT_FILE")
  if ! grep -Eiq '(td-inject\.sh|notify[- ]?back|Do not wait to be polled|dispatcher-session-id)' <<< "$BOOT_TEXT_PRECHECK"; then
    echo "boot-inject: REFUSING task boot without notify-back instruction: $BOOT_FILE" >&2
    exit 1
  fi
  if ! grep -Eiq '(ORCH-RESULT|SUMMARY|compact[- ]?(lane )?result|compact artifact)' <<< "$BOOT_TEXT_PRECHECK"; then
    echo "boot-inject: REFUSING task boot without compact result artifact contract: $BOOT_FILE" >&2
    exit 1
  fi
fi

TOKEN=$(grep -E '^[[:space:]]*token:' "$HOME/.termdeck/config.yaml" 2>/dev/null | head -1 | awk '{print $2}' || true)
if [[ -z "$TOKEN" ]]; then
  echo "boot-inject: no auth token in ~/.termdeck/config.yaml" >&2
  exit 1
fi

finite_int() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

MAX_ATTEMPTS="${MISER_BOOT_INJECT_MAX_ATTEMPTS:-2}"
finite_int "$MAX_ATTEMPTS" || MAX_ATTEMPTS=2
(( MAX_ATTEMPTS < 1 )) && MAX_ATTEMPTS=1
(( MAX_ATTEMPTS > 2 )) && MAX_ATTEMPTS=2

WAIT_S="${MISER_BOOT_INJECT_WAIT_S:-20}"
POLL_COUNT="${MISER_BOOT_INJECT_POLL_COUNT:-10}"
finite_int "$POLL_COUNT" || POLL_COUNT=10
(( POLL_COUNT < 1 )) && POLL_COUNT=1
POLL_SLEEP_S="${MISER_BOOT_INJECT_POLL_SLEEP_S:-1.5}"

BIN_DIR="${MISER_BIN_DIR:-$HOME/bin}"
PORT="${BASE##*:}"
PORT="${PORT%%/*}"
BOOT_BODY=$(cat "$BOOT_FILE")
ARTIFACT_DIR="${MISER_SPAWN_FAILURE_DIR:-$HOME/.miser/spawn-failures}"
SAFE_CHILD="${CHILD//[^A-Za-z0-9_.-]/_}"
FAILURE_ARTIFACT="$ARTIFACT_DIR/boot-inject-${SAFE_CHILD}.md"

manual_recovery_command() {
  local td_q child_q boot_q port_q
  printf -v td_q '%q' "$BIN_DIR/td-inject.sh"
  printf -v child_q '%q' "$CHILD"
  printf -v boot_q '%q' "$BOOT_FILE"
  printf -v port_q '%q' "$PORT"
  printf '%s %s "$(cat %s)" %s' "$td_q" "$child_q" "$boot_q" "$port_q"
}

write_failure_artifact() {
  local attempts="$1"
  local last_error="$2"
  local last_status="$3"
  local manual
  manual="$(manual_recovery_command)"
  mkdir -p "$ARTIFACT_DIR"
  {
    echo "# boot-inject failure"
    echo
    echo "verdict: FAILED"
    echo "child_session_id: $CHILD"
    echo "label: ${LABEL:-unknown}"
    echo "project: ${PROJECT:-unknown}"
    echo "cwd: ${CWD:-unknown}"
    echo "parent_session_id: $PARENT"
    echo "boot_file: $BOOT_FILE"
    echo "attempts: $attempts"
    echo "last_status: ${last_status:-unknown}"
    echo "last_error: ${last_error:-unknown}"
    echo
    echo "manual_recovery_command:"
    echo "$manual"
  } > "$FAILURE_ARTIFACT"
  echo "[boot-inject] failure artifact: $FAILURE_ARTIFACT" >&2
}

get_status() {
  curl -s -m 5 -H "Authorization: Bearer $TOKEN" "$BASE/api/sessions/$CHILD" 2>/dev/null \
    | python3 -c "import sys,json
try:
    print(json.load(sys.stdin).get('meta',{}).get('status',''))
except Exception:
    print('')" 2>/dev/null
}

LANDED=0
INJECT_SENT=0
ATTEMPTS_USED=0
LAST_ERROR=""
LAST_STATUS=""

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  ATTEMPTS_USED="$attempt"
  if [[ "$INJECT_SENT" == "0" ]]; then
    echo "[boot-inject] attempt $attempt/$MAX_ATTEMPTS: waiting ${WAIT_S}s then injecting..." >&2
    sleep "$WAIT_S"
    if "$BIN_DIR/td-inject.sh" "$CHILD" "$BOOT_BODY" "$PORT" >&2; then
      INJECT_SENT=1
      LAST_ERROR="boot text posted; waiting for activity confirmation"
    else
      LAST_ERROR="td-inject failed on attempt $attempt"
      echo "[boot-inject] $LAST_ERROR" >&2
      continue
    fi
  else
    echo "[boot-inject] boot text was already posted; not injecting a duplicate prompt" >&2
  fi

  for _ in $(seq 1 "$POLL_COUNT"); do
    sleep "$POLL_SLEEP_S"
    LAST_STATUS="$(get_status)"
    if [[ "$LAST_STATUS" == "thinking" ]]; then
      LANDED=1
      break
    fi
  done

  if [[ "$LANDED" == "1" ]]; then
    echo "[boot-inject] boot prompt confirmed landed (attempt $attempt, status==thinking)" >&2
    break
  fi

  if [[ "$INJECT_SENT" == "1" ]]; then
    LAST_ERROR="boot posted but activity was not confirmed"
    echo "[boot-inject] $LAST_ERROR; refusing duplicate boot injection" >&2
    break
  fi
done

if [[ "$LANDED" != "1" ]]; then
  write_failure_artifact "$ATTEMPTS_USED" "$LAST_ERROR" "$LAST_STATUS"
  echo "[boot-inject] ERROR: boot prompt for $CHILD not confirmed after $ATTEMPTS_USED attempt(s)" >&2
  exit 1
fi

if [[ "$PROJECT" == "pkachu" && ( "$ROLE" == "orchestrator" || "$LABEL" == *ORCH* ) ]]; then
  mkdir -p "$HOME/.tg"
  printf '%s\n' "$CHILD" > "$HOME/.tg/orch-session.id"
  echo "[boot-inject] pkachu orch link auto-updated (post-landed): ~/.tg/orch-session.id -> $CHILD" >&2
fi

if [[ -n "$CWD" ]]; then
  TRANSCRIPT_DIR="$HOME/.claude/projects/$(printf '%s' "$CWD" | tr '/.' '--')"
  MODEL_ERR=""
  for _ in 1 2 3 4 5 6 7 8; do
    sleep 2
    NEWEST=$(ls -t "$TRANSCRIPT_DIR"/*.jsonl 2>/dev/null | head -1) || true
    if [[ -n "$NEWEST" ]] && grep -q "issue with the selected model" "$NEWEST" 2>/dev/null; then
      MODEL_ERR=$(grep -o "issue with the selected model ([^)]*)" "$NEWEST" | tail -1)
      break
    fi
  done
  if [[ -n "$MODEL_ERR" ]]; then
    echo "[boot-inject] ERROR: panel $CHILD is BRICKED - $MODEL_ERR" >&2
    echo "[boot-inject]   Reap: curl -X DELETE -H \"Authorization: Bearer \$TOKEN\" $BASE/api/sessions/$CHILD" >&2
    exit 1
  fi
fi

echo "$CHILD"
