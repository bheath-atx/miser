#!/usr/bin/env bash
# Canonical two-stage bracketed-paste inject into a TermDeck panel.
#
# Usage:
#   td-inject.sh <session-id> <text> [port]

set -euo pipefail

SID="${1:?usage: td-inject.sh <session-id> <text> [port]}"
TEXT="${2:?usage: td-inject.sh <session-id> <text> [port]}"
PORT="${3:-3100}"
BASE="http://127.0.0.1:${PORT}"

TOKEN=$(grep -E '^[[:space:]]*token:' "$HOME/.termdeck/config.yaml" 2>/dev/null | head -1 | awk '{print $2}' || true)
[[ -z "$TOKEN" ]] && { echo "td-inject: no auth token in ~/.termdeck/config.yaml" >&2; exit 1; }

PASTE_BODY=$(python3 -c "
import json, sys
text = '\x1b[200~' + sys.argv[1] + '\x1b[201~'
print(json.dumps({'text': text, 'source': 'td-inject.sh'}))
" "$TEXT")

if ! curl -sf -m 45 -X POST \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     "$BASE/api/sessions/$SID/input" \
     -d "$PASTE_BODY" > /dev/null; then
  echo "td-inject: paste POST failed (sid=$SID)" >&2
  exit 1
fi

sleep 0.4

CR_BODY=$(python3 -c "import json; print(json.dumps({'text': '\r', 'source': 'td-inject.sh'}))")

if ! curl -sf -m 45 -X POST \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     "$BASE/api/sessions/$SID/input" \
     -d "$CR_BODY" > /dev/null; then
  echo "td-inject: submit POST failed (sid=$SID)" >&2
  exit 1
fi

sleep 0.3
curl -sf -m 45 -X POST \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     "$BASE/api/sessions/$SID/poke" \
     -d '{"methods":["cr-flood"]}' > /dev/null 2>&1 || true

exit 0
