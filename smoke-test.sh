#!/usr/bin/env bash
# One-command smoke test: curl the deployed /api/health and report per-service status.
#
# Usage:
#   ./smoke-test.sh                                   # defaults to crmi-translator.netlify.app
#   ./smoke-test.sh https://crmi-translator.netlify.app
#   ./smoke-test.sh http://localhost:8888             # against `netlify dev`
#
# Exit code: 0 if healthy, 1 otherwise (usable in CI / pre-service checks).

set -uo pipefail

BASE="${1:-https://crmi-translator.netlify.app}"
BASE="${BASE%/}"
URL="$BASE/api/health"

echo "🔎 Smoke test → $URL"
echo

# Capture body + HTTP status separately. Do NOT use -f: /api/health returns 503
# when unhealthy, which is "reachable but failing", not "unreachable".
raw="$(curl -sS --max-time 30 -w $'\n%{http_code}' "$URL" 2>/dev/null)"
code=$?
http_status="${raw##*$'\n'}"
resp="${raw%$'\n'*}"

if [ $code -ne 0 ] || [ -z "$http_status" ]; then
  echo "❌ Could not reach $URL (curl exit $code). Is the site deployed?"
  exit 1
fi
echo "HTTP $http_status"
echo

healthy=1
if command -v jq >/dev/null 2>&1; then
  echo "$resp" | jq .
  [ "$(echo "$resp" | jq -r '.ok')" = "true" ] && healthy=0
  echo
  echo "$resp" | jq -r '
    .services // {} | to_entries[] |
    "  \(if .value.ok then "✅" else "❌" end) \(.key)  (HTTP \(.value.status))\(if .value.detail then "  — \(.value.detail)" else "" end)"'
else
  echo "$resp"
  echo "$resp" | grep -qE '"ok"[[:space:]]*:[[:space:]]*true' && healthy=0
fi

echo
if [ "$healthy" -eq 0 ]; then
  echo "✅ HEALTHY — all keys present and all providers reachable."
  exit 0
else
  echo "❌ UNHEALTHY — see details above (missing env var or a provider rejected the key)."
  exit 1
fi
