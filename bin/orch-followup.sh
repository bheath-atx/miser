#!/usr/bin/env bash
# No-LLM operator status/recovery for ORCH-dispatched work.

set -euo pipefail

PROJECT_ALIAS=""
TEXT_PARTS=()
BASES=("${TERMDECK_ORCH_BASE:-http://127.0.0.1:3100}" "${TERMDECK_BUILDER_BASE:-http://127.0.0.1:3200}")
OUT_DIR="${MISER_PROMPT_OUT_DIR:-/tmp/miser-prompts}"
SINCE_DAYS="${MISER_ORCH_FOLLOWUP_SINCE_DAYS:-14}"
MAX_ARTIFACT_BYTES="${MISER_ORCH_FOLLOWUP_MAX_ARTIFACT_BYTES:-12000}"
BASES_OVERRIDDEN=0

usage() {
  cat <<'EOF'
Usage:
  orch-followup.sh <project> [status text...] [options]

Examples:
  orch-followup.sh aetheria "what happened with PR351"
  orch-followup.sh aetheria "recover PR351"

Options:
  --base <url>         TermDeck base to inspect; repeatable. Default: :3100 and :3200
  --out-dir <dir>      Report output directory (default: /tmp/miser-prompts)
  --since-days <days>  Lane artifact age window (default: 14)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      if [[ $BASES_OVERRIDDEN -eq 0 ]]; then
        BASES=()
        BASES_OVERRIDDEN=1
      fi
      BASES+=("$2")
      shift 2
      ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --since-days) SINCE_DAYS="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --*) echo "orch-followup: unknown arg '$1'" >&2; usage >&2; exit 1 ;;
    *)
      if [[ -z "$PROJECT_ALIAS" ]]; then
        PROJECT_ALIAS="$1"
      else
        TEXT_PARTS+=("$1")
      fi
      shift
      ;;
  esac
done

[[ -z "$PROJECT_ALIAS" ]] && { echo "orch-followup: missing <project>" >&2; usage >&2; exit 1; }
REQUEST_TEXT="${TEXT_PARTS[*]}"
if [[ -z "$REQUEST_TEXT" && ! -t 0 ]]; then
  REQUEST_TEXT="$(cat)"
fi
[[ -z "$REQUEST_TEXT" ]] && REQUEST_TEXT="status"

case "${PROJECT_ALIAS,,}" in
  aetheria|aetheria-concierge)
    PROJECT="Aetheria-Concierge"
    GH_REPO="bheath-atx/aetheria-phase1"
    LANE_ROOT="${AETHERIA_LANE_ROOT:-/tmp/aetheria-lanes}"
    PROJECT_ALIASES_REGEX='aetheria|aetheria-concierge'
    ;;
  pkachu)
    PROJECT="pkachu"
    GH_REPO="${PKACHU_GH_REPO:-}"
    LANE_ROOT="${PKACHU_LANE_ROOT:-/tmp/pkachu-lanes}"
    PROJECT_ALIASES_REGEX='pkachu'
    ;;
  miser|termdeck-updates)
    PROJECT="$PROJECT_ALIAS"
    GH_REPO="bheath-atx/miser"
    LANE_ROOT="${MISER_LANE_ROOT:-/tmp/miser-lanes}"
    PROJECT_ALIASES_REGEX='miser|termdeck-updates'
    ;;
  *)
    PROJECT="$PROJECT_ALIAS"
    GH_REPO=""
    LANE_ROOT="/tmp/${PROJECT_ALIAS}-lanes"
    PROJECT_ALIASES_REGEX="$(printf '%s' "$PROJECT_ALIAS" | sed 's/[][(){}.^$*+?|\\]/\\&/g')"
    ;;
esac

mkdir -p "$OUT_DIR"
SAFE_PROJECT=$(PROJECT="$PROJECT" python3 - <<'PY'
import os, re
print(re.sub(r'[^A-Za-z0-9_.-]+', '-', os.environ['PROJECT']).strip('-') or 'project')
PY
)
STAMP=$(date -u +"%Y%m%dT%H%M%SZ")
REPORT_FILE="$OUT_DIR/${SAFE_PROJECT}-${STAMP}-followup.md"

extract_pr_number() {
  REQUEST_TEXT="$REQUEST_TEXT" python3 - <<'PY'
import os, re
text = os.environ['REQUEST_TEXT']
for pattern in (r'(?:pull/|PR\s*#?|pr\s*#?)\s*(\d+)\b', r'\b#(\d+)\b'):
    match = re.search(pattern, text, flags=re.I)
    if match:
        print(match.group(1))
        raise SystemExit(0)
PY
}

PR_NUMBER="$(extract_pr_number || true)"
TOKEN=$(grep -E '^[[:space:]]*token:' "$HOME/.termdeck/config.yaml" 2>/dev/null | head -1 | awk '{print $2}' || true)

{
  printf '# ORCH Follow-Up\n\n'
  printf 'Project: `%s`\n\n' "$PROJECT"
  printf 'Request: `%s`\n\n' "$REQUEST_TEXT"

  if [[ -n "$PR_NUMBER" ]]; then
    printf '## Pull Request\n\n'
    if [[ -n "$GH_REPO" ]] && command -v gh >/dev/null 2>&1; then
      if PR_JSON=$(gh pr view "$PR_NUMBER" --repo "$GH_REPO" --json number,title,state,headRefName,headRefOid,baseRefName,mergeStateStatus,mergeable,isDraft,url,updatedAt 2>/dev/null); then
        PR_JSON="$PR_JSON" python3 - <<'PY'
import json, os
pr = json.loads(os.environ['PR_JSON'])
print(f"- PR #{pr.get('number')}: {pr.get('title')}")
print(f"- URL: {pr.get('url')}")
print(f"- State: {pr.get('state')}; mergeStateStatus: {pr.get('mergeStateStatus')}; mergeable: {pr.get('mergeable')}; draft: {pr.get('isDraft')}")
print(f"- Branch: {pr.get('headRefName')} -> {pr.get('baseRefName')}")
print(f"- Head: {pr.get('headRefOid')}")
PY
        BRANCH=$(PR_JSON="$PR_JSON" python3 - <<'PY'
import json, os
print(json.loads(os.environ['PR_JSON']).get('headRefName') or '')
PY
)
        HEAD=$(PR_JSON="$PR_JSON" python3 - <<'PY'
import json, os
print(json.loads(os.environ['PR_JSON']).get('headRefOid') or '')
PY
)
        if [[ -n "$BRANCH" ]] && RUNS_JSON=$(gh run list --repo "$GH_REPO" --branch "$BRANCH" --limit 5 --json databaseId,workflowName,status,conclusion,headSha,url,updatedAt 2>/dev/null); then
          printf '\nLatest matching CI:\n'
          RUNS_JSON="$RUNS_JSON" HEAD_SHA="$HEAD" python3 - <<'PY'
import json, os
runs = json.loads(os.environ['RUNS_JSON'])
head = os.environ.get('HEAD_SHA')
for run in runs:
    if head and run.get('headSha') != head:
        continue
    print(f"- {run.get('workflowName')} run {run.get('databaseId')}: status={run.get('status')} conclusion={run.get('conclusion') or ''} url={run.get('url')}")
    break
PY
        fi
      else
        printf -- '- gh could not read PR #%s in %s.\n' "$PR_NUMBER" "$GH_REPO"
      fi
    else
      printf -- '- No GitHub repo configured or gh unavailable.\n'
    fi
    printf '\n'
  fi

  printf '## TermDeck Sessions\n\n'
  if [[ -z "$TOKEN" ]]; then
    printf -- '- No TermDeck token found in `~/.termdeck/config.yaml`.\n\n'
  else
    for base in "${BASES[@]}"; do
      if SESSIONS_JSON=$(curl -sS -H "Authorization: Bearer $TOKEN" "$base/api/sessions" 2>/dev/null); then
        printf 'Base `%s`:\n' "$base"
        PROJECT_ALIASES_REGEX="$PROJECT_ALIASES_REGEX" SESSIONS_JSON="$SESSIONS_JSON" python3 - <<'PY'
import json, os, re
aliases = re.compile(os.environ['PROJECT_ALIASES_REGEX'], re.I)
try:
    sessions = json.loads(os.environ['SESSIONS_JSON'])
except Exception as exc:
    print(f"- invalid sessions JSON: {exc}")
    raise SystemExit(0)
rows = []
for s in sessions:
    meta = s.get('meta') or {}
    project = str(meta.get('project') or s.get('project') or '')
    label = str(meta.get('label') or s.get('label') or '')
    if not aliases.search(project) and not aliases.search(label):
        continue
    rows.append((s.get('id') or '', s.get('status') or meta.get('status') or '', label or '-', project or '-', s.get('command') or meta.get('command') or '-'))
for row in rows[:12]:
    print(f"- {row[0]} status={row[1]} label={row[2]} project={row[3]} command={row[4]}")
if not rows:
    print("- no matching sessions")
PY
      else
        printf 'Base `%s`:\n- sessions API unavailable\n' "$base"
      fi
      printf '\n'
    done
  fi

  printf '## Lane Artifacts\n\n'
  if [[ ! -d "$LANE_ROOT" ]]; then
    printf -- '- Lane root not found: `%s`\n' "$LANE_ROOT"
  else
    MATCHES_FILE=$(mktemp)
    CANDIDATES_FILE=$(mktemp)
    if [[ -n "$PR_NUMBER" ]]; then
      find "$LANE_ROOT" -maxdepth 5 -type f \( -name 'ORCH-RESULT.md' -o -name 'SUMMARY.md' -o -iname '*AUDIT*.md' -o -iname '*RESULT*.md' \) -mtime "-$SINCE_DAYS" 2>/dev/null \
        | while IFS= read -r file; do
            if grep -Eiq "(pull/${PR_NUMBER}|PR URL:.*${PR_NUMBER}|PR #${PR_NUMBER}|#${PR_NUMBER}\b|PR${PR_NUMBER}\b)" "$file"; then
              printf '%s\n' "$file"
            fi
          done > "$CANDIDATES_FILE"
      ARTIFACTS_FILE="$MATCHES_FILE" CANDIDATES_FILE="$CANDIDATES_FILE" python3 - <<'PY'
import os, sys

def rank(path):
    name = os.path.basename(path).lower()
    if name == 'orch-result.md':
        return (0, path)
    if name.startswith('grok-audit') and name.endswith('.md') and 'briefing' not in name:
        return (1, path)
    if name.startswith('codex-audit') and name.endswith('.md') and 'briefing' not in name:
        return (2, path)
    if name == 'summary.md':
        return (3, path)
    if 'briefing' in name:
        return (9, path)
    return (4, path)

with open(os.environ['CANDIDATES_FILE'], encoding='utf-8') as f:
    paths = sorted({line.strip() for line in f if line.strip()}, key=rank)
with open(os.environ['ARTIFACTS_FILE'], 'w', encoding='utf-8') as f:
    for path in paths:
        f.write(path + '\n')
PY
    else
      find "$LANE_ROOT" -maxdepth 5 -type f \( -name 'ORCH-RESULT.md' -o -name 'SUMMARY.md' -o -iname '*AUDIT*.md' -o -iname '*RESULT*.md' \) -mtime "-$SINCE_DAYS" 2>/dev/null \
        > "$CANDIDATES_FILE"
      ARTIFACTS_FILE="$MATCHES_FILE" CANDIDATES_FILE="$CANDIDATES_FILE" python3 - <<'PY'
import os, sys

def rank(path):
    name = os.path.basename(path).lower()
    if name == 'orch-result.md':
        return (0, path)
    if name.startswith('grok-audit') and name.endswith('.md') and 'briefing' not in name:
        return (1, path)
    if name.startswith('codex-audit') and name.endswith('.md') and 'briefing' not in name:
        return (2, path)
    if name == 'summary.md':
        return (3, path)
    if 'briefing' in name:
        return (9, path)
    return (4, path)

with open(os.environ['CANDIDATES_FILE'], encoding='utf-8') as f:
    paths = sorted({line.strip() for line in f if line.strip()}, key=rank)
with open(os.environ['ARTIFACTS_FILE'], 'w', encoding='utf-8') as f:
    for path in paths[:20]:
        f.write(path + '\n')
PY
    fi

    if [[ ! -s "$MATCHES_FILE" ]]; then
      printf -- '- No matching artifacts found under `%s` in the last %s days.\n' "$LANE_ROOT" "$SINCE_DAYS"
    else
      while IFS= read -r file; do
        printf -- '- `%s`\n' "$file"
      done < "$MATCHES_FILE"
      FIRST_ARTIFACT=$(head -1 "$MATCHES_FILE")
      printf '\n## First Matching Artifact Preview\n\n'
      printf 'Path: `%s`\n\n' "$FIRST_ARTIFACT"
      printf '```text\n'
      head -c "$MAX_ARTIFACT_BYTES" "$FIRST_ARTIFACT" || true
      printf '\n```\n'
    fi
    rm -f "$MATCHES_FILE" "$CANDIDATES_FILE"
  fi

  printf '\n## Recovery Guidance\n\n'
  printf -- '- This report used shell/GitHub/TermDeck APIs only; no ORCH turn was spent.\n'
  printf -- '- If an artifact above has the answer, use it directly instead of asking the ORCH.\n'
  printf -- '- If you must notify the ORCH, send one short final-result prompt with the artifact path and avoid repeating the same dispatch.\n'
} > "$REPORT_FILE"

cat "$REPORT_FILE"
echo "orch-followup: report=$REPORT_FILE" >&2
