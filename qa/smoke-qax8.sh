#!/usr/bin/env bash
#
# QA smoke test for VDT Platform QAX-8 (Full Retest).
#
# Always-on guards (no Claude tokens): retest on a missing exec -> 404; retest on
# a fresh QA run that has NOT reached EXPORTED -> 409.
# Deep path (needs ANTHROPIC_API_KEY + WORKER_TOKEN + a non-prod target, like
# smoke-qax7c): drive a run gen->compile->execute (act as the worker, submit PASS)
# ->confirmResults->EXPORTED, then POST /qa/retest and assert:
#   201 + new run at COMPILED + new executionId != source + every step carries an
#   artifactSpec but has NO result yet + source run is now closed (APPROVED).
#
# Usage (from repo root, backend running):
#   bash qa/smoke-qax8.sh
#   BASE=http://192.168.1.13:4000 bash qa/smoke-qax8.sh
#
set -uo pipefail

BASE="${BASE:-http://localhost:4000}"
PASSWORD="${PASSWORD:-changeme123}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$SCRIPT_DIR/..}"
SEED_SQL="$SCRIPT_DIR/seed-roles.sql"
SEED_MODE="${SEED_MODE:-auto}"
COMPOSE_SVC="${COMPOSE_SVC:-backend}"
PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC"
if [ -z "${DATABASE_URL:-}" ] && [ -f "$REPO_DIR/.env" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$REPO_DIR/.env" | head -1 | cut -d= -f2-)"
fi
if [ -z "${WORKER_TOKEN:-}" ] && [ -f "$REPO_DIR/.env" ]; then
  WORKER_TOKEN="$(grep -E '^WORKER_TOKEN=' "$REPO_DIR/.env" | head -1 | cut -d= -f2-)"
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

wreq() {
  local method=$1 path=$2 body=${3:-}
  local args=(-s -w $'\n%{http_code}' -X "$method" "$BASE$path" \
    -H 'Content-Type: application/json' -H "Authorization: Bearer $WORKER_TOKEN")
  [ -n "$body" ] && args+=(-d "$body")
  local out; out=$(curl "${args[@]}")
  RESP_CODE=$(printf '%s' "$out" | tail -n1)
  RESP_BODY=$(printf '%s' "$out" | sed '$d')
}

check() {
  if [ "$2" = "$3" ]; then printf 'PASS  %-52s (%s)\n' "$1" "$3"; PASS=$((PASS + 1))
  else printf 'FAIL  %-52s (expected %s, got %s)\n' "$1" "$2" "$3"; printf '      body: %s\n' "$RESP_BODY"; FAIL=$((FAIL + 1)); fi
}
pass_msg() { printf 'PASS  %-52s\n' "$1"; PASS=$((PASS + 1)); }
fail_msg() { printf 'FAIL  %-52s %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

register() { req POST /api/auth/register "" "{\"email\":\"$1\",\"password\":\"$PASSWORD\",\"name\":\"$2\"}"; }
login()    { req POST /api/auth/login "" "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}"; jget "['token']"; }

echo "== VDT Platform QA — QAX-8 (Full Retest) =="
echo "Base URL: $BASE"
printf 'waiting for backend'
for _ in $(seq 1 30); do curl -sf "$BASE/health" >/dev/null 2>&1 && { echo " ready"; break; }; printf '.'; sleep 2; done
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

req POST /api/projects "$T_OWNER" '{"name":"QAX8 Smoke","description":"full retest smoke","track":"QA_ONLY"}'
check "owner creates QA_ONLY project" 201 "$RESP_CODE"
PID=$(jget "['id']")

req POST "/api/projects/$PID/phases" "$T_BA" '{"phaseType":"PLANNER","input":"scope"}'
EXEC_PLAN=$(jget "['id']")
req POST "/api/phases/$EXEC_PLAN/output" "$T_BA" '{"output":"Test Scope: orders API."}'
req POST "/api/phases/$EXEC_PLAN/review" "$T_OWNER" '{"action":"APPROVE"}'
req POST "/api/projects/$PID/phases" "$T_QA" '{"phaseType":"QA","input":"GET /api/orders returns a list."}'
EXEC_QA=$(jget "['id']")
check "QA run created" 201 "$RESP_CODE"

echo
echo "-- always-on guards (no tokens) --"
req POST "/api/phases/does-not-exist/qa/retest" "$T_QA" ""
check "retest missing exec -> 404" 404 "$RESP_CODE"

# Bring the run into existence (SCENARIO_DRAFT) only if AI is present; otherwise
# the run row may not exist yet. Retest on a non-EXPORTED run must 409 either way
# (404 no-run is also acceptable before any scenario gen). We force a generate
# attempt; if AI is absent we still assert retest != 201.
req POST "/api/phases/$EXEC_QA/qa/scenarios/generate" "$T_QA" ""
HAVE_AI=1
[ "$RESP_CODE" = "503" ] && HAVE_AI=0

req POST "/api/phases/$EXEC_QA/qa/retest" "$T_QA" ""
if [ "$RESP_CODE" = "409" ]; then pass_msg "retest before EXPORTED -> 409"
else fail_msg "retest before EXPORTED -> 409" "got $RESP_CODE"; fi

if [ "$HAVE_AI" = "0" ]; then
  echo "SKIP  deep retest path (no ANTHROPIC_API_KEY -> 503 on generate)"
elif [ -z "${WORKER_TOKEN:-}" ]; then
  echo "SKIP  deep retest path (WORKER_TOKEN not set)"
else
  echo
  echo "-- deep path: drive run to EXPORTED, then retest --"
  req PUT "/api/projects/$PID/target" "$T_OWNER" \
    '{"label":"UAT","baseUrl":"https://staging.example.com","hostAllowlist":["api.staging.example.com"],"isNonProd":true}'
  req POST "/api/phases/$EXEC_QA/qa/scenarios/confirm" "$T_QA" ""
  req POST "/api/phases/$EXEC_QA/qa/steps/generate" "$T_QA" ""
  req POST "/api/phases/$EXEC_QA/qa/steps/confirm" "$T_QA" ""
  req POST "/api/phases/$EXEC_QA/qa/run/start" "$T_QA" ""
  check "startRun -> EXECUTING" "EXECUTING" "$(jget "['testRun']['stage']")"

  for _ in $(seq 1 20); do
    wreq POST /api/worker/jobs/claim '{"workerId":"smoke-qax8"}'
    [ "$RESP_CODE" != "200" ] && break
    JOB="$RESP_BODY"
    RUN_ID="$(printf '%s' "$JOB" | python3 -c "import sys,json;print(json.load(sys.stdin)['job']['runId'])")"
    NSTEPS="$(printf '%s' "$JOB" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['job']['steps']))")"
    [ "$NSTEPS" -eq 0 ] 2>/dev/null && continue
    RESULTS="$(printf '%s' "$JOB" | PNG="$PNG_B64" python3 -c "
import sys,json,os
job=json.load(sys.stdin)['job']
png=os.environ['PNG']
res=[{'stepId':s['stepId'],'status':'PASS','actualResult':'ok','durationMs':5,
      'evidence':png,'evidenceMime':'image/png'} for s in job['steps']]
print(json.dumps({'workerId':'smoke-qax8','results':res}))")"
    wreq POST "/api/worker/jobs/$RUN_ID/results" "$RESULTS"
  done

  req GET "/api/phases/$EXEC_QA/qa" "$T_QA" ""
  check "run reached RESULTS_REVIEW" "RESULTS_REVIEW" "$(jget "['testRun']['stage']")"
  SRC_NSCEN="$(jget "['testRun']['scenarios'].__len__()")"

  req POST "/api/phases/$EXEC_QA/qa/results/confirm" "$T_QA" '{"version":"1.0"}'
  check "sign-off -> EXPORTED" "EXPORTED" "$(jget "['testRun']['stage']")"

  echo
  echo "-- the retest itself --"
  req POST "/api/phases/$EXEC_QA/qa/retest" "$T_QA" ""
  check "retest from EXPORTED -> 201" 201 "$RESP_CODE"
  NEW_EXEC="$(jget "['testRun']['executionId']")"
  check "new run lands at COMPILED" "COMPILED" "$(jget "['testRun']['stage']")"
  if [ -n "$NEW_EXEC" ] && [ "$NEW_EXEC" != "$EXEC_QA" ]; then
    pass_msg "  -> new executionId differs from source"
  else
    fail_msg "  -> new executionId differs from source" "got '$NEW_EXEC'"
  fi
  NEW_NSCEN="$(jget "['testRun']['scenarios'].__len__()")"
  check "  -> same scenario count cloned" "$SRC_NSCEN" "$NEW_NSCEN"

  # Every cloned step has an artifactSpec but no result yet (results seed at startRun).
  ALL_SPEC="$(printf '%s' "$RESP_BODY" | python3 -c "
import sys,json
r=json.load(sys.stdin)['testRun']
steps=[st for sc in r['scenarios'] for st in sc['steps']]
print('yes' if steps and all(st.get('artifactSpec') is not None for st in steps) else 'no')")"
  check "  -> every cloned step has an artifactSpec" "yes" "$ALL_SPEC"
  NO_RESULTS="$(printf '%s' "$RESP_BODY" | python3 -c "
import sys,json
r=json.load(sys.stdin)['testRun']
steps=[st for sc in r['scenarios'] for st in sc['steps']]
print('yes' if all(st.get('result') is None for st in steps) else 'no')")"
  check "  -> no results carried over" "yes" "$NO_RESULTS"

  # Source run is now closed (APPROVED) so history stays + the new run could start.
  req GET "/api/phases/$EXEC_QA" "$T_QA" ""
  check "source run finalized -> APPROVED" "APPROVED" "$(jget "['status']")"

  # New run can be started (COMPILED -> EXECUTING) reusing the cloned artifacts.
  req POST "/api/phases/$NEW_EXEC/qa/run/start" "$T_QA" ""
  check "new run startRun -> EXECUTING" "EXECUTING" "$(jget "['testRun']['stage']")"
fi

echo
echo "================ SUMMARY ================"
echo "PASSED: $PASS   FAILED: $FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL GREEN ✅" || echo "SOME TESTS FAILED ❌"
exit "$FAIL"
