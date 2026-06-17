#!/usr/bin/env bash
#
# QA smoke test for VDT Platform Dev Sub-phase 2.5 (AuthZ & RBAC).
# Verifies role-based permission boundaries AND that the Sub-phase 2 workflow
# still works end-to-end under the new authorization layer.
#
# Usage (run on the Pi, from the repo root, with the backend running):
#   bash qa/smoke-phase2.5.sh
#   BASE=http://192.168.1.13:4000 bash qa/smoke-phase2.5.sh
#
# The script:
#   1. Registers the role test users (all start as OPERATION).
#   2. Promotes their roles by running qa/seed-roles.sql via `prisma db execute`.
#   3. Logs each user in (JWT then carries the promoted role).
#   4. Asserts permission boundaries + a full workflow regression.
#
# Requires: curl, python3, and the backend's npx/prisma (ships with the repo).
#
set -uo pipefail

BASE="${BASE:-http://localhost:4000}"
PASSWORD="${PASSWORD:-changeme123}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$SCRIPT_DIR/..}"          # dir containing docker-compose.yml
SEED_SQL="$SCRIPT_DIR/seed-roles.sql"
# How to run the role-promotion SQL:
#   docker (default) -> via the running container (works on the Pi)
#   host             -> via host npx/prisma (needs backend/node_modules locally)
SEED_MODE="${SEED_MODE:-docker}"
COMPOSE_SVC="${COMPOSE_SVC:-backend}"

PASS=0
FAIL=0
RESP_BODY=""
RESP_CODE=""

jget() { printf '%s' "$RESP_BODY" | python3 -c "import sys,json;print(json.load(sys.stdin)$1)" 2>/dev/null; }

# req METHOD PATH TOKEN [JSON_BODY] -> sets RESP_CODE, RESP_BODY
req() {
  local method=$1 path=$2 token=$3 body=${4:-}
  local args=(-s -w $'\n%{http_code}' -X "$method" "$BASE$path" -H 'Content-Type: application/json')
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-d "$body")
  local out
  out=$(curl "${args[@]}")
  RESP_CODE=$(printf '%s' "$out" | tail -n1)
  RESP_BODY=$(printf '%s' "$out" | sed '$d')
}

check() {
  if [ "$2" = "$3" ]; then
    printf 'PASS  %-50s (%s)\n' "$1" "$3"
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %-50s (expected %s, got %s)\n' "$1" "$2" "$3"
    printf '      body: %s\n' "$RESP_BODY"
    FAIL=$((FAIL + 1))
  fi
}

# register EMAIL NAME — idempotent (ignores "already registered")
register() {
  req POST /api/auth/register "" "{\"email\":\"$1\",\"password\":\"$PASSWORD\",\"name\":\"$2\"}"
}

# login EMAIL -> echoes token
login() {
  req POST /api/auth/login "" "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}"
  jget "['token']"
}

echo "== VDT Platform QA — Sub-phase 2.5 (RBAC) =="
echo "Base URL: $BASE"
echo

# --- 1. Register role users (all OPERATION initially) ---
register super@codedebear.com  "Super Admin"
register owner@codedebear.com  "Owner One"
register owner2@codedebear.com "Owner Two"
register ba@codedebear.com     "Business Analyst"
register sa@codedebear.com     "Solution Architect"
register qa@codedebear.com     "QA Engineer"
register op@codedebear.com     "Operations"
echo "registered role users (idempotent)"

# --- 2. Promote roles via Prisma (db execute reads SQL from stdin) ---
seed_ok=false
if [ "$SEED_MODE" = "docker" ]; then
  if ( cd "$REPO_DIR" && docker compose exec -T "$COMPOSE_SVC" \
        npx prisma db execute --stdin --schema prisma/schema.prisma < "$SEED_SQL" ) ; then
    seed_ok=true
  fi
else
  if ( cd "$REPO_DIR/backend" && npx prisma db execute --stdin --schema prisma/schema.prisma < "$SEED_SQL" ) ; then
    seed_ok=true
  fi
fi
if [ "$seed_ok" = true ]; then
  echo "promoted roles via seed-roles.sql (mode: $SEED_MODE)"
else
  echo "FAIL  could not run seed-roles.sql (mode: $SEED_MODE)"; exit 1
fi
echo

# --- 3. Login each (JWT now carries promoted role) ---
T_SUPER=$(login super@codedebear.com)
T_OWNER=$(login owner@codedebear.com)
T_OWNER2=$(login owner2@codedebear.com)
T_BA=$(login ba@codedebear.com)
T_SA=$(login sa@codedebear.com)
T_QA=$(login qa@codedebear.com)
T_OP=$(login op@codedebear.com)
for t in "$T_SUPER" "$T_OWNER" "$T_OWNER2" "$T_BA" "$T_SA" "$T_QA" "$T_OP"; do
  [ -z "$t" ] && { echo "A login failed — aborting."; exit 1; }
done

echo "-- Auth & permission boundaries --"
req GET /api/projects "" ""
check "missing token -> 401" 401 "$RESP_CODE"

req POST /api/projects "$T_OP" '{"name":"x","track":"FULL_SDLC"}'
check "OPERATION cannot create project" 403 "$RESP_CODE"

req GET /api/projects "$T_OP" ""
check "OPERATION may view project list" 200 "$RESP_CODE"

req POST /api/projects "$T_OWNER" '{"name":"bad","track":"NOPE"}'
check "invalid track -> 422" 422 "$RESP_CODE"

req POST /api/projects "$T_OWNER" '{"name":"RBAC Full","track":"FULL_SDLC"}'
check "PROJECT_OWNER creates FULL_SDLC project" 201 "$RESP_CODE"
PID=$(jget "['id']")

echo
echo "-- PLANNER phase (worker = BA) --"
req POST "/api/projects/$PID/phases" "$T_OP" '{"phaseType":"PLANNER"}'
check "OPERATION cannot start PLANNER" 403 "$RESP_CODE"

req POST "/api/projects/$PID/phases" "$T_SA" '{"phaseType":"PLANNER"}'
check "SA cannot start PLANNER (wrong worker)" 403 "$RESP_CODE"

req POST "/api/projects/$PID/phases" "$T_BA" '{"phaseType":"PLANNER","input":"SRS"}'
check "BA starts PLANNER" 201 "$RESP_CODE"
EXEC=$(jget "['id']")

req POST "/api/phases/$EXEC/output" "$T_OP" '{"output":"plan"}'
check "OPERATION cannot submit PLANNER output" 403 "$RESP_CODE"

req POST "/api/phases/$EXEC/output" "$T_BA" '{"output":"## Project Plan"}'
check "BA submits PLANNER output" 200 "$RESP_CODE"
check "  -> AWAITING_REVIEW" "AWAITING_REVIEW" "$(jget "['status']")"

req POST "/api/phases/$EXEC/review" "$T_BA" '{"action":"APPROVE"}'
check "BA (worker) cannot review" 403 "$RESP_CODE"

req POST "/api/phases/$EXEC/review" "$T_OWNER2" '{"action":"APPROVE"}'
check "other owner cannot review (ownership)" 403 "$RESP_CODE"

req POST "/api/phases/$EXEC/review" "$T_OWNER" '{"action":"APPROVE"}'
check "project owner approves PLANNER" 200 "$RESP_CODE"
check "  -> APPROVED" "APPROVED" "$(jget "['status']")"

req GET "/api/projects/$PID" "$T_OWNER" ""
check "  -> nextPhase == DEV" "DEV" "$(jget "['nextPhase']")"

echo
echo "-- DEV phase (worker = SA) --"
req POST "/api/projects/$PID/phases" "$T_QA" '{"phaseType":"DEV"}'
check "QA-role cannot start DEV" 403 "$RESP_CODE"

req POST "/api/projects/$PID/phases" "$T_SA" '{"phaseType":"DEV"}'
check "SA starts DEV" 201 "$RESP_CODE"
DEV=$(jget "['id']")
req POST "/api/phases/$DEV/output" "$T_SA" '{"output":"code"}' >/dev/null
req POST "/api/phases/$DEV/review" "$T_OWNER" '{"action":"APPROVE"}' >/dev/null
check "owner approves DEV" 200 "$RESP_CODE"

echo
echo "-- QA phase (worker = QA) + repeatable --"
req POST "/api/projects/$PID/phases" "$T_QA" '{"phaseType":"QA"}'
check "QA-role starts QA run #1" 201 "$RESP_CODE"
check "  -> runNumber 1" "1" "$(jget "['runNumber']")"
Q1=$(jget "['id']")
req POST "/api/phases/$Q1/output" "$T_QA" '{"output":"QA report 1"}' >/dev/null
req POST "/api/phases/$Q1/review" "$T_OWNER" '{"action":"APPROVE"}' >/dev/null

req POST "/api/projects/$PID/phases" "$T_QA" '{"phaseType":"QA"}'
check "QA run #2 (repeatable) starts" 201 "$RESP_CODE"
check "  -> runNumber 2" "2" "$(jget "['runNumber']")"

echo
echo "-- SUPER_ADMIN override + not-found mapping --"
req POST /api/projects "$T_SUPER" '{"name":"Admin proj","track":"FULL_SDLC"}'
check "SUPER_ADMIN creates project" 201 "$RESP_CODE"
APID=$(jget "['id']")
req POST "/api/projects/$APID/phases" "$T_SUPER" '{"phaseType":"PLANNER"}'
check "SUPER_ADMIN starts any phase (override)" 201 "$RESP_CODE"

req POST "/api/phases/00000000-0000-0000-0000-000000000000/review" "$T_OWNER" '{"action":"APPROVE"}'
check "review missing execution -> 404" 404 "$RESP_CODE"

echo
echo "================ SUMMARY ================"
echo "PASSED: $PASS   FAILED: $FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL GREEN ✅" || echo "SOME TESTS FAILED ❌"
exit "$FAIL"
