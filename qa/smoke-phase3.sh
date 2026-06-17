#!/usr/bin/env bash
#
# QA smoke test for VDT Platform Dev Sub-phase 3 (AI Generation).
# Verifies the /generate endpoint end-to-end against a running backend that has
# a real ANTHROPIC_API_KEY configured. Makes exactly ONE real Claude call (the
# happy path); all other checks are guard checks that cost no tokens.
#
# Usage (Pi has the API key in .env; run from repo root, backend running):
#   bash qa/smoke-phase3.sh
#   BASE=http://192.168.1.13:4000 bash qa/smoke-phase3.sh
#
# Reuses the role users seeded by smoke-phase2.5.sh; it re-registers + re-seeds
# the ones it needs so it can also run standalone.
#
set -uo pipefail

BASE="${BASE:-http://localhost:4000}"
PASSWORD="${PASSWORD:-changeme123}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$SCRIPT_DIR/..}"
SEED_SQL="$SCRIPT_DIR/seed-roles.sql"
SEED_MODE="${SEED_MODE:-auto}"
COMPOSE_SVC="${COMPOSE_SVC:-backend}"
if [ -z "${DATABASE_URL:-}" ] && [ -f "$REPO_DIR/.env" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$REPO_DIR/.env" | head -1 | cut -d= -f2-)"
fi
if [ "$SEED_MODE" = "auto" ]; then
  if command -v docker >/dev/null 2>&1; then SEED_MODE="docker"; else SEED_MODE="host"; fi
fi

PASS=0
FAIL=0
RESP_BODY=""
RESP_CODE=""

jget() { printf '%s' "$RESP_BODY" | python3 -c "import sys,json;print(json.load(sys.stdin)$1)" 2>/dev/null; }

req() {
  local method=$1 path=$2 token=$3 body=${4:-}
  local args=(-s -w $'\n%{http_code}' -X "$method" "$BASE$path" -H 'Content-Type: application/json')
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-d "$body")
  local out; out=$(curl "${args[@]}")
  RESP_CODE=$(printf '%s' "$out" | tail -n1)
  RESP_BODY=$(printf '%s' "$out" | sed '$d')
}

check() {
  if [ "$2" = "$3" ]; then
    printf 'PASS  %-46s (%s)\n' "$1" "$3"; PASS=$((PASS + 1))
  else
    printf 'FAIL  %-46s (expected %s, got %s)\n' "$1" "$2" "$3"
    printf '      body: %s\n' "$RESP_BODY"; FAIL=$((FAIL + 1))
  fi
}

register() { req POST /api/auth/register "" "{\"email\":\"$1\",\"password\":\"$PASSWORD\",\"name\":\"$2\"}"; }
login()    { req POST /api/auth/login "" "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}"; jget "['token']"; }

echo "== VDT Platform QA — Sub-phase 3 (AI Generation) =="
echo "Base URL: $BASE"
echo

# --- users + roles (idempotent) ---
register owner@codedebear.com "Owner One"
register ba@codedebear.com    "Business Analyst"
register op@codedebear.com    "Operations"
if [ "$SEED_MODE" = "docker" ]; then
  ( cd "$REPO_DIR" && docker compose exec -T "$COMPOSE_SVC" \
      npx prisma db execute --stdin --schema prisma/schema.prisma < "$SEED_SQL" ) \
      && echo "roles seeded (docker)" || { echo "FAIL seeding (docker)"; exit 1; }
else
  [ -z "${DATABASE_URL:-}" ] && { echo "FAIL host seed needs DATABASE_URL"; exit 1; }
  ( cd "$REPO_DIR/backend" && npx prisma db execute --stdin --url "$DATABASE_URL" < "$SEED_SQL" ) \
      && echo "roles seeded (host)" || { echo "FAIL seeding (host)"; exit 1; }
fi
echo

T_OWNER=$(login owner@codedebear.com)
T_BA=$(login ba@codedebear.com)
T_OP=$(login op@codedebear.com)
for t in "$T_OWNER" "$T_BA" "$T_OP"; do [ -z "$t" ] && { echo "login failed"; exit 1; }; done

# --- set up a PLANNER run to generate ---
req POST /api/projects "$T_OWNER" '{"name":"AI Gen Smoke","description":"smoke test project","track":"FULL_SDLC"}'
check "owner creates project" 201 "$RESP_CODE"
PID=$(jget "['id']")

req POST "/api/projects/$PID/phases" "$T_BA" '{"phaseType":"PLANNER","input":"Build a simple TODO REST API with CRUD endpoints."}'
check "BA starts PLANNER run" 201 "$RESP_CODE"
EXEC=$(jget "['id']")

echo
echo "-- guard checks (no Claude call) --"
req POST "/api/phases/00000000-0000-0000-0000-000000000000/generate" "$T_BA" ""
check "generate missing execution -> 404" 404 "$RESP_CODE"

req POST "/api/phases/$EXEC/generate" "$T_OP" ""
check "OPERATION cannot generate PLANNER -> 403" 403 "$RESP_CODE"

echo
echo "-- happy path: ONE real Claude generation --"
req POST "/api/phases/$EXEC/generate" "$T_BA" ""
check "BA generates PLANNER via Claude -> 200" 200 "$RESP_CODE"
check "  -> status AWAITING_REVIEW" "AWAITING_REVIEW" "$(jget "['status']")"
GEN_OUT="$(jget "['output']")"
if [ -n "$GEN_OUT" ] && [ "$GEN_OUT" != "None" ]; then
  printf 'PASS  %-46s (%s chars)\n' "  -> non-empty AI output" "${#GEN_OUT}"; PASS=$((PASS + 1))
else
  printf 'FAIL  %-46s (output was empty)\n' "  -> non-empty AI output"; FAIL=$((FAIL + 1))
fi
# sub-phase 3.5: token accounting + generation counter persisted on the run
IN_TOK="$(jget "['inputTokens']")"
if [ -n "$IN_TOK" ] && [ "$IN_TOK" != "None" ] && [ "$IN_TOK" != "null" ]; then
  printf 'PASS  %-46s (in=%s out=%s)\n' "  -> token usage stored" "$IN_TOK" "$(jget "['outputTokens']")"; PASS=$((PASS + 1))
else
  printf 'FAIL  %-46s (inputTokens missing)\n' "  -> token usage stored"; FAIL=$((FAIL + 1))
fi
check "  -> generationCount == 1" "1" "$(jget "['generationCount']")"

echo
echo "-- status guard after approval (no Claude call) --"
req POST "/api/phases/$EXEC/review" "$T_OWNER" '{"action":"APPROVE"}'
check "owner approves generated PLANNER" 200 "$RESP_CODE"
req POST "/api/phases/$EXEC/generate" "$T_BA" ""
check "generate on APPROVED run -> 409" 409 "$RESP_CODE"

echo
echo "================ SUMMARY ================"
echo "PASSED: $PASS   FAILED: $FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL GREEN ✅" || echo "SOME TESTS FAILED ❌"
exit "$FAIL"
