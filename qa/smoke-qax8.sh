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

# Retry a Claude-spending request through transient upstream errors (429/5xx/529
# Overloaded) which the compile/generate calls can hit. Leaves RESP_CODE/RESP_BODY
# set to the final attempt.
req_retry() {
  local method=$1 path=$2 token=$3 body=${4:-} n
  for n in $(seq 1 6); do
    req "$method" "$path" "$token" "$body"
    case "$RESP_CODE" in
      429|500|502|503|504|529) printf '      (retry %s: %s on %s)\n' "$n" "$RESP_CODE" "$path"; sleep 6 ;;
      *) return 0 ;;
    esac
  done
  return 0
}

check() {
  if [ "$2" = "$3" ]; then printf 'PASS  %-52s (%s)\n' "$1" "$3"; PASS=$((PASS + 1))
  else printf 'FAIL  %-52s (expected %s, got %s)\n' "$1" "$2" "$3"; printf '      body: %s\n' "$RESP_BODY"; FAIL=$((FAIL + 1)); fi
}
pass_msg() { printf 'PASS  %-52s\n' "$1"; PASS=$((PASS + 1)); }
fail_msg() { printf 'FAIL  %-52s %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

# Wait until <executionId>'s run leaves EXECUTING. Acts as a worker (claim+submit
# PASS, 0 Claude tokens) whenever a job is available, and otherwise polls — so it
# works whether the smoke is the only worker OR a real worker (Mac Docker) is also
# draining the global queue. Args: <executionId> <userToken>.
drain_until_done() {
  local execId=$1 token=$2 i st
  for i in $(seq 1 40); do
    wreq POST /api/worker/jobs/claim '{"workerId":"smoke-qax8"}'
    if [ "$RESP_CODE" = "200" ]; then
      local JOB="$RESP_BODY" RUN_ID NSTEPS RESULTS
      RUN_ID="$(printf '%s' "$JOB" | python3 -c "import sys,json;print(json.load(sys.stdin)['job']['runId'])")"
      NSTEPS="$(printf '%s' "$JOB" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['job']['steps']))")"
      if [ "$NSTEPS" -gt 0 ] 2>/dev/null; then
        RESULTS="$(printf '%s' "$JOB" | PNG="$PNG_B64" python3 -c "
import sys,json,os
job=json.load(sys.stdin)['job']
png=os.environ['PNG']
res=[{'stepId':s['stepId'],'status':'PASS','actualResult':'ok','durationMs':5,
      'evidence':png,'evidenceMime':'image/png'} for s in job['steps']]
print(json.dumps({'workerId':'smoke-qax8','results':res}))")"
        wreq POST "/api/worker/jobs/$RUN_ID/results" "$RESULTS"
      fi
      continue
    fi
    # Nothing to claim right now — maybe a real worker holds it. Poll our run.
    req GET "/api/phases/$execId/qa" "$token" ""
    st="$(jget "['testRun']['stage']")"
    [ -n "$st" ] && [ "$st" != "EXECUTING" ] && return 0
    sleep 3
  done
  return 0
}

# Assert the run returned in RESP_BODY is a fresh COMPILED clone (no results).
assert_clone() {
  local label=$1
  check "$label -> 201" 201 "$RESP_CODE"
  check "  $label lands at COMPILED" "COMPILED" "$(jget "['testRun']['stage']")"
  local SPEC NORES
  SPEC="$(printf '"'"'%s'"'"' "$RESP_BODY" | python3 -c "
import sys,json
r=json.load(sys.stdin)['"'"'testRun'"'"']
st=[x for sc in r['"'"'scenarios'"'"'] for x in sc['"'"'steps'"'"']]
print('"'"'yes'"'"' if st and all(x.get('"'"'artifactSpec'"'"') is not None for x in st) else '"'"'no'"'"')")"
  check "  $label every step has artifactSpec" "yes" "$SPEC"
  NORES="$(printf '"'"'%s'"'"' "$RESP_BODY" | python3 -c "
import sys,json
r=json.load(sys.stdin)['"'"'testRun'"'"']
st=[x for sc in r['"'"'scenarios'"'"'] for x in sc['"'"'steps'"'"']]
print('"'"'yes'"'"' if all(x.get('"'"'result'"'"') is None for x in st) else '"'"'no'"'"')")"
  check "  $label no results carried over" "yes" "$NORES"
}

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
  echo "-- deep path: round 1 -> RESULTS_REVIEW, retest from RESULTS_REVIEW --"
  req PUT "/api/projects/$PID/target" "$T_OWNER" \
    '{"label":"UAT","baseUrl":"https://staging.example.com","hostAllowlist":["api.staging.example.com"],"isNonProd":true}'
  req_retry POST "/api/phases/$EXEC_QA/qa/scenarios/confirm" "$T_QA" ""
  req_retry POST "/api/phases/$EXEC_QA/qa/steps/generate" "$T_QA" ""
  req_retry POST "/api/phases/$EXEC_QA/qa/steps/confirm" "$T_QA" ""

  # Hard gate: a run must be COMPILED before it can start. If compile did not
  # land (e.g. Anthropic 529/timeout on a large scenario set), skip the rest of
  # the deep path cleanly instead of cascading dozens of false failures.
  req GET "/api/phases/$EXEC_QA/qa" "$T_QA" ""
  ST="$(jget "['testRun']['stage']")"
  if [ "$ST" != "COMPILED" ]; then
    fail_msg "compile reached COMPILED" "stage=$ST (deep path skipped; last compile body: $RESP_BODY)"
    echo "SKIP  remaining deep path — compile did not reach COMPILED (likely Anthropic 529/timeout; re-run)"
  else
    pass_msg "compile reached COMPILED"
    req POST "/api/phases/$EXEC_QA/qa/run/start" "$T_QA" ""
    check "round1 startRun -> EXECUTING" "EXECUTING" "$(jget "['testRun']['stage']")"
    drain_until_done "$EXEC_QA" "$T_QA"
    req GET "/api/phases/$EXEC_QA/qa" "$T_QA" ""
    check "round1 reached RESULTS_REVIEW" "RESULTS_REVIEW" "$(jget "['testRun']['stage']")"
    SRC_NSCEN="$(jget "['testRun']['scenarios'].__len__()")"

    if [ "$(jget "['testRun']['stage']")" != "RESULTS_REVIEW" ]; then
      echo "SKIP  retest checks — run not at RESULTS_REVIEW (is the Mac worker running to drain EXECUTING?)"
    else
      # NEW capability: retest WITHOUT signing off (from RESULTS_REVIEW).
      req POST "/api/phases/$EXEC_QA/qa/retest" "$T_QA" ""
      assert_clone "retest from RESULTS_REVIEW"
      EXEC_R2="$(jget "['testRun']['executionId']")"
      if [ -n "$EXEC_R2" ] && [ "$EXEC_R2" != "$EXEC_QA" ]; then
        pass_msg "  round2 executionId differs from source"
      else
        fail_msg "  round2 executionId differs from source" "got '$EXEC_R2'"
      fi
      check "  round2 same scenario count" "$SRC_NSCEN" "$(jget "['testRun']['scenarios'].__len__()")"
      req GET "/api/phases/$EXEC_QA" "$T_QA" ""
      check "  source(round1) finalized -> APPROVED" "APPROVED" "$(jget "['status']")"
      req GET "/api/phases/$EXEC_QA/qa" "$T_QA" ""
      check "  source(round1) run normalized -> EXPORTED" "EXPORTED" "$(jget "['testRun']['stage']")"

      if [ -n "$EXEC_R2" ]; then
        echo
        echo "-- round 2 -> EXPORTED, retest from EXPORTED --"
        req POST "/api/phases/$EXEC_R2/qa/run/start" "$T_QA" ""
        check "round2 startRun -> EXECUTING" "EXECUTING" "$(jget "['testRun']['stage']")"
        drain_until_done "$EXEC_R2" "$T_QA"
        req GET "/api/phases/$EXEC_R2/qa" "$T_QA" ""
        check "round2 reached RESULTS_REVIEW" "RESULTS_REVIEW" "$(jget "['testRun']['stage']")"
        if [ "$(jget "['testRun']['stage']")" = "RESULTS_REVIEW" ]; then
          req POST "/api/phases/$EXEC_R2/qa/results/confirm" "$T_QA" '{"version":"1.0"}'
          check "round2 sign-off -> EXPORTED" "EXPORTED" "$(jget "['testRun']['stage']")"
          req POST "/api/phases/$EXEC_R2/qa/retest" "$T_QA" ""
          assert_clone "retest from EXPORTED"
          EXEC_R3="$(jget "['testRun']['executionId']")"
          req GET "/api/phases/$EXEC_R2" "$T_QA" ""
          check "  source(round2) finalized -> APPROVED" "APPROVED" "$(jget "['status']")"
          [ -n "$EXEC_R3" ] && { req POST "/api/phases/$EXEC_R3/qa/run/start" "$T_QA" ""; \
            check "round3 startRun -> EXECUTING" "EXECUTING" "$(jget "['testRun']['stage']")"; }
        fi
      fi
    fi
  fi
fi

echo
echo "================ SUMMARY ================"
echo "PASSED: $PASS   FAILED: $FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL GREEN ✅" || echo "SOME TESTS FAILED ❌"
exit "$FAIL"
