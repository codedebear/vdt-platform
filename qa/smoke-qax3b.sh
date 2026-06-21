#!/usr/bin/env bash
#
# QA smoke test for VDT Platform QAX-3B (worker job queue: claim + submit).
# Drives a run to EXECUTING then exercises the worker API: claim a job, submit
# PASS results, and confirm the run finalizes to RESULTS_REVIEW with a rolled-up
# result. Worker auth needs WORKER_TOKEN (read from .env or env); the gen->compile
# ->start path needs ANTHROPIC_API_KEY. Missing either -> that part is skipped
# while guards still run.
#
# Usage (from repo root, backend running):
#   bash qa/smoke-qax3b.sh
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
if [ -z "${WORKER_TOKEN:-}" ] && [ -f "$REPO_DIR/.env" ]; then
  WORKER_TOKEN="$(grep -E '^WORKER_TOKEN=' "$REPO_DIR/.env" | head -1 | cut -d= -f2-)"
fi
WORKER_TOKEN="${WORKER_TOKEN:-}"
if [ "$SEED_MODE" = "auto" ]; then
  if command -v docker >/dev/null 2>&1; then SEED_MODE="docker"; else SEED_MODE="host"; fi
fi

PASS=0; FAIL=0; RESP_BODY=""; RESP_CODE=""

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
  if [ "$2" = "$3" ]; then printf 'PASS  %-50s (%s)\n' "$1" "$3"; PASS=$((PASS+1))
  else printf 'FAIL  %-50s (expected %s, got %s)\n' "$1" "$2" "$3"; printf '      body: %s\n' "$RESP_BODY"; FAIL=$((FAIL+1)); fi
}
register() { req POST /api/auth/register "" "{\"email\":\"$1\",\"password\":\"$PASSWORD\",\"name\":\"$2\"}"; }
login()    { req POST /api/auth/login "" "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}"; jget "['token']"; }

echo "== VDT Platform QA — QAX-3B (worker queue: claim + submit) =="
echo "Base URL: $BASE"
printf 'waiting for backend'
for _ in $(seq 1 30); do curl -sf "$BASE/health" >/dev/null 2>&1 && { echo " ready"; break; }; printf '.'; sleep 2; done
echo

register owner@codedebear.com "Owner One"
register ba@codedebear.com    "Business Analyst"
register qa@codedebear.com    "QA Engineer"
if [ "$SEED_MODE" = "docker" ]; then
  ( cd "$REPO_DIR" && docker compose exec -T "$COMPOSE_SVC" npx prisma db execute --stdin --schema prisma/schema.prisma < "$SEED_SQL" ) \
    && echo "roles seeded (docker)" || { echo "FAIL seeding"; exit 1; }
else
  [ -z "${DATABASE_URL:-}" ] && { echo "FAIL host seed needs DATABASE_URL"; exit 1; }
  ( cd "$REPO_DIR/backend" && npx prisma db execute --stdin --url "$DATABASE_URL" < "$SEED_SQL" ) \
    && echo "roles seeded (host)" || { echo "FAIL seeding"; exit 1; }
fi
echo

T_OWNER=$(login owner@codedebear.com); T_BA=$(login ba@codedebear.com); T_QA=$(login qa@codedebear.com)
for t in "$T_OWNER" "$T_BA" "$T_QA"; do [ -z "$t" ] && { echo "login failed"; exit 1; }; done

echo "-- worker auth guard --"
req POST "/api/worker/jobs/claim" "" '{"workerId":"w1"}'
if [ -z "$WORKER_TOKEN" ]; then
  check "claim without WORKER_TOKEN configured -> 503" 503 "$RESP_CODE"
  echo "SKIP  worker happy path (WORKER_TOKEN not set in .env)"
  echo; echo "PASSED: $PASS   FAILED: $FAIL"; [ "$FAIL" -eq 0 ] && echo "ALL GREEN ✅" || echo "FAILED ❌"; exit "$FAIL"
fi
check "claim with no token -> 401" 401 "$RESP_CODE"
req POST "/api/worker/jobs/claim" "wrong-token" '{"workerId":"w1"}'
check "claim with wrong token -> 401" 401 "$RESP_CODE"

# Project + non-prod target (required for startRun/claim).
req POST /api/projects "$T_OWNER" '{"name":"QAX3B Smoke","description":"worker smoke","track":"QA_ONLY"}'
PID=$(jget "['id']")
req PUT "/api/projects/$PID/target" "$T_OWNER" \
  '{"baseUrl":"https://staging.example.com","hostAllowlist":["staging.example.com"],"isNonProd":true}'
check "set non-prod target -> 200" 200 "$RESP_CODE"

req POST "/api/projects/$PID/phases" "$T_BA" '{"phaseType":"PLANNER","input":"scope"}'
EXEC_PLAN=$(jget "['id']")
req POST "/api/phases/$EXEC_PLAN/output" "$T_BA" '{"output":"Test Scope: orders API."}'
req POST "/api/phases/$EXEC_PLAN/review" "$T_OWNER" '{"action":"APPROVE"}'
req POST "/api/projects/$PID/phases" "$T_QA" '{"phaseType":"QA","input":"GET /api/orders returns list."}'
EXEC_QA=$(jget "['id']")

echo
echo "-- drive to EXECUTING (real Claude calls; skipped if no key) --"
req POST "/api/phases/$EXEC_QA/qa/scenarios/generate" "$T_QA" ""
if [ "$RESP_CODE" = "503" ]; then
  echo "SKIP  worker happy path (no ANTHROPIC_API_KEY -> 503)"
else
  req POST "/api/phases/$EXEC_QA/qa/scenarios/confirm" "$T_QA" ""
  req POST "/api/phases/$EXEC_QA/qa/steps/generate" "$T_QA" ""
  req POST "/api/phases/$EXEC_QA/qa/steps/confirm" "$T_QA" ""
  req POST "/api/phases/$EXEC_QA/qa/run/start" "$T_QA" ""
  check "run started -> EXECUTING" "EXECUTING" "$(jget "['testRun']['stage']")"

  echo
  echo "-- worker claim + submit --"
  req POST "/api/worker/jobs/claim" "$WORKER_TOKEN" '{"workerId":"smoke-worker"}'
  check "worker claims a job -> 200" 200 "$RESP_CODE"
  RUNID="$(jget "['job']['runId']")"
  NSTEPS="$(jget "['job']['steps'].__len__()")"
  check "  -> job baseUrl present" "https://staging.example.com" "$(jget "['job']['baseUrl']")"
  if [ -n "$NSTEPS" ] && [ "$NSTEPS" -ge 1 ] 2>/dev/null; then
    printf 'PASS  %-50s (%s steps)\n' "  -> job carries steps" "$NSTEPS"; PASS=$((PASS+1))
  else
    printf 'FAIL  %-50s (got %s)\n' "  -> job carries steps" "$NSTEPS"; FAIL=$((FAIL+1))
  fi

  # claiming again returns nothing (already leased) -> 204
  req POST "/api/worker/jobs/claim" "$WORKER_TOKEN" '{"workerId":"smoke-worker-2"}'
  check "second claim (already leased) -> 204" 204 "$RESP_CODE"

  # Build a PASS result for every step (step ids from a fresh GET of the run).
  req GET "/api/phases/$EXEC_QA/qa" "$T_QA" ""
  BODY_FOR_STEPS="$RESP_BODY"
  RESULTS=$(printf '%s' "$BODY_FOR_STEPS" | python3 -c "
import sys,json
tr=json.load(sys.stdin)['testRun']
res=[]
for sc in tr['scenarios']:
    for st in sc['steps']:
        res.append({'stepId':st['id'],'status':'PASS','actualResult':'ok','durationMs':5})
print(json.dumps({'workerId':'smoke-worker','results':res}))
")
  req POST "/api/worker/jobs/$RUNID/results" "$WORKER_TOKEN" "$RESULTS"
  check "submit results -> 200" 200 "$RESP_CODE"
  check "  -> run finalized" "True" "$(jget "['finalized']")"
  check "  -> stage RESULTS_REVIEW" "RESULTS_REVIEW" "$(jget "['stage']")"
  check "  -> overall PASS" "PASS" "$(jget "['overallResult']")"

  req GET "/api/phases/$EXEC_QA/qa" "$T_QA" ""
  check "run now at RESULTS_REVIEW (via GET) " "RESULTS_REVIEW" "$(jget "['testRun']['stage']")"
fi

echo
echo "================ SUMMARY ================"
echo "PASSED: $PASS   FAILED: $FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL GREEN ✅" || echo "SOME TESTS FAILED ❌"
exit "$FAIL"
