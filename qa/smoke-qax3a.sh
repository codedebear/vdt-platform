#!/usr/bin/env bash
#
# QA smoke test for VDT Platform QAX-3A (target config + secrets vault + startRun).
# Config/guard checks cost no tokens. The startRun happy path needs a COMPILED run,
# so it runs the gen->compile flow (real Claude calls) only when the backend has an
# ANTHROPIC_API_KEY; otherwise that section is skipped. Secret create needs
# SECRETS_KEY configured on the backend (else 503 -> the value checks are skipped).
#
# Usage (from repo root, backend running):
#   bash qa/smoke-qax3a.sh
#   BASE=http://192.168.1.13:4000 bash qa/smoke-qax3a.sh
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

echo "== VDT Platform QA — QAX-3A (target + secrets + startRun) =="
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

req POST /api/projects "$T_OWNER" '{"name":"QAX3A Smoke","description":"config smoke","track":"QA_ONLY"}'
check "owner creates QA_ONLY project" 201 "$RESP_CODE"
PID=$(jget "['id']")

echo
echo "-- target environment config --"
req GET "/api/projects/$PID/target" "$T_OWNER" ""
check "get target before set -> 200" 200 "$RESP_CODE"
check "  -> target is null" "None" "$(jget "['target']")"

req PUT "/api/projects/$PID/target" "$T_OWNER" \
  '{"baseUrl":"https://staging.example.com","hostAllowlist":["api.staging.example.com"],"isNonProd":false}'
check "set prod target (isNonProd false) -> 422" 422 "$RESP_CODE"

req PUT "/api/projects/$PID/target" "$T_QA" \
  '{"baseUrl":"https://staging.example.com","hostAllowlist":[],"isNonProd":true}'
check "non-owner sets target -> 403" 403 "$RESP_CODE"

req PUT "/api/projects/$PID/target" "$T_OWNER" \
  '{"label":"UAT","baseUrl":"https://staging.example.com","hostAllowlist":["api.staging.example.com"],"isNonProd":true}'
check "owner sets non-prod target -> 200" 200 "$RESP_CODE"
check "  -> baseUrl stored" "https://staging.example.com" "$(jget "['target']['baseUrl']")"
req GET "/api/projects/$PID/target" "$T_OWNER" ""
NHOST="$(jget "['target']['hostAllowlist'].__len__()")"
# base host auto-added to the allowlist => 2 hosts
check "  -> base host auto-added to allowlist" "2" "$NHOST"

echo
echo "-- secrets vault --"
req PUT "/api/projects/$PID/secrets" "$T_OWNER" '{"name":"lower_case","value":"x"}'
check "bad secret name -> 422" 422 "$RESP_CODE"

req PUT "/api/projects/$PID/secrets" "$T_OWNER" '{"name":"TEST_USER","value":"alice@example.com"}'
if [ "$RESP_CODE" = "503" ]; then
  echo "SKIP  secret value checks (SECRETS_KEY not configured -> 503)"
  SECRETS_OK=0
else
  check "owner sets secret -> 200" 200 "$RESP_CODE"
  check "  -> only the name returned" "TEST_USER" "$(jget "['name']")"
  req GET "/api/projects/$PID/secrets" "$T_OWNER" ""
  check "list secrets -> 200" 200 "$RESP_CODE"
  printf '%s' "$RESP_BODY" | grep -q 'TEST_USER' \
    && { printf 'PASS  %-52s\n' "  -> name listed"; PASS=$((PASS+1)); } \
    || { printf 'FAIL  %-52s (body %s)\n' "  -> name listed" "$RESP_BODY"; FAIL=$((FAIL+1)); }
  printf '%s' "$RESP_BODY" | grep -qi 'alice' \
    && { printf 'FAIL  %-52s (value leaked!)\n' "  -> value NOT exposed"; FAIL=$((FAIL+1)); } \
    || { printf 'PASS  %-52s\n' "  -> value NOT exposed"; PASS=$((PASS+1)); }
  SECRETS_OK=1
fi

echo
echo "-- startRun guards + happy path --"
req POST "/api/projects/$PID/phases" "$T_BA" '{"phaseType":"PLANNER","input":"scope"}'
EXEC_PLAN=$(jget "['id']")
req POST "/api/phases/$EXEC_PLAN/output" "$T_BA" '{"output":"Test Scope: orders API."}'
req POST "/api/phases/$EXEC_PLAN/review" "$T_OWNER" '{"action":"APPROVE"}'
req POST "/api/projects/$PID/phases" "$T_QA" '{"phaseType":"QA","input":"GET /api/orders returns list."}'
EXEC_QA=$(jget "['id']")
check "QA run started" 201 "$RESP_CODE"

req POST "/api/phases/$EXEC_QA/qa/run/start" "$T_QA" ""
check "startRun before COMPILED -> 409" 409 "$RESP_CODE"

req POST "/api/phases/$EXEC_QA/qa/scenarios/generate" "$T_QA" ""
if [ "$RESP_CODE" = "503" ]; then
  echo "SKIP  startRun happy path (no ANTHROPIC_API_KEY -> 503)"
else
  req POST "/api/phases/$EXEC_QA/qa/scenarios/confirm" "$T_QA" ""
  req POST "/api/phases/$EXEC_QA/qa/steps/generate" "$T_QA" ""
  req POST "/api/phases/$EXEC_QA/qa/steps/confirm" "$T_QA" ""
  check "compiled to COMPILED" "COMPILED" "$(jget "['testRun']['stage']")"

  req POST "/api/phases/$EXEC_QA/qa/run/start" "$T_QA" ""
  check "startRun (target set) -> 200" 200 "$RESP_CODE"
  check "  -> stage EXECUTING" "EXECUTING" "$(jget "['testRun']['stage']")"
  check "  -> step result seeded NOT_START" "NOT_START" \
    "$(jget "['testRun']['scenarios'][0]['steps'][0]['result']['status']")"
fi

echo
echo "================ SUMMARY ================"
echo "PASSED: $PASS   FAILED: $FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL GREEN ✅" || echo "SOME TESTS FAILED ❌"
exit "$FAIL"
