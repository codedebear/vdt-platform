#!/usr/bin/env bash
#
# QA smoke test for VDT Platform QAX-7A (evidence access + getTestRun trim).
#
# Always-on guards (auth + not-found) cost no tokens. The deep path needs an
# EXECUTING run, so it runs gen->compile (real Claude calls) only when the backend
# has an ANTHROPIC_API_KEY, then acts as the execution worker (claim + submit a
# PASS result carrying a tiny PNG as evidence) so it can verify:
#   - GET /qa omits the `evidence` bytes (only evidenceMime is surfaced),
#   - GET /qa/steps/:stepId/evidence streams the bytes with the stored MIME type,
#   - a bogus stepId -> 404 and a missing token -> 401.
# Needs WORKER_TOKEN (read from .env) and a non-prod target, like smoke-qax5.
#
# Usage (from repo root, backend running):
#   bash qa/smoke-qax7a.sh
#   BASE=http://192.168.1.13:4000 bash qa/smoke-qax7a.sh
#
set -uo pipefail

BASE="${BASE:-http://localhost:4000}"
PASSWORD="${PASSWORD:-changeme123}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$SCRIPT_DIR/..}"
SEED_SQL="$SCRIPT_DIR/seed-roles.sql"
SEED_MODE="${SEED_MODE:-auto}"
COMPOSE_SVC="${COMPOSE_SVC:-backend}"
# A 1x1 transparent PNG, base64 — the fake screenshot the smoke submits as evidence.
PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
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

echo "== VDT Platform QA — QAX-7A (evidence access + getTestRun trim) =="
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

req POST /api/projects "$T_OWNER" '{"name":"QAX7A Smoke","description":"evidence smoke","track":"QA_ONLY"}'
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
req GET "/api/phases/$EXEC_QA/qa/steps/00000000-0000-0000-0000-000000000000/evidence" "$T_QA" ""
check "evidence for unknown step -> 404" 404 "$RESP_CODE"
req GET "/api/phases/$EXEC_QA/qa/steps/00000000-0000-0000-0000-000000000000/evidence" "" ""
check "evidence without token -> 401" 401 "$RESP_CODE"

req POST "/api/phases/$EXEC_QA/qa/scenarios/generate" "$T_QA" ""
HAVE_AI=1
[ "$RESP_CODE" = "503" ] && HAVE_AI=0

if [ "$HAVE_AI" = "0" ]; then
  echo "SKIP  evidence round-trip (no ANTHROPIC_API_KEY -> 503 on generate)"
elif [ -z "${WORKER_TOKEN:-}" ]; then
  echo "SKIP  evidence round-trip (WORKER_TOKEN not set)"
else
  req PUT "/api/projects/$PID/target" "$T_OWNER" \
    '{"label":"UAT","baseUrl":"https://staging.example.com","hostAllowlist":["api.staging.example.com"],"isNonProd":true}'
  req POST "/api/phases/$EXEC_QA/qa/scenarios/confirm" "$T_QA" ""
  req POST "/api/phases/$EXEC_QA/qa/steps/generate" "$T_QA" ""
  req POST "/api/phases/$EXEC_QA/qa/steps/confirm" "$T_QA" ""
  req POST "/api/phases/$EXEC_QA/qa/run/start" "$T_QA" ""
  check "startRun -> EXECUTING" "EXECUTING" "$(jget "['testRun']['stage']")"

  EV_STEP=""
  for _ in $(seq 1 20); do
    wreq POST /api/worker/jobs/claim '{"workerId":"smoke-qax7a"}'
    [ "$RESP_CODE" != "200" ] && break
    JOB="$RESP_BODY"
    RUN_ID="$(printf '%s' "$JOB" | python3 -c "import sys,json;print(json.load(sys.stdin)['job']['runId'])")"
    NSTEPS="$(printf '%s' "$JOB" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['job']['steps']))")"
    [ "$NSTEPS" -eq 0 ] 2>/dev/null && continue
    THIS_STEP="$(printf '%s' "$JOB" | python3 -c "import sys,json;print(json.load(sys.stdin)['job']['steps'][0]['stepId'])")"
    [ -z "$EV_STEP" ] && EV_STEP="$THIS_STEP"
    RESULTS="$(printf '%s' "$JOB" | PNG="$PNG_B64" python3 -c "
import sys,json,os
job=json.load(sys.stdin)['job']
png=os.environ['PNG']
res=[{'stepId':s['stepId'],'status':'PASS','actualResult':'ok','durationMs':5,
      'evidence':png,'evidenceMime':'image/png'} for s in job['steps']]
print(json.dumps({'workerId':'smoke-qax7a','results':res}))")"
    wreq POST "/api/worker/jobs/$RUN_ID/results" "$RESULTS"
  done

  req GET "/api/phases/$EXEC_QA/qa" "$T_QA" ""
  if printf '%s' "$RESP_BODY" | grep -q '"evidenceMime":"image/png"'; then
    pass_msg "getTestRun surfaces evidenceMime"
  else
    fail_msg "getTestRun surfaces evidenceMime"
  fi
  if printf '%s' "$RESP_BODY" | grep -q '"evidence":'; then
    fail_msg "getTestRun omits evidence bytes"
  else
    pass_msg "getTestRun omits evidence bytes"
  fi

  if [ -n "$EV_STEP" ]; then
    EV_TMP="$(mktemp /tmp/ev_qax7a.XXXXXX)"
    HDRS="$(curl -s -D - -o "$EV_TMP" -w '%{http_code}' \
      -H "Authorization: Bearer $T_QA" \
      "$BASE/api/phases/$EXEC_QA/qa/steps/$EV_STEP/evidence")"
    EV_CODE="$(printf '%s' "$HDRS" | tail -n1)"
    check "GET evidence -> 200" 200 "$EV_CODE"
    printf '%s' "$HDRS" | grep -qi 'content-type: image/png' \
      && pass_msg "  -> content-type image/png" || fail_msg "  -> content-type image/png"
    if [ "$(head -c4 "$EV_TMP" | od -An -tx1 | tr -d ' \n')" = "89504e47" ]; then
      pass_msg "  -> body is a PNG"
    else
      fail_msg "  -> body is a PNG"
    fi
    rm -f "$EV_TMP"
  else
    fail_msg "got a stepId carrying evidence"
  fi
fi

echo
echo "================ SUMMARY ================"
echo "PASSED: $PASS   FAILED: $FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL GREEN ✅" || echo "SOME TESTS FAILED ❌"
exit "$FAIL"
