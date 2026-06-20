#!/usr/bin/env bash
#
# QA smoke test for Frontend FE-BATCH-1 (queued UI + sync/batch toggle + auto-refresh).
#
# FE-BATCH-1 adds NO backend code — it binds the existing BE-BATCH-1 generation
# contract to the UI: the generate buttons now send an explicit body { mode },
# the run shows a QUEUED state while a batch is in flight, and ProjectDetailPage
# auto-refreshes until the poller resolves it. This script verifies the exact
# API contract the new UI performs, plus (optionally) that the frontend still
# type-checks and builds.
#
# Two parts:
#   A. Build artifacts (optional, needs node/npm in frontend/) — tsc strict +
#      vite build succeed and emit dist/. Skipped automatically off-toolchain.
#   B. API contract behind the UI (needs the backend running):
#      - the "Generate with AI" button -> POST .../generate { mode: 'sync' }
#        is accepted (NOT 422; 200/402/503 depending on env).
#      - an invalid mode is rejected 422 (the UI only ever sends sync|batch).
#      - the "Generate (batch)" button -> { mode: 'batch' }:
#          * unconfigured (no ANTHROPIC_API_KEY) -> 503 (UI surfaces the error).
#          * BATCH_TEST=1 (real, paid) -> 202 + status QUEUED + batchId set, the
#            project-detail run reads QUEUED (drives the auto-refresh + badge),
#            the poller advances it to AWAITING_REVIEW, and a 2nd batch generate
#            on a QUEUED run -> 409 (the UI hides actions while QUEUED).
#
# Without BATCH_TEST=1 no Claude tokens are spent.
#
# Usage (run on the Pi, repo root, backend running):
#   bash qa/smoke-fe-batch1.sh
#   BASE=http://192.168.1.13:4000 bash qa/smoke-fe-batch1.sh
#   SKIP_BUILD=1 bash qa/smoke-fe-batch1.sh          # API contract only
#   BATCH_TEST=1 bash qa/smoke-fe-batch1.sh          # also exercise a real batch
#
# Seeds super@ -> SUPER_ADMIN, owner@ -> PROJECT_OWNER via qa/seed-roles.sql.
set -uo pipefail

BASE="${BASE:-http://localhost:4000}"
PASSWORD="${PASSWORD:-changeme123}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$SCRIPT_DIR/..}"
SEED_SQL="$SCRIPT_DIR/seed-roles.sql"
SEED_MODE="${SEED_MODE:-auto}"
COMPOSE_SVC="${COMPOSE_SVC:-backend}"
SKIP_BUILD="${SKIP_BUILD:-0}"
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

# Read an execution's field from GET /api/projects/:id (executions embedded).
exec_field() {  # EXECID FIELD  (uses current RESP_BODY)
  printf '%s' "$RESP_BODY" | python3 -c "
import sys,json
eid,field=sys.argv[1],sys.argv[2]
for e in json.load(sys.stdin).get('executions',[]):
  if e.get('id')==eid:
    v=e.get(field); print('' if v is None else v); break
" "$1" "$2" 2>/dev/null
}

echo "QA smoke — FE-BATCH-1 queued UI / sync-batch toggle @ ${BASE}"
echo "============================================================"

# --- Part A: frontend build artifacts (optional) ---------------------------
echo "Part A — frontend build artifacts"
if [ "$SKIP_BUILD" = "1" ]; then
  skip "build checks (SKIP_BUILD=1)"
elif ! command -v npm >/dev/null 2>&1; then
  skip "build checks (npm not found — verified in the dev sandbox instead)"
else
  ( cd "$REPO_DIR/frontend" \
      && { [ -d node_modules ] || npm install >/dev/null 2>&1; } \
      && ./node_modules/.bin/tsc --noEmit >/dev/null 2>&1 )
  [ $? -eq 0 ] && ok "tsc --noEmit (strict) clean" || bad "tsc reported type errors"
  ( cd "$REPO_DIR/frontend" && ./node_modules/.bin/vite build >/dev/null 2>&1 )
  [ $? -eq 0 ] && ok "vite build succeeded" || bad "vite build failed"
  ls "$REPO_DIR"/frontend/dist/assets/*.js >/dev/null 2>&1 \
    && ok "dist/ bundle emitted" || bad "no dist bundle emitted"
fi

# --- Part B: API contract behind the UI ------------------------------------
echo "Part B — generation-mode contract behind the UI"
for e in super@codedebear.com owner@codedebear.com; do auth_token "$e" >/dev/null; done
echo "Seeding roles (mode: $SEED_MODE)…"
if [ "$SEED_MODE" = "docker" ]; then
  docker compose exec -T "$COMPOSE_SVC" npx prisma db execute --file /app/qa/seed-roles.sql --schema /app/prisma/schema.prisma >/dev/null 2>&1 \
    || docker compose exec -T "$COMPOSE_SVC" sh -lc "npx prisma db execute --stdin --schema prisma/schema.prisma" < "$SEED_SQL" >/dev/null 2>&1
else
  ( cd "$REPO_DIR/backend" && DATABASE_URL="$DATABASE_URL" npx prisma db execute --file "$SEED_SQL" --schema prisma/schema.prisma ) >/dev/null 2>&1
fi

SUPER="$(auth_token super@codedebear.com)"
OWNER="$(auth_token owner@codedebear.com)"
[ -n "$SUPER" ] && ok "login super@ (SUPER_ADMIN)" || bad "login super@"

req POST /api/projects "$OWNER" '{"name":"FE-BATCH1 Smoke","track":"FULL_SDLC"}'
PID="$(jget "['id']")"
req POST "/api/projects/$PID/phases" "$SUPER" '{"phaseType":"PLANNER","input":"Build a todo API."}'
EXEC="$(jget "['id']")"
[ "$(jget "['status']")" = "IN_PROGRESS" ] && ok "started PLANNER run (IN_PROGRESS)" || bad "could not start an open run"

# Invalid mode — the UI only ever sends sync|batch, but the contract must reject.
req POST "/api/phases/$EXEC/generate" "$SUPER" '{"mode":"turbo"}'
[ "$RESP_CODE" = "422" ] && ok "generate { mode:'turbo' } -> 422 (validated)" || bad "invalid mode -> $RESP_CODE (expected 422)"

# "Generate with AI" button -> { mode:'sync' }: accepted (200 ok / 402 budget /
# 503 no key) but NEVER a validation error.
req POST "/api/phases/$EXEC/generate" "$SUPER" '{"mode":"sync"}'
case "$RESP_CODE" in
  200|402|503) ok "generate { mode:'sync' } accepted (HTTP $RESP_CODE)";;
  *) bad "sync generate -> $RESP_CODE (expected 200/402/503, not a 4xx validation error)";;
esac

if [ "$BATCH_TEST" != "1" ]; then
  # Unconfigured batch path the UI's batch button hits without a real key.
  req POST "/api/phases/$EXEC/generate" "$SUPER" '{"mode":"batch"}'
  case "$RESP_CODE" in
    503) ok "generate { mode:'batch' } unconfigured -> 503 (UI surfaces error)";;
    202) skip "batch returned 202 (a key IS configured — run BATCH_TEST=1 for the full loop)";;
    *) bad "batch (unconfigured) -> $RESP_CODE (expected 503)";;
  esac
  echo "  (set BATCH_TEST=1 to exercise the real 202 -> QUEUED -> poller loop)"
else
  echo "Part B+ — real batch loop (BATCH_TEST=1, this spends tokens)"
  # Fresh run so the sync generate above doesn't interfere.
  req POST "/api/projects/$PID/phases" "$SUPER" '{"phaseType":"PLANNER","input":"Build a todo API."}' >/dev/null 2>&1
  NEWEXEC="$(jget "['id']")"; [ -n "$NEWEXEC" ] && EXEC="$NEWEXEC"

  req POST "/api/phases/$EXEC/generate" "$SUPER" '{"mode":"batch"}'
  [ "$RESP_CODE" = "202" ] && ok "batch generate -> 202 Accepted" || bad "batch generate -> $RESP_CODE (expected 202)"
  [ "$(jget "['status']")" = "QUEUED" ] && ok "run returned status QUEUED" || bad "status not QUEUED (got $(jget "['status']"))"
  [ -n "$(jget "['batchId']")" ] && ok "run carries a batchId (drives the queued badge)" || bad "batchId missing"

  # The UI's auto-refresh reads project detail; the run must read QUEUED there.
  req GET "/api/projects/$PID" "$OWNER"
  [ "$(exec_field "$EXEC" status)" = "QUEUED" ] && ok "project detail shows the run QUEUED (auto-refresh source)" || bad "project detail not QUEUED"

  # While QUEUED the UI hides the generate buttons; a 2nd generate must 409.
  req POST "/api/phases/$EXEC/generate" "$SUPER" '{"mode":"batch"}'
  [ "$RESP_CODE" = "409" ] && ok "2nd generate on a QUEUED run -> 409" || bad "re-generate on QUEUED -> $RESP_CODE (expected 409)"

  echo "  Polling for the poller to resolve the run (<= ${POLL_TIMEOUT}s)…"
  WAITED=0; FINAL=""
  while [ "$WAITED" -lt "$POLL_TIMEOUT" ]; do
    sleep "$POLL_EVERY"; WAITED=$((WAITED+POLL_EVERY))
    req GET "/api/projects/$PID" "$OWNER"
    FINAL="$(exec_field "$EXEC" status)"
    [ "$FINAL" != "QUEUED" ] && break
  done
  case "$FINAL" in
    AWAITING_REVIEW) ok "poller resolved QUEUED -> AWAITING_REVIEW in ${WAITED}s";;
    FAILED) bad "batch resolved to FAILED (check ANTHROPIC_API_KEY / batch limits)";;
    QUEUED) bad "still QUEUED after ${POLL_TIMEOUT}s (poller not advancing)";;
    *) bad "unexpected final status: $FINAL";;
  esac
fi

echo "============================================================"
echo "Total: $((PASS+FAIL))  |  Passed: ${PASS}  |  Failed: ${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
