#!/usr/bin/env bash
#
# QA smoke test for VDT Platform QAX-5 (UATR Excel export + results sign-off).
#
# Guard checks (export/confirm before a run reaches RESULTS_REVIEW) cost no tokens.
# The end-to-end path needs a COMPILED run, so it runs gen->compile (real Claude
# calls) only when the backend has an ANTHROPIC_API_KEY, then drives the run to
# RESULTS_REVIEW by acting as the execution worker (claim the job + submit PASS
# results via the worker API — no real target is contacted). That deep path also
# needs WORKER_TOKEN (read from .env) and a non-prod target configured.
#
# Usage (from repo root, backend running):
#   bash qa/smoke-qax5.sh
#   BASE=http://192.168.1.13:4000 bash qa/smoke-qax5.sh
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

# Worker-API request (Bearer WORKER_TOKEN instead of a user JWT).
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
  if [ "$2" = "$3" ]; then
    printf 'PASS  %-52s (%s)\n' "$1" "$3"; PASS=$((PASS + 1))
  else
    printf 'FAIL  %-52s (expected %s, got %s)\n' "$1" "$2" "$3"
    printf '      body: %s\n' "$RESP_BODY"; FAIL=$((FAIL + 1))
  fi
}

pass_msg() { printf 'PASS  %-52s\n' "$1"; PASS=$((PASS + 1)); }
fail_msg() { printf 'FAIL  %-52s %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

register() { req POST /api/auth/register "" "{\"email\":\"$1\",\"password\":\"$PASSWORD\",\"name\":\"$2\"}"; }
login()    { req POST /api/auth/login "" "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}"; jget "['token']"; }

echo "== VDT Platform QA — QAX-5 (UATR export + results sign-off) =="
echo "Base URL: $BASE"
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

req POST /api/projects "$T_OWNER" '{"name":"QAX5 Smoke","description":"uatr export smoke","track":"QA_ONLY"}'
check "owner creates QA_ONLY project" 201 "$RESP_CODE"
PID=$(jget "['id']")

# A QA phase needs an approved PLANNER first (QA_ONLY still gates the first phase).
req POST "/api/projects/$PID/phases" "$T_BA" '{"phaseType":"PLANNER","input":"scope"}'
EXEC_PLAN=$(jget "['id']")
req POST "/api/phases/$EXEC_PLAN/output" "$T_BA" '{"output":"Test Scope: orders API."}'
req POST "/api/phases/$EXEC_PLAN/review" "$T_OWNER" '{"action":"APPROVE"}'
req POST "/api/projects/$PID/phases" "$T_QA" '{"phaseType":"QA","input":"GET /api/orders returns a list."}'
EXEC_QA=$(jget "['id']")
check "QA run created" 201 "$RESP_CODE"

echo
echo "-- guards (no run / wrong stage; no tokens) --"
req GET "/api/phases/$EXEC_QA/qa/export" "$T_QA" ""
check "export before any run -> 409" 409 "$RESP_CODE"
req POST "/api/phases/$EXEC_QA/qa/results/confirm" "$T_QA" ""
check "confirm results before any run -> 409" 409 "$RESP_CODE"

# Create the run at SCENARIO_DRAFT (an empty generate is gated by the API key, but
# the export/confirm guards should still reject the early stage).
req POST "/api/phases/$EXEC_QA/qa/scenarios/generate" "$T_QA" ""
HAVE_AI=1
[ "$RESP_CODE" = "503" ] && HAVE_AI=0

if [ "$HAVE_AI" = "0" ]; then
  echo "SKIP  end-to-end export (no ANTHROPIC_API_KEY -> 503 on generate)"
else
  check "scenarios generated (SCENARIO_DRAFT)" "SCENARIO_DRAFT" "$(jget "['testRun']['stage']")"
  req GET "/api/phases/$EXEC_QA/qa/export" "$T_QA" ""
  check "export at SCENARIO_DRAFT -> 409" 409 "$RESP_CODE"
  req POST "/api/phases/$EXEC_QA/qa/results/confirm" "$T_QA" ""
  check "confirm results at SCENARIO_DRAFT -> 409" 409 "$RESP_CODE"

  # Configure a non-prod target so the run can start.
  req PUT "/api/projects/$PID/target" "$T_OWNER" \
    '{"label":"UAT","baseUrl":"https://staging.example.com","hostAllowlist":["api.staging.example.com"],"isNonProd":true}'

  req POST "/api/phases/$EXEC_QA/qa/scenarios/confirm" "$T_QA" ""
  req POST "/api/phases/$EXEC_QA/qa/steps/generate" "$T_QA" ""
  req POST "/api/phases/$EXEC_QA/qa/steps/confirm" "$T_QA" ""
  check "compiled to COMPILED" "COMPILED" "$(jget "['testRun']['stage']")"
  req POST "/api/phases/$EXEC_QA/qa/run/start" "$T_QA" ""
  check "startRun -> EXECUTING" "EXECUTING" "$(jget "['testRun']['stage']")"

  req GET "/api/phases/$EXEC_QA/qa/export" "$T_QA" ""
  check "export while EXECUTING -> 409" 409 "$RESP_CODE"

  if [ -z "${WORKER_TOKEN:-}" ]; then
    echo "SKIP  reach RESULTS_REVIEW (WORKER_TOKEN not set)"
  else
    # Act as the worker: drain the global queue, submitting PASS for every step of
    # each claimed job, until our run is finalized to RESULTS_REVIEW.
    REVIEW_REACHED=0
    for _ in $(seq 1 20); do
      wreq POST /api/worker/jobs/claim '{"workerId":"smoke-qax5"}'
      [ "$RESP_CODE" = "204" ] && break
      [ "$RESP_CODE" != "200" ] && { fail_msg "worker claim" "(got $RESP_CODE)"; break; }
      RUN_ID=$(jget "['runId']")
      RESULTS=$(printf '%s' "$RESP_BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps([{'stepId':s['stepId'],'status':'PASS','actualResult':'ok','durationMs':1} for s in d['steps']]))")
      wreq POST "/api/worker/jobs/$RUN_ID/results" "{\"workerId\":\"smoke-qax5\",\"results\":$RESULTS}"
    done

    req GET "/api/phases/$EXEC_QA/qa" "$T_QA" ""
    STAGE=$(jget "['testRun']['stage']")
    check "run reached RESULTS_REVIEW" "RESULTS_REVIEW" "$STAGE"

    # Download the UATR at RESULTS_REVIEW (preview, before sign-off).
    XLSX_TMP="$(mktemp /tmp/uatr_qax5.XXXXXX.xlsx)"
    HDRS="$(curl -s -D - -o "$XLSX_TMP" -w '%{http_code}' \
      -H "Authorization: Bearer $T_QA" "$BASE/api/phases/$EXEC_QA/qa/export")"
    EXP_CODE="$(printf '%s' "$HDRS" | tail -n1)"
    check "export at RESULTS_REVIEW -> 200" 200 "$EXP_CODE"
    printf '%s' "$HDRS" | grep -qi 'content-type: application/vnd.openxmlformats' \
      && pass_msg "  -> xlsx content-type" || fail_msg "  -> xlsx content-type"
    printf '%s' "$HDRS" | grep -qi 'content-disposition: attachment; filename="UATR_' \
      && pass_msg "  -> attachment filename UATR_*" || fail_msg "  -> attachment filename UATR_*"
    # An .xlsx is a ZIP: first bytes must be PK\x03\x04.
    if [ "$(head -c2 "$XLSX_TMP")" = "PK" ] && [ -s "$XLSX_TMP" ]; then
      pass_msg "  -> body is a non-empty xlsx (ZIP)"
    else
      fail_msg "  -> body is a non-empty xlsx (ZIP)"
    fi
    rm -f "$XLSX_TMP"

    # Sign off: RESULTS_REVIEW -> EXPORTED, with Amendment metadata.
    req POST "/api/phases/$EXEC_QA/qa/results/confirm" "$T_QA" \
      '{"version":"1.1","preparedBy":"qa.smoke","reviewedBy":"lead","approvedBy":"owner"}'
    check "confirm results -> EXPORTED" "EXPORTED" "$(jget "['testRun']['stage']")"
    check "  -> version stamped" "1.1" "$(jget "['testRun']['version']")"

    # Export still available after sign-off.
    req GET "/api/phases/$EXEC_QA/qa/export" "$T_QA" ""
    check "export at EXPORTED -> 200" 200 "$RESP_CODE"
  fi
fi

echo
echo "================ SUMMARY ================"
echo "PASSED: $PASS   FAILED: $FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL GREEN ✅" || echo "SOME TESTS FAILED ❌"
exit "$FAIL"
