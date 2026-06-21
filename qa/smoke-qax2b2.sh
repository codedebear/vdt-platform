#!/usr/bin/env bash
#
# QA smoke test for VDT Platform QAX-2B-2 (QA execution: compile stage).
# Drives a run scenario -> steps -> COMPILE (artifactSpec) -> recompile(feedback)
# -> revise back. Makes several real Claude calls when the backend has an
# ANTHROPIC_API_KEY; without one they return 503 and the token-spending parts are
# skipped while guard checks still run.
#
# Usage (from repo root, backend running):
#   bash qa/smoke-qax2b2.sh
#   BASE=http://192.168.1.13:4000 bash qa/smoke-qax2b2.sh
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
    printf 'PASS  %-54s (%s)\n' "$1" "$3"; PASS=$((PASS + 1))
  else
    printf 'FAIL  %-54s (expected %s, got %s)\n' "$1" "$2" "$3"
    printf '      body: %s\n' "$RESP_BODY"; FAIL=$((FAIL + 1))
  fi
}

register() { req POST /api/auth/register "" "{\"email\":\"$1\",\"password\":\"$PASSWORD\",\"name\":\"$2\"}"; }
login()    { req POST /api/auth/login "" "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}"; jget "['token']"; }

echo "== VDT Platform QA — QAX-2B-2 (QA execution: compile stage) =="
echo "Base URL: $BASE"

# Wait for the backend to finish booting (entrypoint db push + express listen)
# before firing requests — avoids the register/login readiness race.
printf 'waiting for backend'
for _ in $(seq 1 30); do
  curl -sf "$BASE/health" >/dev/null 2>&1 && { echo " ready"; break; }
  printf '.'; sleep 2
done
echo

register owner@codedebear.com "Owner One"
register ba@codedebear.com    "Business Analyst"
register qa@codedebear.com    "QA Engineer"
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
for t in "$T_OWNER" "$T_BA" "$T_QA"; do [ -z "$t" ] && { echo "login failed"; exit 1; }; done

req POST /api/projects "$T_OWNER" '{"name":"QAX2B2 Smoke","description":"compile smoke","track":"QA_ONLY"}'
check "owner creates QA_ONLY project" 201 "$RESP_CODE"
PID=$(jget "['id']")
req POST "/api/projects/$PID/phases" "$T_BA" '{"phaseType":"PLANNER","input":"scope"}'
EXEC_PLAN=$(jget "['id']")
req POST "/api/phases/$EXEC_PLAN/output" "$T_BA" '{"output":"Test Scope: orders API + portal login."}'
req POST "/api/phases/$EXEC_PLAN/review" "$T_OWNER" '{"action":"APPROVE"}'
check "PLANNER approved" 200 "$RESP_CODE"
req POST "/api/projects/$PID/phases" "$T_QA" '{"phaseType":"QA","input":"GET /api/orders returns list; portal login works."}'
EXEC_QA=$(jget "['id']")
check "QA run started" 201 "$RESP_CODE"

echo
echo "-- guards (no Claude call) --"
req POST "/api/phases/$EXEC_QA/qa/steps/confirm" "$T_QA" ""
check "confirm steps at SCENARIO_DRAFT -> 409" 409 "$RESP_CODE"
req POST "/api/phases/$EXEC_QA/qa/artifacts/recompile" "$T_QA" ""
check "recompile before COMPILED -> 409" 409 "$RESP_CODE"
req POST "/api/phases/$EXEC_QA/qa/revise" "$T_QA" '{"targetStage":"EXECUTING"}'
check "revise to a later stage -> 409" 409 "$RESP_CODE"

echo
echo "-- full path (real Claude calls; skipped if no key) --"
req POST "/api/phases/$EXEC_QA/qa/scenarios/generate" "$T_QA" ""
if [ "$RESP_CODE" = "503" ]; then
  echo "SKIP  generation (ANTHROPIC_API_KEY not configured -> 503)"
else
  check "generate scenarios -> 200" 200 "$RESP_CODE"
  req POST "/api/phases/$EXEC_QA/qa/scenarios/confirm" "$T_QA" ""
  check "confirm scenarios -> 200" 200 "$RESP_CODE"
  req POST "/api/phases/$EXEC_QA/qa/steps/generate" "$T_QA" ""
  check "generate steps -> 200" 200 "$RESP_CODE"

  req POST "/api/phases/$EXEC_QA/qa/steps/confirm" "$T_QA" ""
  check "confirm + compile steps -> 200" 200 "$RESP_CODE"
  check "  -> stage COMPILED" "COMPILED" "$(jget "['testRun']['stage']")"
  ATYPE="$(jget "['testRun']['scenarios'][0]['steps'][0]['artifactType']")"
  if [ "$ATYPE" = "HTTP" ] || [ "$ATYPE" = "BROWSER" ]; then
    printf 'PASS  %-54s (%s)\n' "  -> step has a compiled artifactType" "$ATYPE"; PASS=$((PASS + 1))
  else
    printf 'FAIL  %-54s (got %s)\n' "  -> step has a compiled artifactType" "$ATYPE"; FAIL=$((FAIL + 1))
  fi

  echo
  echo "-- compile-stage feedback loop + back-navigation --"
  req POST "/api/phases/$EXEC_QA/qa/artifacts/recompile" "$T_QA" \
    '{"feedback":"Make sure each HTTP step asserts the status code explicitly."}'
  check "recompile with feedback -> 200" 200 "$RESP_CODE"
  check "  -> still stage COMPILED" "COMPILED" "$(jget "['testRun']['stage']")"

  req POST "/api/phases/$EXEC_QA/qa/revise" "$T_QA" '{"targetStage":"STEPS_DRAFT"}'
  check "revise back to STEPS_DRAFT -> 200" 200 "$RESP_CODE"
  check "  -> stage STEPS_DRAFT" "STEPS_DRAFT" "$(jget "['testRun']['stage']")"
fi

echo
echo "================ SUMMARY ================"
echo "PASSED: $PASS   FAILED: $FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL GREEN ✅" || echo "SOME TESTS FAILED ❌"
exit "$FAIL"
