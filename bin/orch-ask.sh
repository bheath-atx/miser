#!/usr/bin/env bash
# Free-text operator request -> Codex-normalized ORCH dispatch -> TermDeck injection.

set -euo pipefail

PROJECT_ALIAS=""
TEXT_PARTS=()
SESSION=""
LABEL=""
LABEL_EXPLICIT=0
BASE="${TERMDECK_BASE:-http://127.0.0.1:3100}"
OUT_DIR="${MISER_PROMPT_OUT_DIR:-/tmp/miser-prompts}"
DRY_RUN=0
MODEL="${MISER_ORCH_ASK_CODEX_MODEL:-}"
NO_ENRICH=0

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
  --no-enrich      Skip bounded local/GitHub fact enrichment
  --dry-run        Generate normalized dispatch + prompt, but do not inject
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session) SESSION="$2"; shift 2 ;;
    --label) LABEL="$2"; LABEL_EXPLICIT=1; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --no-enrich) NO_ENRICH=1; shift ;;
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
    GH_REPO="bheath-atx/aetheria-phase1"
    LANE_ROOT="${AETHERIA_LANE_ROOT:-/tmp/aetheria-lanes}"
    DEFAULT_LABEL=""
    ;;
  pkachu)
    PROJECT="pkachu"
    GH_REPO="${PKACHU_GH_REPO:-}"
    LANE_ROOT="${PKACHU_LANE_ROOT:-/tmp/pkachu-lanes}"
    DEFAULT_LABEL=""
    ;;
  miser|termdeck-updates|provenspec|nacho-money)
    PROJECT="$PROJECT_ALIAS"
    GH_REPO="$([[ "${PROJECT_ALIAS,,}" == "miser" ]] && printf 'bheath-atx/miser' || true)"
    LANE_ROOT="${MISER_LANE_ROOT:-/tmp/miser-lanes}"
    DEFAULT_LABEL=""
    ;;
  *)
    PROJECT="$PROJECT_ALIAS"
    GH_REPO=""
    LANE_ROOT="/tmp/${PROJECT_ALIAS}-lanes"
    DEFAULT_LABEL=""
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
ENRICH_FILE="$OUT_DIR/${SAFE_PROJECT}-${STAMP}-enriched-facts.md"

printf '%s\n' "$REQUEST_TEXT" > "$RAW_FILE"

extract_pr_number() {
  REQUEST_TEXT="$REQUEST_TEXT" python3 - <<'PY'
import os, re
text = os.environ['REQUEST_TEXT']
patterns = [
    r'(?:pull/|PR\s*#?|pr\s*#?)\s*(\d+)\b',
    r'\b#(\d+)\b',
]
for pattern in patterns:
    match = re.search(pattern, text, flags=re.I)
    if match:
        print(match.group(1))
        raise SystemExit(0)
PY
}

write_enriched_facts() {
  : > "$ENRICH_FILE"
  [[ $NO_ENRICH -eq 1 ]] && return 0

  local pr_number
  pr_number="$(extract_pr_number || true)"
  if [[ -n "$pr_number" ]]; then
    printf -- '- Detected PR #%s from operator request.\n' "$pr_number" >> "$ENRICH_FILE"
    if [[ -n "$GH_REPO" ]] && command -v gh >/dev/null 2>&1; then
      local pr_json
      if pr_json=$(gh pr view "$pr_number" --repo "$GH_REPO" --json number,title,state,headRefName,headRefOid,baseRefName,mergeStateStatus,mergeable,isDraft,url,updatedAt 2>/dev/null); then
        PR_JSON="$pr_json" python3 - <<'PY' >> "$ENRICH_FILE"
import json, os
pr = json.loads(os.environ['PR_JSON'])
print(f"- GitHub PR #{pr.get('number')}: {pr.get('title')} ({pr.get('url')})")
print(f"- PR state: {pr.get('state')}; mergeStateStatus: {pr.get('mergeStateStatus')}; mergeable: {pr.get('mergeable')}; draft: {pr.get('isDraft')}")
print(f"- PR branch: {pr.get('headRefName')} -> {pr.get('baseRefName')}; head: {pr.get('headRefOid')}")
PY
        local head branch runs
        head=$(PR_JSON="$pr_json" python3 - <<'PY'
import json, os
print(json.loads(os.environ['PR_JSON']).get('headRefOid') or '')
PY
)
        branch=$(PR_JSON="$pr_json" python3 - <<'PY'
import json, os
print(json.loads(os.environ['PR_JSON']).get('headRefName') or '')
PY
)
        if [[ -n "$branch" ]] && runs=$(gh run list --repo "$GH_REPO" --branch "$branch" --limit 3 --json databaseId,workflowName,status,conclusion,createdAt,updatedAt,headSha,url 2>/dev/null); then
          RUNS_JSON="$runs" HEAD_SHA="$head" python3 - <<'PY' >> "$ENRICH_FILE"
import json, os
runs = json.loads(os.environ['RUNS_JSON'])
head = os.environ.get('HEAD_SHA')
for run in runs:
    if head and run.get('headSha') != head:
        continue
    conclusion = run.get('conclusion') or ''
    print(f"- CI run {run.get('databaseId')} {run.get('workflowName')}: status={run.get('status')} conclusion={conclusion} url={run.get('url')}")
    break
PY
        fi
      fi
    fi

    if [[ -d "$LANE_ROOT" ]]; then
      local artifact artifacts_file
      artifacts_file=$(mktemp)
      find "$LANE_ROOT" -maxdepth 5 -type f \( -name 'ORCH-RESULT.md' -o -name 'SUMMARY.md' -o -iname '*AUDIT*.md' -o -iname '*RESULT*.md' \) -mtime -14 2>/dev/null \
        | while IFS= read -r file; do
            if grep -Eiq "(pull/${pr_number}|PR URL:.*${pr_number}|PR #${pr_number}|#${pr_number}\b)" "$file"; then
              printf '%s\n' "$file"
              dir=$(dirname "$file")
              find "$dir" -maxdepth 1 -type f \( -name 'ORCH-RESULT.md' -o -name 'SUMMARY.md' -o -iname '*AUDIT*.md' -o -iname '*RESULT*.md' \) 2>/dev/null
            fi
          done | sort -u > "$artifacts_file"
      artifact=$(grep -E '/ORCH-RESULT\.md$' "$artifacts_file" | head -1 || true)
      if [[ -z "$artifact" ]]; then
        artifact=$(head -1 "$artifacts_file" || true)
      fi
      if [[ -n "$artifact" ]]; then
        printf -- '- Matching compact lane artifact: %s\n' "$artifact" >> "$ENRICH_FILE"
      fi
      while IFS= read -r audit; do
        verdict=$(grep -Eim1 '(^|[[:space:]])VERDICT:[[:space:]]*' "$audit" 2>/dev/null || true)
        printf -- '- Matching audit artifact: %s%s\n' "$audit" "${verdict:+ (${verdict})}" >> "$ENRICH_FILE"
      done < <(grep -Ei '/[^/]*AUDIT[^/]*\.md$' "$artifacts_file" | grep -Evi 'briefing' | head -3 || true)
      rm -f "$artifacts_file"
    fi
  fi
}

write_enriched_facts

try_deterministic_normalize() {
  local pr_number
  pr_number="$(extract_pr_number || true)"
  [[ -n "$pr_number" ]] || return 1

  if REQUEST_TEXT="$REQUEST_TEXT" python3 - <<'PY'
import os, re, sys
text = os.environ['REQUEST_TEXT'].lower()
fix_like = re.search(r'\b(revise|fix|repair|address|implement|build|update|resolve)\b', text)
audit_like = re.search(r'\b(grok|audit|review)\b', text)
sys.exit(0 if audit_like and not fix_like else 1)
PY
  then
    PR_NUMBER="$pr_number" ENRICH_FILE="$ENRICH_FILE" NORMALIZED_FILE="$NORMALIZED_FILE" python3 - <<'PY'
import json, os

pr = os.environ['PR_NUMBER']
facts = []
enrich = os.environ['ENRICH_FILE']
if os.path.exists(enrich):
    with open(enrich, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line.startswith('- '):
                facts.append(line[2:])
facts.append('Do not poll CI; use supplied CI and artifact facts only.')
obj = {
    'task': f'Dispatch Grok audit for PR #{pr}',
    'pr': pr,
    'facts': facts,
}
with open(os.environ['NORMALIZED_FILE'], 'w', encoding='utf-8') as f:
    json.dump(obj, f)
    f.write('\n')
PY
    return 0
  fi

  if REQUEST_TEXT="$REQUEST_TEXT" python3 - <<'PY'
import os, re, sys
text = os.environ['REQUEST_TEXT'].lower()
fix_like = re.search(r'\b(revise|fix|repair|address|implement|build|update|resolve)\b', text)
blocker_like = re.search(r'\b(blocker|finding|revise|grok|audit)\b', text)
sys.exit(0 if fix_like and blocker_like else 1)
PY
  then
    PR_NUMBER="$pr_number" ENRICH_FILE="$ENRICH_FILE" NORMALIZED_FILE="$NORMALIZED_FILE" REQUEST_TEXT="$REQUEST_TEXT" python3 - <<'PY'
import json, os

pr = os.environ['PR_NUMBER']
request = os.environ['REQUEST_TEXT'].strip()
facts = []
enrich = os.environ['ENRICH_FILE']
if os.path.exists(enrich):
    with open(enrich, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line.startswith('- '):
                facts.append(line[2:])
facts.append(f'Operator requested revision/fix: {request}')
facts.append('Dispatch a bounded Codex builder; do not run another audit until the fix result is ready.')
facts.append('Do not poll CI; use supplied CI and artifact facts only.')
obj = {
    'task': f'Dispatch Codex builder to revise PR #{pr} for the specified audit blocker',
    'pr': pr,
    'facts': facts,
}
with open(os.environ['NORMALIZED_FILE'], 'w', encoding='utf-8') as f:
    json.dump(obj, f)
    f.write('\n')
PY
    return 0
  fi

  return 1
}

cat > "$CODEX_PROMPT_FILE" <<EOF
You convert Brad's rough operator request into a compact ORCH dispatch JSON object.

Do not use tools. Do not inspect files. Do not browse. Use only the operator request and bounded enriched facts below.
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

Bounded enriched facts:
$(<"$ENRICH_FILE")

Operator request:
${REQUEST_TEXT}
EOF

if try_deterministic_normalize; then
  echo "orch-ask: normalized without Codex for recognized PR request" >&2
else
  CODEX_ARGS=(exec --ephemeral --skip-git-repo-check --ignore-rules --sandbox read-only -C /tmp -o "$NORMALIZED_FILE")
  [[ -n "$MODEL" ]] && CODEX_ARGS+=(--model "$MODEL")
  CODEX_ARGS+=("$(<"$CODEX_PROMPT_FILE")")

  if ! "$CODEX_BIN" "${CODEX_ARGS[@]}" >/dev/null; then
    echo "orch-ask: Codex normalization failed" >&2
    echo "orch-ask: raw request saved at $RAW_FILE" >&2
    exit 1
  fi
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

DISPATCH_ARGS=(--project "$PROJECT" --task "$TASK" --facts "$FACTS_FILE" --base "$BASE" --out-dir "$OUT_DIR")
[[ $LABEL_EXPLICIT -eq 1 && -n "$LABEL" ]] && DISPATCH_ARGS+=(--label "$LABEL")
[[ -n "$PR" ]] && DISPATCH_ARGS+=(--pr "$PR")
[[ -n "$SESSION" ]] && DISPATCH_ARGS+=(--session "$SESSION")
[[ $DRY_RUN -eq 1 ]] && DISPATCH_ARGS+=(--dry-run)

echo "orch-ask: raw=$RAW_FILE" >&2
echo "orch-ask: enriched=$ENRICH_FILE" >&2
echo "orch-ask: normalized=$NORMALIZED_FILE" >&2
echo "orch-ask: facts=$FACTS_FILE" >&2
echo "orch-ask: task=$TASK" >&2
[[ -n "$PR" ]] && echo "orch-ask: pr=$PR" >&2
echo "orch-ask: followup=orch-followup.sh ${PROJECT_ALIAS} \"what happened${PR:+ with PR${PR}}\"" >&2
"$ORCH_DISPATCH" "${DISPATCH_ARGS[@]}"
