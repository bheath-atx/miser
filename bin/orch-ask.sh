#!/usr/bin/env bash
# Free-text operator request -> Codex-normalized ORCH dispatch -> TermDeck injection.

set -euo pipefail

PROJECT_ALIAS=""
TEXT_PARTS=()
SESSION=""
LABEL=""
BASE="${TERMDECK_BASE:-http://127.0.0.1:3100}"
OUT_DIR="${MISER_PROMPT_OUT_DIR:-/tmp/miser-prompts}"
DRY_RUN=0
MODEL="${MISER_ORCH_ASK_CODEX_MODEL:-}"

usage() {
  cat <<'EOF'
Usage:
  orch-ask.sh <project> [request text...] [options]
  echo "request text" | orch-ask.sh <project> [options]

Examples:
  orch-ask.sh aetheria "run grok on PR351; CI passed; builder result is /tmp/.../ORCH-RESULT.md"
  echo "start a Codex builder for the pkachu local Qwen/Gemma query option" | orch-ask.sh pkachu

Options:
  --session <id>   Inject into this TermDeck session id
  --label <text>   Narrow ORCH lookup by label substring (default per project)
  --base <url>     TermDeck base (default: http://127.0.0.1:3100)
  --out-dir <dir>  Prompt/facts output directory (default: /tmp/miser-prompts)
  --model <model>  Codex model override
  --dry-run        Generate normalized dispatch + prompt, but do not inject
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session) SESSION="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "orch-ask: unknown arg '$1'" >&2; usage >&2; exit 1 ;;
    *)
      if [[ -z "$PROJECT_ALIAS" ]]; then
        PROJECT_ALIAS="$1"
      else
        TEXT_PARTS+=("$1")
      fi
      shift ;;
  esac
done

[[ -z "$PROJECT_ALIAS" ]] && { echo "orch-ask: missing <project>" >&2; usage >&2; exit 1; }

REQUEST_TEXT="${TEXT_PARTS[*]}"
if [[ -z "$REQUEST_TEXT" && ! -t 0 ]]; then
  REQUEST_TEXT="$(cat)"
fi
[[ -z "$REQUEST_TEXT" ]] && { echo "orch-ask: missing request text" >&2; exit 1; }

case "${PROJECT_ALIAS,,}" in
  aetheria|aetheria-concierge)
    PROJECT="Aetheria-Concierge"
    DEFAULT_LABEL="ORCH"
    ;;
  pkachu)
    PROJECT="pkachu"
    DEFAULT_LABEL="ORCH"
    ;;
  miser|termdeck-updates|provenspec|nacho-money)
    PROJECT="$PROJECT_ALIAS"
    DEFAULT_LABEL="ORCH"
    ;;
  *)
    PROJECT="$PROJECT_ALIAS"
    DEFAULT_LABEL="ORCH"
    ;;
esac
[[ -z "$LABEL" ]] && LABEL="$DEFAULT_LABEL"

BIN_DIR="${MISER_BIN_DIR:-$HOME/bin}"
CODEX_BIN="${MISER_CODEX_BIN:-codex}"
ORCH_DISPATCH="${MISER_ORCH_DISPATCH:-$BIN_DIR/orch-dispatch.sh}"
[[ -x "$ORCH_DISPATCH" ]] || { echo "orch-ask: orch-dispatch.sh not executable under $BIN_DIR" >&2; exit 1; }

mkdir -p "$OUT_DIR"
SAFE_PROJECT=$(PROJECT="$PROJECT" python3 - <<'PY'
import os, re
print(re.sub(r'[^A-Za-z0-9_.-]+', '-', os.environ['PROJECT']).strip('-') or 'project')
PY
)
STAMP=$(date -u +"%Y%m%dT%H%M%SZ")
RAW_FILE="$OUT_DIR/${SAFE_PROJECT}-${STAMP}-operator-request.md"
CODEX_PROMPT_FILE="$OUT_DIR/${SAFE_PROJECT}-${STAMP}-codex-normalize-prompt.md"
NORMALIZED_FILE="$OUT_DIR/${SAFE_PROJECT}-${STAMP}-dispatch.json"
FACTS_FILE="$OUT_DIR/${SAFE_PROJECT}-${STAMP}-facts.md"

printf '%s\n' "$REQUEST_TEXT" > "$RAW_FILE"
cat > "$CODEX_PROMPT_FILE" <<EOF
You convert Brad's rough operator request into a compact ORCH dispatch JSON object.

Do not use tools. Do not inspect files. Do not browse. Do not add facts not present in the request.
If the request implies an audit of a PR, make task an explicit dispatch-audit task.
If the request implies a build, make task an explicit dispatch-builder task.
Keep facts short and operational. Preserve exact PR numbers, URLs, run IDs, paths, and stop conditions.

Return JSON only, no markdown:
{
  "task": "one concise imperative task for the ORCH",
  "pr": "optional PR number or URL, else empty string",
  "facts": ["compact fact 1", "compact fact 2"]
}

Project: ${PROJECT}

Operator request:
${REQUEST_TEXT}
EOF

CODEX_ARGS=(exec --ephemeral --skip-git-repo-check --ignore-rules --sandbox read-only --ask-for-approval never -C /tmp -o "$NORMALIZED_FILE")
[[ -n "$MODEL" ]] && CODEX_ARGS+=(--model "$MODEL")
CODEX_ARGS+=("$(<"$CODEX_PROMPT_FILE")")

if ! "$CODEX_BIN" "${CODEX_ARGS[@]}" >/dev/null; then
  echo "orch-ask: Codex normalization failed" >&2
  echo "orch-ask: raw request saved at $RAW_FILE" >&2
  exit 1
fi

PARSED=$(NORMALIZED_FILE="$NORMALIZED_FILE" FACTS_FILE="$FACTS_FILE" python3 - <<'PY'
import json, os, re, sys

path = os.environ['NORMALIZED_FILE']
text = open(path, encoding='utf-8').read().strip()
match = re.search(r'\{.*\}', text, flags=re.S)
if not match:
    print('ERROR\tCodex returned no JSON object')
    raise SystemExit(0)
try:
    obj = json.loads(match.group(0))
except Exception as exc:
    print(f'ERROR\tinvalid Codex JSON: {exc}')
    raise SystemExit(0)

task = str(obj.get('task') or '').strip()
pr = str(obj.get('pr') or '').strip()
facts = obj.get('facts') or []
if not task:
    print('ERROR\tCodex JSON missing task')
    raise SystemExit(0)
if not isinstance(facts, list):
    print('ERROR\tCodex JSON facts must be an array')
    raise SystemExit(0)

with open(os.environ['FACTS_FILE'], 'w', encoding='utf-8') as f:
    for fact in facts:
        fact = str(fact).strip()
        if fact:
            f.write(f'- {fact}\n')
    if not facts:
        f.write('- No extra facts supplied by Codex normalization.\n')

print('OK')
print(task)
print(pr)
PY
)

if [[ "$PARSED" != OK$'\n'* ]]; then
  echo "$PARSED" >&2
  echo "orch-ask: normalized output saved at $NORMALIZED_FILE" >&2
  exit 1
fi
TASK=$(sed -n '2p' <<<"$PARSED")
PR=$(sed -n '3p' <<<"$PARSED")

DISPATCH_ARGS=(--project "$PROJECT" --label "$LABEL" --task "$TASK" --facts "$FACTS_FILE" --base "$BASE" --out-dir "$OUT_DIR")
[[ -n "$PR" ]] && DISPATCH_ARGS+=(--pr "$PR")
[[ -n "$SESSION" ]] && DISPATCH_ARGS+=(--session "$SESSION")
[[ $DRY_RUN -eq 1 ]] && DISPATCH_ARGS+=(--dry-run)

echo "orch-ask: raw=$RAW_FILE" >&2
echo "orch-ask: normalized=$NORMALIZED_FILE" >&2
echo "orch-ask: facts=$FACTS_FILE" >&2
"$ORCH_DISPATCH" "${DISPATCH_ARGS[@]}"
