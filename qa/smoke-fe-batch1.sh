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
# Without BATCH_TEST=1 this performs at most one sync generate and, if a key is
# configured, one batch submit (~50% rate); it does NOT poll/wait for the batch.
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
# 503 no key) but NEVER a validation error. (This consumes EXEC.)
req POST "/api/phases/$EXEC/generate" "$SUPER" '{"mode":"sync"}'
case "$RESP_CODE" in
  200|402|503) ok "generate { mode:'sync' } accepted (HTTP $RESP_CODE)";;
  *) bad "sync generate -> $RESP_CODE (expected 200/402/503, not a 4xx validation error)";;
esac

# The batch path needs its OWN fresh open run: the sync call above closed EXEC,
# and PLANNER is non-repeatable so a new run must live on a new project.
req POST /api/projects "$OWNER" '{"name":"FE-BATCH1 Smoke (batch)","track":"FULL_SDLC"}'
BPID="$(jget "['id']")"
req POST "/api/projects/$BPID/phases" "$SUPER" '{"phaseType":"PLANNER","input":"Build a todo API."}'
BEXEC="$(jget "['id']")"
[ "$(jget "['status']")" = "IN_PROGRESS" ] && ok "started a fresh PLANNER run for the batch test" || bad "could not start the batch run"

if [ "$BATCH_TEST" != "1" ]; then
  # "Generate (batch)" button -> { mode:'batch' } on an OPEN run. Tolerant, like
  # qa/smoke-batch1.sh: 503 when no key, 202 when a key is set (a real batch is
  # submitted; the poller resolves it), 402 if over budget. Else = contract break.
  req POST "/api/phases/$BEXEC/generate" "$SUPER" '{"mode":"batch"}'
  case "$RESP_CODE" in
    503) ok "generate { mode:'batch' } unconfigured -> 503 (UI surfaces error)";;
    202)
      ok "generate { mode:'batch' } -> 202 (key set; batch submitted)"
      [ "$(jget "['status']")" = "QUEUED" ] && ok "run is QUEUED (drives the badge + auto-refresh)" || bad "status not QUEUED"
      [ -n "$(jget "['batchId']")" ] && ok "batchId recorded" || bad "batchId missing"
      req POST "/api/phases/$BEXEC/generate" "$SUPER" '{"mode":"batch"}'
      [ "$RESP_CODE" = "409" ] && ok "2nd generate on a QUEUED run -> 409 (UI hides actions)" || bad "re-generate on QUEUED -> $RESP_CODE (expected 409)"
      echo "  (run BATCH_TEST=1 to also wait for the poller to reach AWAITING_REVIEW)"
      ;;
    402) skip "generate { mode:'batch' } -> 402 (project over budget on this host)";;
    *) bad "batch -> $RESP_CODE (expected 503/202/402)";;
  esac
else
  echo "Part B+ — real batch loop (BATCH_TEST=1, this spends tokens)"
  req POST "/api/phases/$BEXEC/generate" "$SUPER" '{"mode":"batch"}'
  [ "$RESP_CODE" = "202" ] && ok "batch generate -> 202 Accepted" || bad "batch generate -> $RESP_CODE (expected 202)"
  [ "$(jget "['status']")" = "QUEUED" ] && ok "run returned status QUEUED" || bad "status not QUEUED (got $(jget "['status']"))"
  [ -n "$(jget "['batchId']")" ] && ok "run carries a batchId (drives the queued badge)" || bad "batchId missing"

  # The UI's auto-refresh reads project detail; the run must read QUEUED there.
  req GET "/api/projects/$BPID" "$OWNER"
  [ "$(exec_field "$BEXEC" status)" = "QUEUED" ] && ok "project detail shows the run QUEUED (auto-refresh source)" || bad "project detail not QUEUED"

  # While QUEUED the UI hides the generate buttons; a 2nd generate must 409.
  req POST "/api/phases/$BEXEC/generate" "$SUPER" '{"mode":"batch"}'
  [ "$RESP_CODE" = "409" ] && ok "2nd generate on a QUEUED run -> 409" || bad "re-generate on QUEUED -> $RESP_CODE (expected 409)"

  echo "  Polling for the poller to resolve the run (<= ${POLL_TIMEOUT}s)…"
  WAITED=0; FINAL=""
  while [ "$WAITED" -lt "$POLL_TIMEOUT" ]; do
    sleep "$POLL_EVERY"; WAITED=$((WAITED+POLL_EVERY))
    req GET "/api/projects/$BPID" "$OWNER"
    FINAL="$(exec_field "$BEXEC" status)"
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
