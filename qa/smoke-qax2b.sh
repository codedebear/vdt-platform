#!/usr/bin/env bash
#
# QA smoke test for VDT Platform QAX-2B-1 (QA execution: step stage).
# Drives a QA run through scenario draft -> confirm -> step draft (+ feedback
# regen). Makes a few real Claude calls (scenarios, steps, feedback-regen) when
# the backend has an ANTHROPIC_API_KEY; without one those return 503 and the
# token-spending parts are skipped while the guard checks still run.
#
# Usage (from repo root, backend running):
#   bash qa/smoke-qax2b.sh
#   BASE=http://192.168.1.13:4000 bash qa/smoke-qax2b.sh
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
    printf 'PASS  %-52s (%s)\n' "$1" "$3"; PASS=$((PASS + 1))
  else
    printf 'FAIL  %-52s (expected %s, got %s)\n' "$1" "$2" "$3"
    printf '      body: %s\n' "$RESP_BODY"; FAIL=$((FAIL + 1))
  fi
}

register() { req POST /api/auth/register "" "{\"email\":\"$1\",\"password\":\"$PASSWORD\",\"name\":\"$2\"}"; }
login()    { req POST /api/auth/login "" "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}"; jget "['token']"; }

echo "== VDT Platform QA — QAX-2B-1 (QA execution: step stage) =="
echo "Base URL: $BASE"
echo

register owner@codedebear.com "Owner One"
register ba@codedebear.com    "Business Analyst"
register qa@codedebear.com    "QA Engineer"
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
T_QA=$(login qa@codedebear.com)
T_OP=$(login op@codedebear.com)
for t in "$T_OWNER" "$T_BA" "$T_QA" "$T_OP"; do [ -z "$t" ] && { echo "login failed"; exit 1; }; done

# --- QA_ONLY project: approve a manual PLANNER, then start QA ---
req POST /api/projects "$T_OWNER" '{"name":"QAX2B Smoke","description":"qa step smoke","track":"QA_ONLY"}'
check "owner creates QA_ONLY project" 201 "$RESP_CODE"
PID=$(jget "['id']")
req POST "/api/projects/$PID/phases" "$T_BA" '{"phaseType":"PLANNER","input":"Test scope."}'
EXEC_PLAN=$(jget "['id']")
req POST "/api/phases/$EXEC_PLAN/output" "$T_BA" '{"output":"Test Scope: orders API + portal login."}'
req POST "/api/phases/$EXEC_PLAN/review" "$T_OWNER" '{"action":"APPROVE"}'
check "PLANNER approved" 200 "$RESP_CODE"
req POST "/api/projects/$PID/phases" "$T_QA" '{"phaseType":"QA","input":"GET /api/orders returns list; portal login works."}'
check "QA starts QA run" 201 "$RESP_CODE"
EXEC_QA=$(jget "['id']")

echo
echo "-- guard: steps before scenarios are confirmed (no Claude call) --"
req POST "/api/phases/$EXEC_QA/qa/steps/generate" "$T_QA" ""
check "generate steps at SCENARIO_DRAFT -> 409" 409 "$RESP_CODE"

echo
echo "-- scenario stage (real Claude call; skipped if no key) --"
req POST "/api/phases/$EXEC_QA/qa/scenarios/generate" "$T_QA" ""
if [ "$RESP_CODE" = "503" ]; then
  echo "SKIP  scenario + step generation (ANTHROPIC_API_KEY not configured -> 503)"
else
  check "QA generates scenarios -> 200" 200 "$RESP_CODE"
  req POST "/api/phases/$EXEC_QA/qa/scenarios/confirm" "$T_QA" ""
  check "QA confirms scenarios -> 200" 200 "$RESP_CODE"
  check "  -> stage STEPS_DRAFT" "STEPS_DRAFT" "$(jget "['testRun']['stage']")"

  echo
  echo "-- step stage --"
  req POST "/api/phases/$EXEC_QA/qa/steps/generate" "$T_OP" ""
  check "OPERATION cannot generate steps -> 403" 403 "$RESP_CODE"

  req POST "/api/phases/$EXEC_QA/qa/steps/generate" "$T_QA" ""
  check "QA generates steps -> 200" 200 "$RESP_CODE"
  check "  -> still stage STEPS_DRAFT" "STEPS_DRAFT" "$(jget "['testRun']['stage']")"
  NSTEP="$(jget "['testRun']['scenarios'][0]['steps'].__len__()")"
  if [ -n "$NSTEP" ] && [ "$NSTEP" != "None" ] && [ "$NSTEP" -ge 1 ] 2>/dev/null; then
    printf 'PASS  %-52s (%s steps on scenario 1)\n' "  -> steps persisted on a scenario" "$NSTEP"; PASS=$((PASS + 1))
  else
    printf 'FAIL  %-52s (got %s)\n' "  -> steps persisted on a scenario" "$NSTEP"; FAIL=$((FAIL + 1))
  fi

  echo
  echo "-- step feedback-steered regeneration (review -> regen loop) --"
  req POST "/api/phases/$EXEC_QA/qa/steps/generate" "$T_QA" \
    '{"feedback":"Add a final step that verifies the HTTP status code is 200."}'
  check "QA regenerates steps with feedback -> 200" 200 "$RESP_CODE"
  check "  -> still stage STEPS_DRAFT" "STEPS_DRAFT" "$(jget "['testRun']['stage']")"
fi

echo
echo "================ SUMMARY ================"
echo "PASSED: $PASS   FAILED: $FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL GREEN ✅" || echo "SOME TESTS FAILED ❌"
exit "$FAIL"
