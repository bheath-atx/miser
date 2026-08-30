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
COMMAND=""

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
    --command) COMMAND="$2"; shift 2 ;;
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
POLL_COUNT="${MISER_BOOT_INJECT_POLL_COUNT:-67}"
finite_int "$POLL_COUNT" || POLL_COUNT=67
(( POLL_COUNT < 1 )) && POLL_COUNT=1
POLL_SLEEP_S="${MISER_BOOT_INJECT_POLL_SLEEP_S:-1.5}"

BIN_DIR="${MISER_BIN_DIR:-$HOME/bin}"
PORT="${BASE##*:}"
PORT="${PORT%%/*}"
BOOT_BODY=$(cat "$BOOT_FILE")
ARTIFACT_DIR="${MISER_SPAWN_FAILURE_DIR:-$HOME/.miser/spawn-failures}"
SAFE_CHILD="${CHILD//[^A-Za-z0-9_.-]/_}"
BOOT_FAILURE_ARTIFACT="$ARTIFACT_DIR/boot-unconfirmed-${SAFE_CHILD}.md"
MODEL_BRICK_ARTIFACT="$ARTIFACT_DIR/model-brick-${SAFE_CHILD}.md"
STARTED_AT_UTC=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
INJECTED_AT_EPOCH=""
CONFIRMED_BY=""
LAST_STATUS_DETAIL=""
LAST_ACTIVITY=""
LAST_REQUEST_COUNT=""
LAST_REPLY_COUNT=""
LAST_BUFFER_STATUS=""
LAST_BUFFER_DETAIL=""
LAST_INPUT_BUFFER_LENGTH=""
LAST_INPUT_BUFFER_PREVIEW=""
LAST_CODEX_TRANSCRIPT=""
CODEX_SNAPSHOT_FILE=""
CODEX_SNAPSHOT_EPOCH=""

is_codex_command() {
  local lower="${COMMAND,,}"
  [[ "$lower" =~ (^|[[:space:]/])codex($|[[:space:]]) ]]
}

if is_codex_command; then
  BOOT_BODY="Read $BOOT_FILE and execute it. Do not wait to be polled; follow its notify-back and compact artifact instructions."
fi

cleanup() {
  [[ -n "$CODEX_SNAPSHOT_FILE" ]] && rm -f "$CODEX_SNAPSHOT_FILE"
}
trap cleanup EXIT

td_inject_command() {
  local td_q child_q boot_q port_q body_q
  printf -v td_q '%q' "$BIN_DIR/td-inject.sh"
  printf -v child_q '%q' "$CHILD"
  printf -v boot_q '%q' "$BOOT_FILE"
  printf -v port_q '%q' "$PORT"
  if is_codex_command; then
    body_q="${BOOT_BODY//\\/\\\\}"
    body_q="${body_q//\"/\\\"}"
    body_q="${body_q//\$/\\\$}"
    body_q="${body_q//\`/\\\`}"
    body_q="\"$body_q\""
    printf '%s %s %s %s' "$td_q" "$child_q" "$body_q" "$port_q"
  else
    printf '%s %s "$(cat %s)" %s' "$td_q" "$child_q" "$boot_q" "$port_q"
  fi
}

inspect_command() {
  local base_q child_q
  printf -v base_q '%q' "$BASE"
  printf -v child_q '%q' "$CHILD"
  printf 'curl -sS -H "Authorization: Bearer $TOKEN" %s/api/sessions/%s' "$base_q" "$child_q"
}

buffer_inspect_command() {
  local base_q child_q
  printf -v base_q '%q' "$BASE"
  printf -v child_q '%q' "$CHILD"
  printf 'curl -sS -H "Authorization: Bearer $TOKEN" %s/api/sessions/%s/buffer' "$base_q" "$child_q"
}

sessions_list_command() {
  local base_q
  printf -v base_q '%q' "$BASE"
  printf 'curl -sS -H "Authorization: Bearer $TOKEN" %s/api/sessions' "$base_q"
}

capture_confirmation_signals() {
  local session_json buffer_json assignments
  session_json=$(curl -s -m 5 -H "Authorization: Bearer $TOKEN" "$BASE/api/sessions/$CHILD" 2>/dev/null || true)
  buffer_json=$(curl -s -m 5 -H "Authorization: Bearer $TOKEN" "$BASE/api/sessions/$CHILD/buffer" 2>/dev/null || true)
  assignments=$(SESSION_JSON="$session_json" BUFFER_JSON="$buffer_json" python3 - <<'PY'
import json, os, shlex

def load(name):
    raw = os.environ.get(name, '')
    if not raw:
        return {}
    try:
        obj = json.loads(raw)
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {"_parse_error": raw[:200]}

session = load("SESSION_JSON")
buffer = load("BUFFER_JSON")
meta = session.get("meta") if isinstance(session.get("meta"), dict) else {}

values = {
    "LAST_STATUS": meta.get("status") or session.get("status") or "",
    "LAST_STATUS_DETAIL": meta.get("statusDetail") or session.get("statusDetail") or "",
    "LAST_ACTIVITY": meta.get("lastActivity") or session.get("lastActivity") or "",
    "LAST_REQUEST_COUNT": meta.get("requestCount") if meta.get("requestCount") is not None else "",
    "LAST_REPLY_COUNT": meta.get("replyCount") if meta.get("replyCount") is not None else buffer.get("replyCount", ""),
    "LAST_BUFFER_STATUS": buffer.get("status") or "",
    "LAST_BUFFER_DETAIL": buffer.get("statusDetail") or "",
    "LAST_INPUT_BUFFER_LENGTH": buffer.get("inputBufferLength") if buffer.get("inputBufferLength") is not None else "",
    "LAST_INPUT_BUFFER_PREVIEW": buffer.get("inputBufferPreview") or "",
}
for key, value in values.items():
    print(f"{key}={shlex.quote(str(value))}")
PY
)
  eval "$assignments"
}

find_codex_transcript() {
  [[ -n "$CWD" && -n "$CODEX_SNAPSHOT_FILE" && -n "$CODEX_SNAPSHOT_EPOCH" ]] || return 0
  CWD="$CWD" CODEX_SNAPSHOT_FILE="$CODEX_SNAPSHOT_FILE" CODEX_SNAPSHOT_EPOCH="$CODEX_SNAPSHOT_EPOCH" python3 - <<'PY'
import datetime as dt
import json
import os
from pathlib import Path

cwd = os.environ["CWD"]
try:
    since = float(os.environ["CODEX_SNAPSHOT_EPOCH"])
except Exception:
    since = 0.0
snapshot_file = Path(os.environ["CODEX_SNAPSHOT_FILE"])
try:
    existing = set(snapshot_file.read_text(encoding="utf-8").splitlines())
except Exception:
    existing = set()

home = Path.home()
now = dt.datetime.now(dt.timezone.utc)
days = [now, now - dt.timedelta(days=1)]
candidates = []
for day in days:
    root = home / ".codex" / "sessions" / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}"
    if not root.is_dir():
        continue
    for path in root.glob("rollout-*.jsonl"):
        try:
            stat = path.stat()
        except OSError:
            continue
        key = f"{stat.st_dev}:{stat.st_ino}:{path}"
        if key in existing:
            continue
        birth = getattr(stat, "st_birthtime", 0) or 0
        created_or_modified = min(t for t in [birth, stat.st_mtime] if t > 0)
        if created_or_modified < since:
            continue
        try:
            first = path.open("r", encoding="utf-8", errors="replace").readline()
            obj = json.loads(first)
        except Exception:
            continue
        payload = obj.get("payload") if isinstance(obj.get("payload"), dict) else {}
        if payload.get("cwd") == cwd or obj.get("cwd") == cwd:
            candidates.append((created_or_modified, str(path)))

if candidates:
    candidates.sort(reverse=True)
    print(candidates[0][1])
PY
}

snapshot_codex_rollouts() {
  [[ -n "$CWD" ]] || return 0
  CODEX_SNAPSHOT_FILE=$(mktemp "${TMPDIR:-/tmp}/miser-codex-rollouts.XXXXXX")
  CODEX_SNAPSHOT_EPOCH=$(date +%s)
  CWD="$CWD" CODEX_SNAPSHOT_FILE="$CODEX_SNAPSHOT_FILE" python3 - <<'PY'
import datetime as dt
import json
import os
from pathlib import Path

cwd = os.environ["CWD"]
snapshot_file = Path(os.environ["CODEX_SNAPSHOT_FILE"])
home = Path.home()
now = dt.datetime.now(dt.timezone.utc)
days = [now, now - dt.timedelta(days=1)]
rows = []
for day in days:
    root = home / ".codex" / "sessions" / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}"
    if not root.is_dir():
        continue
    for path in root.glob("rollout-*.jsonl"):
        try:
            stat = path.stat()
        except OSError:
            continue
        try:
            first = path.open("r", encoding="utf-8", errors="replace").readline()
            obj = json.loads(first)
        except Exception:
            continue
        payload = obj.get("payload") if isinstance(obj.get("payload"), dict) else {}
        if payload.get("cwd") == cwd or obj.get("cwd") == cwd:
            rows.append(f"{stat.st_dev}:{stat.st_ino}:{path}")

snapshot_file.write_text("\n".join(rows) + ("\n" if rows else ""), encoding="utf-8")
PY
}

write_boot_failure_artifact() {
  local attempts="$1"
  local last_error="$2"
  local last_status="$3"
  local inspect buffer_inspect sessions_list reinject note
  inspect="$(inspect_command)"
  buffer_inspect="$(buffer_inspect_command)"
  sessions_list="$(sessions_list_command)"
  reinject="$(td_inject_command)"
  if [[ "$INJECT_SENT" == "1" ]]; then
    note="Inspect the panel manually first. Only re-inject if the boot input is visibly absent or truncated."
  else
    note="No successful boot post was observed. It is safe to retry injection after checking the panel exists."
  fi
  mkdir -p "$ARTIFACT_DIR"
  {
    echo "# boot confirmation failure"
    echo
    echo "verdict: FAILED"
    echo "failure_type: boot_unconfirmed"
    echo "timestamp_utc: $STARTED_AT_UTC"
    echo "child_session_id: $CHILD"
    echo "label: ${LABEL:-unknown}"
    echo "project: ${PROJECT:-unknown}"
    echo "cwd: ${CWD:-unknown}"
    echo "parent_session_id: $PARENT"
    echo "base_url: $BASE"
    echo "command: ${COMMAND:-unknown}"
    echo "boot_file: $BOOT_FILE"
    echo "attempts: $attempts"
    echo "last_status: ${last_status:-unknown}"
    echo "last_error: ${last_error:-unknown}"
    echo
    echo "observed_confirmation_signals:"
    echo "  confirmation_rule: $(is_codex_command && echo codex_transcript_created || echo termdeck_status_thinking)"
    echo "  confirmed_by: ${CONFIRMED_BY:-none}"
    echo "  termdeck_status: ${LAST_STATUS:-unknown}"
    echo "  termdeck_status_detail: ${LAST_STATUS_DETAIL:-unknown}"
    echo "  termdeck_last_activity: ${LAST_ACTIVITY:-unknown}"
    echo "  termdeck_request_count: ${LAST_REQUEST_COUNT:-unknown}"
    echo "  termdeck_reply_count: ${LAST_REPLY_COUNT:-unknown}"
    echo "  buffer_status: ${LAST_BUFFER_STATUS:-unknown}"
    echo "  buffer_status_detail: ${LAST_BUFFER_DETAIL:-unknown}"
    echo "  input_buffer_length: ${LAST_INPUT_BUFFER_LENGTH:-unknown}"
    echo "  input_buffer_preview: ${LAST_INPUT_BUFFER_PREVIEW:-}"
    echo "  codex_transcript_path: ${LAST_CODEX_TRANSCRIPT:-none}"
    echo
    echo "panel_lookup:"
    echo "Open $BASE in a browser and find project '${PROJECT:-unknown}', label '${LABEL:-unknown}', session '$CHILD'."
    echo "If the dashboard is hard to scan, run the sessions-list command below and search for '$CHILD' or '${LABEL:-unknown}'."
    echo
    echo "manual_recovery_note:"
    echo "$note"
    echo
    echo "manual_inspection_command:"
    echo "$inspect"
    echo
    echo "buffer_inspection_command:"
    echo "$buffer_inspect"
    echo
    echo "sessions_list_command:"
    echo "$sessions_list"
    echo
    echo "conditional_reinject_command:"
    echo "$reinject"
  } > "$BOOT_FAILURE_ARTIFACT"
  echo "[boot-inject] failure artifact: $BOOT_FAILURE_ARTIFACT" >&2
}

write_model_brick_artifact() {
  local model_error="$1"
  local reap
  printf -v reap 'curl -X DELETE -H "Authorization: Bearer $TOKEN" %q/api/sessions/%q' "$BASE" "$CHILD"
  mkdir -p "$ARTIFACT_DIR"
  {
    echo "# model brick failure"
    echo
    echo "verdict: FAILED"
    echo "failure_type: model_brick"
    echo "timestamp_utc: $STARTED_AT_UTC"
    echo "child_session_id: $CHILD"
    echo "label: ${LABEL:-unknown}"
    echo "project: ${PROJECT:-unknown}"
    echo "cwd: ${CWD:-unknown}"
    echo "parent_session_id: $PARENT"
    echo "base_url: $BASE"
    echo "command: ${COMMAND:-unknown}"
    echo "boot_file: $BOOT_FILE"
    echo "attempts: $ATTEMPTS_USED"
    echo "last_status: ${LAST_STATUS:-thinking}"
    echo "last_error: $model_error"
    echo
    echo "manual_recovery_command:"
    echo "$reap"
  } > "$MODEL_BRICK_ARTIFACT"
  echo "[boot-inject] failure artifact: $MODEL_BRICK_ARTIFACT" >&2
}

get_status() {
  capture_confirmation_signals
  printf '%s\n' "$LAST_STATUS"
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
    INJECTED_AT_EPOCH=$(date +%s)
    if is_codex_command; then
      snapshot_codex_rollouts
    fi
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
    capture_confirmation_signals
    LAST_CODEX_TRANSCRIPT=""
    if is_codex_command; then
      LAST_CODEX_TRANSCRIPT="$(find_codex_transcript)"
    fi
    if is_codex_command && [[ -n "$LAST_CODEX_TRANSCRIPT" ]]; then
      LANDED=1
      CONFIRMED_BY="codex_transcript_created"
      break
    fi
    if ! is_codex_command && [[ "$LAST_STATUS" == "thinking" ]]; then
      LANDED=1
      CONFIRMED_BY="termdeck_status_thinking"
      break
    fi
  done

  if [[ "$LANDED" == "1" ]]; then
    echo "[boot-inject] boot prompt confirmed landed (attempt $attempt, confirmed_by=$CONFIRMED_BY)" >&2
    break
  fi

  if [[ "$INJECT_SENT" == "1" ]]; then
    LAST_ERROR="boot posted but activity was not confirmed"
    echo "[boot-inject] $LAST_ERROR after extended confirmation wait; refusing duplicate boot injection" >&2
    break
  fi
done

if [[ "$LANDED" != "1" ]]; then
  write_boot_failure_artifact "$ATTEMPTS_USED" "$LAST_ERROR" "$LAST_STATUS"
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
    write_model_brick_artifact "$MODEL_ERR"
    echo "[boot-inject] ERROR: panel $CHILD is BRICKED - $MODEL_ERR" >&2
    echo "[boot-inject]   Reap: curl -X DELETE -H \"Authorization: Bearer \$TOKEN\" $BASE/api/sessions/$CHILD" >&2
    exit 1
  fi
fi

echo "$CHILD"
