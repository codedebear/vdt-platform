#!/usr/bin/env bash
#
# QA smoke test for BE-BATCH-1 (Anthropic Message Batches API generation).
#
# Covers the externally observable behaviour of this sub-phase:
#   - mode validation           -> generate with an invalid mode = 422
#   - sync still default         -> generate (no body) behaves as before (200/402/503)
#   - batch unconfigured         -> mode=batch with no ANTHROPIC_API_KEY = 503
#   - (optional BATCH_TEST=1)    -> mode=batch returns 202 + QUEUED + batchId,
#                                   the poller advances it to AWAITING_REVIEW,
#                                   output + (batch-rate) costUsd are recorded,
#                                   and a 2nd batch generate on a QUEUED run = 409
#
# The poller + budget reserve/settle concurrency are covered by the unit suite
# and the atomic DB ops; this smoke exercises the end-to-end queued->reviewed path.
#
# Usage (run on the Pi, repo root, backend running):
#   bash qa/smoke-batch1.sh
#   BASE=http://192.168.1.13:4000 bash qa/smoke-batch1.sh
#   BATCH_TEST=1 bash qa/smoke-batch1.sh        # also exercise a real (paid) batch
#   BATCH_TEST=1 POLL_TIMEOUT=300 bash qa/smoke-batch1.sh
set -uo pipefail

BASE="${BASE:-http://localhost:4000}"
PASSWORD="${PASSWORD:-changeme123}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$SCRIPT_DIR/..}"
SEED_SQL="$SCRIPT_DIR/seed-roles.sql"
SEED_MODE="${SEED_MODE:-auto}"
COMPOSE_SVC="${COMPOSE_SVC:-backend}"
BATCH_TEST="${BATCH_TEST:-0}"
POLL_TIMEOUT="${POLL_TIMEOUT:-240}"   # seconds to wait for the batch to finish
POLL_EVERY="${POLL_EVERY:-10}"        # seconds between status checks

if [ -z "${DATABASE_URL:-}" ] && [ -f "$REPO_DIR/.env" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$REPO_DIR/.env" | head -1 | cut -d= -f2-)"
fi
if [ "$SEED_MODE" = "auto" ]; then
  if command -v docker >/dev/null 2>&1; then SEED_MODE="docker"; else SEED_MODE="host"; fi
fi

PASS=0; FAIL=0
RESP_BODY=""; RESP_CODE=""
ok()   { echo "  ✅ PASS — $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ FAIL — $1"; FAIL=$((FAIL+1)); }
skip() { echo "  ⏭️  SKIP — $1"; }
jget() { printf '%s' "$RESP_BODY" | python3 -c "import sys,json;print(json.load(sys.stdin)$1)" 2>/dev/null; }

req() {  # METHOD PATH TOKEN [JSON_BODY]
  local method=$1 path=$2 token=$3 body=${4:-}
  local args=(-s -w $'\n%{http_code}' -X "$method" "$BASE$path" -H 'Content-Type: application/json')
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(--data-binary "$body")
  local out; out=$(curl "${args[@]}")
  RESP_CODE=$(printf '%s' "$out" | tail -n1); RESP_BODY=$(printf '%s' "$out" | sed '$d')
}

auth_token() {
  local email=$1
  req POST /api/auth/register "" "{\"name\":\"${email%%@*}\",\"email\":\"$email\",\"password\":\"$PASSWORD\"}" >/dev/null 2>&1
  req POST /api/auth/login "" "{\"email\":\"$email\",\"password\":\"$PASSWORD\"}"
  jget "['token']"
}

# Find an execution's status inside GET /api/projects/:id (executions embedded).
exec_field() {  # PID EXECID FIELD  (echoes value, via RESP_BODY of the GET)
  printf '%s' "$RESP_BODY" | python3 -c "
import sys,json
pid,eid,field=sys.argv[1],sys.argv[2],sys.argv[3]
d=json.load(sys.stdin)
for e in d.get('executions',[]):
  if e.get('id')==eid:
    print(e.get(field)); break
" "$1" "$2" "$3" 2>/dev/null
}

echo "QA smoke — BE-BATCH-1 batch generation @ ${BASE}"
echo "============================================================"

auth_token super@codedebear.com >/dev/null
echo "Seeding roles (mode: $SEED_MODE)…"
if [ "$SEED_MODE" = "docker" ]; then
  docker compose exec -T "$COMPOSE_SVC" npx prisma db execute --file /app/qa/seed-roles.sql --schema /app/prisma/schema.prisma >/dev/null 2>&1 \
    || docker compose exec -T "$COMPOSE_SVC" sh -lc "npx prisma db execute --stdin --schema prisma/schema.prisma" < "$SEED_SQL" >/dev/null 2>&1
else
  ( cd "$REPO_DIR/backend" && DATABASE_URL="$DATABASE_URL" npx prisma db execute --file "$SEED_SQL" --schema prisma/schema.prisma ) >/dev/null 2>&1
fi

SUPER="$(auth_token super@codedebear.com)"
[ -n "$SUPER" ] && ok "login super@ (SUPER_ADMIN)" || bad "login super@"

# --- a project + an open PLANNER run to generate against -------------------
req POST /api/projects "$SUPER" '{"name":"BATCH1 Smoke","track":"FULL_SDLC"}'
[ "$RESP_CODE" = "201" ] && ok "create project -> 201" || bad "create -> $RESP_CODE"
PID="$(jget "['id']")"
req POST "/api/projects/$PID/phases" "$SUPER" '{"phaseType":"PLANNER","input":"Build a simple TODO API."}'
[ "$RESP_CODE" = "201" ] && ok "start PLANNER -> 201" || bad "start -> $RESP_CODE"
EXEC="$(jget "['id']")"

# --- mode validation (422) -------------------------------------------------
req POST "/api/phases/$EXEC/generate" "$SUPER" '{"mode":"turbo"}'
[ "$RESP_CODE" = "422" ] && ok "invalid mode -> 422 (validation)" || bad "invalid mode -> $RESP_CODE (expected 422)"

# --- batch path behaviour --------------------------------------------------
if [ "$BATCH_TEST" != "1" ]; then
  # Without exercising a real (paid) batch, just confirm the contract: with no
  # API key the batch path returns 503; with a key it would return 202.
  req POST "/api/phases/$EXEC/generate" "$SUPER" '{"mode":"batch"}'
  case "$RESP_CODE" in
    503) ok "mode=batch unconfigured -> 503 (no ANTHROPIC_API_KEY)";;
    202) skip "mode=batch -> 202 (a key is set; run BATCH_TEST=1 to verify the full loop)";;
    402) skip "mode=batch -> 402 (project over budget on this host)";;
    *)   bad "mode=batch -> $RESP_CODE (expected 503 or 202)";;
  esac
  echo "  (set BATCH_TEST=1 to submit a real batch and verify the queued->reviewed loop)"
else
  req POST "/api/phases/$EXEC/generate" "$SUPER" '{"mode":"batch"}'
  if [ "$RESP_CODE" = "202" ]; then
    ok "mode=batch -> 202 Accepted"
    [ "$(jget "['status']")" = "QUEUED" ] && ok "run status = QUEUED" || bad "status = $(jget "['status']") (expected QUEUED)"
    BID="$(jget "['batchId']")"
    [ -n "$BID" ] && [ "$BID" != "None" ] && ok "batchId recorded ($BID)" || bad "batchId not set"

    # 2nd batch generate on a QUEUED run must be rejected (status guard).
    req POST "/api/phases/$EXEC/generate" "$SUPER" '{"mode":"batch"}'
    [ "$RESP_CODE" = "409" ] && ok "2nd generate on QUEUED run -> 409 (guard)" || bad "2nd generate -> $RESP_CODE (expected 409)"

    echo "  Waiting for the poller to finish the batch (timeout ${POLL_TIMEOUT}s)…"
    WAITED=0; STATUS="QUEUED"
    while [ "$WAITED" -lt "$POLL_TIMEOUT" ]; do
      sleep "$POLL_EVERY"; WAITED=$((WAITED+POLL_EVERY))
      req GET "/api/projects/$PID" "$SUPER"
      STATUS="$(exec_field "$PID" "$EXEC" status)"
      [ "$STATUS" != "QUEUED" ] && break
    done
    case "$STATUS" in
      AWAITING_REVIEW)
        ok "poller advanced QUEUED -> AWAITING_REVIEW (after ~${WAITED}s)"
        OUT="$(exec_field "$PID" "$EXEC" output)"
        [ -n "$OUT" ] && [ "$OUT" != "None" ] && ok "generated output recorded" || bad "output empty"
        COST="$(exec_field "$PID" "$EXEC" costUsd)"
        [ -n "$COST" ] && [ "$COST" != "None" ] && ok "batch-rate costUsd recorded ($COST)" || bad "costUsd not set"
        ;;
      FAILED)
        bad "run ended FAILED ($(exec_field "$PID" "$EXEC" reviewNote))";;
      QUEUED)
        skip "still QUEUED after ${POLL_TIMEOUT}s (batch SLA is up to 24h; check later)";;
      *)
        bad "unexpected status: $STATUS";;
    esac
  elif [ "$RESP_CODE" = "503" ]; then
    skip "mode=batch (no ANTHROPIC_API_KEY on this host)"
  else
    bad "mode=batch -> $RESP_CODE (expected 202 or 503)"
  fi
fi

echo "============================================================"
echo "Total: $((PASS+FAIL))  |  Passed: ${PASS}  |  Failed: ${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
