#!/usr/bin/env bash
#
# QA smoke test for BE-DOC-2 (generation reads phase-run attachments).
#
# Verifies that a file attached to a run is folded into the generation call:
# a text attachment carrying a distinctive marker is uploaded, then the run is
# generated and the resulting output is checked for evidence the model saw it.
#
# The real generate call spends Claude tokens, so it runs only when the backend
# has ANTHROPIC_API_KEY set (otherwise generate returns 503 and the step is
# skipped). The attach step is always exercised.
#
# Usage (run on the Pi, repo root, backend running):
#   bash qa/smoke-doc2.sh
#   BASE=http://192.168.1.13:4000 bash qa/smoke-doc2.sh
#
# Seeds super@ -> SUPER_ADMIN, owner@ -> PROJECT_OWNER via qa/seed-roles.sql.
set -uo pipefail

BASE="${BASE:-http://localhost:4000}"
PASSWORD="${PASSWORD:-changeme123}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$SCRIPT_DIR/..}"
SEED_SQL="$SCRIPT_DIR/seed-roles.sql"
SEED_MODE="${SEED_MODE:-auto}"
COMPOSE_SVC="${COMPOSE_SVC:-backend}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

if [ -z "${DATABASE_URL:-}" ] && [ -f "$REPO_DIR/.env" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$REPO_DIR/.env" | head -1 | cut -d= -f2-)"
fi
if [ "$SEED_MODE" = "auto" ]; then
  if command -v docker >/dev/null 2>&1; then SEED_MODE="docker"; else SEED_MODE="host"; fi
fi

PASS=0; FAIL=0
RESP_BODY=""; RESP_CODE=""
ok()  { echo "  ✅ PASS — $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ FAIL — $1"; FAIL=$((FAIL+1)); }
jget() { printf '%s' "$RESP_BODY" | python3 -c "import sys,json;print(json.load(sys.stdin)$1)" 2>/dev/null; }

req() {
  local method=$1 path=$2 token=$3 body=${4:-}
  local args=(-s -w $'\n%{http_code}' -X "$method" "$BASE$path" -H 'Content-Type: application/json')
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-d "$body")
  local out; out=$(curl "${args[@]}")
  RESP_CODE=$(printf '%s' "$out" | tail -n1); RESP_BODY=$(printf '%s' "$out" | sed '$d')
}
upload() {
  local path=$1 token=$2; shift 2
  local args=(-s -w $'\n%{http_code}' -X POST "$BASE$path" -H "Authorization: Bearer $token")
  for f in "$@"; do args+=(-F "files=@$f"); done
  local out; out=$(curl "${args[@]}")
  RESP_CODE=$(printf '%s' "$out" | tail -n1); RESP_BODY=$(printf '%s' "$out" | sed '$d')
}
auth_token() {
  local email=$1
  req POST /api/auth/register "" "{\"name\":\"${email%%@*}\",\"email\":\"$email\",\"password\":\"$PASSWORD\"}" >/dev/null 2>&1
  req POST /api/auth/login "" "{\"email\":\"$email\",\"password\":\"$PASSWORD\"}"
  jget "['token']"
}

echo "QA smoke — BE-DOC-2 generation-with-attachments @ ${BASE}"
echo "------------------------------------------------------------"

for e in super@codedebear.com owner@codedebear.com; do auth_token "$e" >/dev/null; done
if [ "$SEED_MODE" = "docker" ]; then
  docker compose exec -T "$COMPOSE_SVC" sh -lc "npx prisma db execute --stdin --schema prisma/schema.prisma" < "$SEED_SQL" >/dev/null 2>&1
else
  ( cd "$REPO_DIR/backend" && DATABASE_URL="$DATABASE_URL" npx prisma db execute --file "$SEED_SQL" --schema prisma/schema.prisma ) >/dev/null 2>&1
fi
SUPER="$(auth_token super@codedebear.com)"
OWNER="$(auth_token owner@codedebear.com)"

req POST /api/projects "$OWNER" '{"name":"DOC2 Smoke","track":"QA_ONLY"}'
PID="$(jget "['id']")"
req POST "/api/projects/$PID/phases" "$SUPER" '{"phaseType":"PLANNER","input":"Use the attached spec."}'
EXEC="$(jget "['id']")"
[ -n "$EXEC" ] && ok "started PLANNER run" || bad "could not start run"

# Distinctive marker the generated plan should echo if the file was read.
MARKER="ZephyrLedger"
printf 'SRS for project %s: build a REST API to manage an inventory called the %s system, with CRUD endpoints for items.' "$MARKER" "$MARKER" > "$TMP/spec.txt"

upload "/api/phases/$EXEC/attachments" "$SUPER" "$TMP/spec.txt"
[ "$RESP_CODE" = "201" ] && ok "attach spec.txt -> 201" || bad "attach -> $RESP_CODE (expected 201)"

# Generate (real Claude call). Skips cleanly if the key is not configured.
req POST "/api/phases/$EXEC/generate" "$SUPER"
if [ "$RESP_CODE" = "503" ]; then
  echo "  ⏭️  SKIP — generate returned 503 (no ANTHROPIC_API_KEY on this host); attach path verified"
elif [ "$RESP_CODE" = "200" ]; then
  ok "generate with attachment -> 200"
  [ "$(jget "['status']")" = "AWAITING_REVIEW" ] && ok "run -> AWAITING_REVIEW" || bad "status = $(jget "['status']")"
  OUT="$(jget "['output']")"
  [ -n "$OUT" ] && ok "run has generated output" || bad "output empty"
  IN_TOK="$(jget "['inputTokens']")"
  [ -n "$IN_TOK" ] && [ "$IN_TOK" != "None" ] && ok "input tokens recorded ($IN_TOK)" || bad "no input token count"
  # Soft evidence the attachment was read: the plan echoes the marker. Model
  # wording varies, so this is informational, not a hard failure.
  if printf '%s' "$OUT" | grep -qi "$MARKER"; then
    ok "output references the attached marker ($MARKER) — file was read"
  else
    echo "  ℹ️  INFO — marker not echoed verbatim; inspect output manually to confirm the file was used"
  fi
else
  bad "generate -> $RESP_CODE (expected 200 or 503)"
fi

echo "------------------------------------------------------------"
echo "Total: $((PASS+FAIL))  |  Passed: ${PASS}  |  Failed: ${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
