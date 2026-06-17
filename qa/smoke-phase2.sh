#!/usr/bin/env bash
#
# QA smoke test for VDT Platform Dev Sub-phase 2 (Core Domain & Workflow Engine).
# Exercises the full workflow loop end-to-end against a running backend.
#
# Usage:
#   bash qa/smoke-phase2.sh
#   BASE=http://192.168.1.13:4000 bash qa/smoke-phase2.sh
#
# Requires: curl, python3 (both ship with Raspberry Pi OS).
#
set -uo pipefail

BASE="${BASE:-http://localhost:4000}"
EMAIL="${EMAIL:-admin@codedebear.com}"
PASSWORD="${PASSWORD:-changeme123}"
NAME="${NAME:-Admin}"

PASS=0
FAIL=0
RESP_BODY=""
RESP_CODE=""

# Extract a field from RESP_BODY, e.g. jget "['token']" or jget "['nextPhase']"
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

# check DESC EXPECTED ACTUAL
check() {
  if [ "$2" = "$3" ]; then
    printf 'PASS  %-45s (%s)\n' "$1" "$3"
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %-45s (expected %s, got %s)\n' "$1" "$2" "$3"
    printf '      body: %s\n' "$RESP_BODY"
    FAIL=$((FAIL + 1))
  fi
}

echo "== VDT Platform QA — Sub-phase 2 =="
echo "Base URL: $BASE"
echo

# --- Auth: login, or register then login ---
req POST /api/auth/login "" "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
if [ "$RESP_CODE" != "200" ]; then
  req POST /api/auth/register "" "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"$NAME\"}"
  req POST /api/auth/login "" "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
fi
check "auth: obtain JWT" 200 "$RESP_CODE"
TOKEN=$(jget "['token']")
if [ -z "$TOKEN" ]; then echo "No token — aborting."; exit 1; fi

# --- Auth guard: protected route without token -> 401 ---
req GET /api/projects "" ""
check "auth guard rejects missing token" 401 "$RESP_CODE"

# --- Validation: invalid track -> 422 ---
req POST /api/projects "$TOKEN" '{"name":"bad","track":"NOPE"}'
check "reject invalid track (validation)" 422 "$RESP_CODE"

echo
echo "-- FULL_SDLC track --"
req POST /api/projects "$TOKEN" '{"name":"QA Phase2 Full","description":"smoke","track":"FULL_SDLC"}'
check "create FULL_SDLC project" 201 "$RESP_CODE"
PID=$(jget "['id']")

# Cannot skip ahead: DEV before PLANNER approved -> 409
req POST "/api/projects/$PID/phases" "$TOKEN" '{"phaseType":"DEV"}'
check "block DEV before PLANNER approved" 409 "$RESP_CODE"

# Start PLANNER -> 201
req POST "/api/projects/$PID/phases" "$TOKEN" '{"phaseType":"PLANNER","input":"SRS here"}'
check "start PLANNER run" 201 "$RESP_CODE"
EXEC=$(jget "['id']")

# Cannot start a second PLANNER while one is open -> 409
req POST "/api/projects/$PID/phases" "$TOKEN" '{"phaseType":"PLANNER"}'
check "block duplicate open PLANNER run" 409 "$RESP_CODE"

# Submit output -> AWAITING_REVIEW
req POST "/api/phases/$EXEC/output" "$TOKEN" '{"output":"## Project Plan ..."}'
check "submit PLANNER output" 200 "$RESP_CODE"
check "  -> status AWAITING_REVIEW" "AWAITING_REVIEW" "$(jget "['status']")"

# Request changes -> CHANGES_REQUESTED, then resubmit
req POST "/api/phases/$EXEC/review" "$TOKEN" '{"action":"REQUEST_CHANGES","note":"add risks"}'
check "review REQUEST_CHANGES" 200 "$RESP_CODE"
check "  -> status CHANGES_REQUESTED" "CHANGES_REQUESTED" "$(jget "['status']")"

req POST "/api/phases/$EXEC/output" "$TOKEN" '{"output":"## Project Plan v2 + risks"}'
check "resubmit after changes" 200 "$RESP_CODE"

# Approve -> APPROVED
req POST "/api/phases/$EXEC/review" "$TOKEN" '{"action":"APPROVE"}'
check "review APPROVE" 200 "$RESP_CODE"
check "  -> status APPROVED" "APPROVED" "$(jget "['status']")"

# nextPhase should now be DEV
req GET "/api/projects/$PID" "$TOKEN" ""
check "get project after PLANNER approved" 200 "$RESP_CODE"
check "  -> nextPhase == DEV" "DEV" "$(jget "['nextPhase']")"

# DEV now allowed
req POST "/api/projects/$PID/phases" "$TOKEN" '{"phaseType":"DEV"}'
check "start DEV after PLANNER approved" 201 "$RESP_CODE"

echo
echo "-- QA_ONLY track (repeatable QA) --"
req POST /api/projects "$TOKEN" '{"name":"QA Phase2 QAonly","track":"QA_ONLY"}'
check "create QA_ONLY project" 201 "$RESP_CODE"
PID2=$(jget "['id']")

# DEV not part of QA_ONLY -> 409
req POST "/api/projects/$PID2/phases" "$TOKEN" '{"phaseType":"DEV"}'
check "reject DEV on QA_ONLY track" 409 "$RESP_CODE"

# PLANNER (test scope) -> approve
req POST "/api/projects/$PID2/phases" "$TOKEN" '{"phaseType":"PLANNER","input":"endpoints list"}'
P=$(jget "['id']")
req POST "/api/phases/$P/output" "$TOKEN" '{"output":"Test Scope"}' >/dev/null
req POST "/api/phases/$P/review" "$TOKEN" '{"action":"APPROVE"}'
check "QA_ONLY: PLANNER approved" 200 "$RESP_CODE"

# QA run #1 -> approve
req POST "/api/projects/$PID2/phases" "$TOKEN" '{"phaseType":"QA"}'
check "QA run #1 starts" 201 "$RESP_CODE"
check "  -> runNumber 1" "1" "$(jget "['runNumber']")"
Q1=$(jget "['id']")
req POST "/api/phases/$Q1/output" "$TOKEN" '{"output":"QA report run1"}' >/dev/null
req POST "/api/phases/$Q1/review" "$TOKEN" '{"action":"APPROVE"}' >/dev/null

# QA run #2 (repeatable) -> 201 with runNumber 2
req POST "/api/projects/$PID2/phases" "$TOKEN" '{"phaseType":"QA"}'
check "QA run #2 (repeatable) starts" 201 "$RESP_CODE"
check "  -> runNumber 2" "2" "$(jget "['runNumber']")"

echo
echo "================ SUMMARY ================"
echo "PASSED: $PASS   FAILED: $FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL GREEN ✅" || echo "SOME TESTS FAILED ❌"
exit "$FAIL"
