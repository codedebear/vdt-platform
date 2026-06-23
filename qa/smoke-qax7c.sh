#!/usr/bin/env bash
#
# QA smoke test for VDT Platform QAX-7C (UATR PDF "Test Result Report").
#
# Guard (report before a run reaches RESULTS_REVIEW) costs no tokens. The deep
# path needs a finalized run, so it runs gen->compile (real Claude) only with an
# ANTHROPIC_API_KEY, drives the run to RESULTS_REVIEW by acting as the worker
# (claim + submit PASS with a PNG as evidence), then asserts:
#   GET /qa/report.pdf -> 200 + application/pdf + attachment UATR_*.pdf + %PDF body.
# Needs WORKER_TOKEN (read from .env) + a non-prod target, like smoke-qax5.
#
# Usage (from repo root, backend running):
#   bash qa/smoke-qax7c.sh
#   BASE=http://192.168.1.13:4000 bash qa/smoke-qax7c.sh
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

echo "== VDT Platform QA — QAX-7C (UATR PDF report) =="
echo "Base URL: $BASE"
printf 'waiting for backend'
for _ in $(seq 1 30); do curl -sf "$BASE/health" >/dev/null 2>&1 && { echo " ready"; break; }; printf '.'; sleep 2; done
echo

register owner@codedebear.com "Owner One"
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
T_QA=$(login qa@codedebear.com)
for t in "$T_OWNER" "$T_QA"; do [ -z "$t" ] && { echo "login failed"; exit 1; }; done

req POST /api/projects "$T_OWNER" '{"name":"QAX7C Smoke","description":"pdf report smoke","track":"QA_ONLY"}'
check "owner creates QA_ONLY project" 201 "$RESP_CODE"
PID=$(jget "['id']")

req POST "/api/projects/$PID/phases" "$T_QA" '{"phaseType":"PLANNER","input":"scope"}'
EXEC_PLAN=$(jget "['id']")
req POST "/api/phases/$EXEC_PLAN/output" "$T_QA" '{"output":"Test Scope: orders API."}'
req POST "/api/phases/$EXEC_PLAN/review" "$T_OWNER" '{"action":"APPROVE"}'
req POST "/api/projects/$PID/phases" "$T_QA" '{"phaseType":"QA","input":"GET /api/orders returns a list."}'
EXEC_QA=$(jget "['id']")
check "QA run created" 201 "$RESP_CODE"

echo
echo "-- guard (no run; no tokens) --"
req GET "/api/phases/$EXEC_QA/qa/report.pdf" "$T_QA" ""
check "report.pdf before any run -> 409" 409 "$RESP_CODE"

req POST "/api/phases/$EXEC_QA/qa/scenarios/generate" "$T_QA" ""
HAVE_AI=1
[ "$RESP_CODE" = "503" ] && HAVE_AI=0

if [ "$HAVE_AI" = "0" ]; then
  echo "SKIP  pdf report (no ANTHROPIC_API_KEY -> 503 on generate)"
elif [ -z "${WORKER_TOKEN:-}" ]; then
  echo "SKIP  pdf report (WORKER_TOKEN not set)"
else
  req PUT "/api/projects/$PID/target" "$T_OWNER" \
    '{"label":"UAT","baseUrl":"https://staging.example.com","hostAllowlist":["api.staging.example.com"],"isNonProd":true}'
  req POST "/api/phases/$EXEC_QA/qa/scenarios/confirm" "$T_QA" ""
  req POST "/api/phases/$EXEC_QA/qa/steps/generate" "$T_QA" ""
  req POST "/api/phases/$EXEC_QA/qa/steps/confirm" "$T_QA" ""
  req POST "/api/phases/$EXEC_QA/qa/run/start" "$T_QA" ""
  check "startRun -> EXECUTING" "EXECUTING" "$(jget "['testRun']['stage']")"

  # Report not available yet while EXECUTING.
  req GET "/api/phases/$EXEC_QA/qa/report.pdf" "$T_QA" ""
  check "report.pdf while EXECUTING -> 409" 409 "$RESP_CODE"

  for _ in $(seq 1 20); do
    wreq POST /api/worker/jobs/claim '{"workerId":"smoke-qax7c"}'
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
print(json.dumps({'workerId':'smoke-qax7c','results':res}))")"
    wreq POST "/api/worker/jobs/$RUN_ID/results" "$RESULTS"
  done

  req GET "/api/phases/$EXEC_QA/qa" "$T_QA" ""
  check "run reached RESULTS_REVIEW" "RESULTS_REVIEW" "$(jget "['testRun']['stage']")"

  PDF_TMP="$(mktemp /tmp/report_qax7c.XXXXXX.pdf)"
  HDRS="$(curl -s -D - -o "$PDF_TMP" -w '%{http_code}' \
    -H "Authorization: Bearer $T_QA" "$BASE/api/phases/$EXEC_QA/qa/report.pdf")"
  PDF_CODE="$(printf '%s' "$HDRS" | tail -n1)"
  check "report.pdf at RESULTS_REVIEW -> 200" 200 "$PDF_CODE"
  printf '%s' "$HDRS" | grep -qi 'content-type: application/pdf' \
    && pass_msg "  -> content-type application/pdf" || fail_msg "  -> content-type application/pdf"
  printf '%s' "$HDRS" | grep -qi 'content-disposition: attachment; filename="UATR_.*\.pdf"' \
    && pass_msg "  -> attachment filename UATR_*.pdf" || fail_msg "  -> attachment filename UATR_*.pdf"
  if [ "$(head -c5 "$PDF_TMP")" = "%PDF-" ] && [ -s "$PDF_TMP" ]; then
    pass_msg "  -> body is a non-empty PDF"
  else
    fail_msg "  -> body is a non-empty PDF"
  fi
  rm -f "$PDF_TMP"

  # Still available after sign-off (EXPORTED).
  req POST "/api/phases/$EXEC_QA/qa/results/confirm" "$T_QA" '{"version":"1.1"}'
  req GET "/api/phases/$EXEC_QA/qa/report.pdf" "$T_QA" ""
  check "report.pdf at EXPORTED -> 200" 200 "$RESP_CODE"
fi

echo
echo "================ SUMMARY ================"
echo "PASSED: $PASS   FAILED: $FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL GREEN ✅" || echo "SOME TESTS FAILED ❌"
exit "$FAIL"
