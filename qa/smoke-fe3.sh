#!/usr/bin/env bash
#
# QA smoke test for Frontend FE-3 (Phase Execution UI).
#
# FE-3 adds no backend code — it drives the existing phase-lifecycle endpoints
# from the project-detail screen. This script verifies the exact API contract
# those screens bind to, end to end, plus the role / status guards the UI relies
# on to show or hide its action buttons:
#
#   start phase  -> POST /api/projects/:id/phases     (worker role / SUPER_ADMIN)
#   submit       -> POST /api/phases/:id/output        (manual override, free)
#   review       -> POST /api/phases/:id/review        (project owner / SUPER_ADMIN)
#   generate     -> POST /api/phases/:id/generate       (only if ANTHROPIC_API_KEY)
#
# It uses the free manual-submit path so no Claude tokens are spent; the AI
# generate path is exercised only when GEN_TEST=1 (it costs real tokens).
#
# Usage (run on the Pi, repo root, backend running):
#   bash qa/smoke-fe3.sh
#   BASE=http://192.168.1.13:4000 bash qa/smoke-fe3.sh
#   GEN_TEST=1 bash qa/smoke-fe3.sh        # also test the real AI generate call
#
# Seeds super@ -> SUPER_ADMIN and owner@ -> PROJECT_OWNER via qa/seed-roles.sql.
# target@codedebear.com stays OPERATION and is used to prove the role guards.
#
# Requires: curl, python3, and the backend's prisma (ships with the repo).
set -uo pipefail

BASE="${BASE:-http://localhost:4000}"
PASSWORD="${PASSWORD:-changeme123}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$SCRIPT_DIR/..}"
SEED_SQL="$SCRIPT_DIR/seed-roles.sql"
SEED_MODE="${SEED_MODE:-auto}"
COMPOSE_SVC="${COMPOSE_SVC:-backend}"
GEN_TEST="${GEN_TEST:-0}"

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

ok()  { echo "  ✅ PASS — $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ FAIL — $1"; FAIL=$((FAIL+1)); }

jget() { printf '%s' "$RESP_BODY" | python3 -c "import sys,json;print(json.load(sys.stdin)$1)" 2>/dev/null; }

# req METHOD PATH TOKEN [JSON_BODY] -> sets RESP_CODE, RESP_BODY
req() {
  local method=$1 path=$2 token=$3 body=${4:-}
  local args=(-s -w $'\n%{http_code}' -X "$method" "$BASE$path" -H 'Content-Type: application/json')
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-d "$body")
  local out
  out=$(curl "${args[@]}")
  RESP_CODE=$(printf '%s' "$out" | tail -n1)
  RESP_BODY=$(printf '%s' "$out" | sed '$d')
}

# register (ignore "already exists") then login -> echoes token
auth_token() {
  local email=$1
  req POST /api/auth/register "" "{\"name\":\"${email%%@*}\",\"email\":\"$email\",\"password\":\"$PASSWORD\"}" >/dev/null 2>&1
  req POST /api/auth/login "" "{\"email\":\"$email\",\"password\":\"$PASSWORD\"}"
  jget "['token']"
}

echo "QA smoke — FE-3 phase lifecycle @ ${BASE}"
echo "------------------------------------------------------------"

# --- create the three users, then seed roles -------------------------------
SUPER_EMAIL="super@codedebear.com"
OWNER_EMAIL="owner@codedebear.com"
TARGET_EMAIL="target@codedebear.com"

auth_token "$SUPER_EMAIL"  >/dev/null
auth_token "$OWNER_EMAIL"  >/dev/null
auth_token "$TARGET_EMAIL" >/dev/null

echo "Seeding roles (mode: $SEED_MODE)…"
if [ "$SEED_MODE" = "docker" ]; then
  docker compose exec -T "$COMPOSE_SVC" npx prisma db execute --file /app/qa/seed-roles.sql --schema /app/prisma/schema.prisma \
    >/dev/null 2>&1 || docker compose exec -T "$COMPOSE_SVC" sh -lc "npx prisma db execute --stdin --schema prisma/schema.prisma" < "$SEED_SQL" >/dev/null 2>&1
else
  ( cd "$REPO_DIR/backend" && DATABASE_URL="$DATABASE_URL" npx prisma db execute --file "$SEED_SQL" --schema prisma/schema.prisma ) >/dev/null 2>&1
fi

SUPER_TOKEN="$(auth_token "$SUPER_EMAIL")"
OWNER_TOKEN="$(auth_token "$OWNER_EMAIL")"
TARGET_TOKEN="$(auth_token "$TARGET_EMAIL")"

[ -n "$SUPER_TOKEN" ]  && ok "login super@ (SUPER_ADMIN)"     || bad "could not log in super@"
[ -n "$OWNER_TOKEN" ]  && ok "login owner@ (PROJECT_OWNER)"   || bad "could not log in owner@"
[ -n "$TARGET_TOKEN" ] && ok "login target@ (OPERATION)"      || bad "could not log in target@"

# --- owner creates a FULL_SDLC project -------------------------------------
req POST /api/projects "$OWNER_TOKEN" '{"name":"FE3 Smoke Project","track":"FULL_SDLC"}'
[ "$RESP_CODE" = "201" ] && ok "owner creates project -> 201" || bad "create project -> $RESP_CODE (expected 201)"
PROJECT_ID="$(jget "['id']")"

# OPERATION cannot create a project (PROJECT_CREATE guard the UI hides "New project" for).
req POST /api/projects "$TARGET_TOKEN" '{"name":"nope","track":"QA_ONLY"}'
[ "$RESP_CODE" = "403" ] && ok "OPERATION create project -> 403 (guard)" || bad "OPERATION create -> $RESP_CODE (expected 403)"

# fresh detail: nextPhase should be PLANNER, no executions
req GET "/api/projects/$PROJECT_ID" "$OWNER_TOKEN"
[ "$(jget "['nextPhase']")" = "PLANNER" ] && ok "detail nextPhase = PLANNER" || bad "nextPhase = $(jget "['nextPhase']") (expected PLANNER)"

# --- PHASE_START guard: OPERATION may not start a PLANNER phase -------------
req POST "/api/projects/$PROJECT_ID/phases" "$TARGET_TOKEN" '{"phaseType":"PLANNER"}'
[ "$RESP_CODE" = "403" ] && ok "OPERATION start PLANNER -> 403 (worker-role guard)" || bad "OPERATION start PLANNER -> $RESP_CODE (expected 403)"

# --- start PLANNER as SUPER_ADMIN (the worker-or-admin path) ---------------
req POST "/api/projects/$PROJECT_ID/phases" "$SUPER_TOKEN" '{"phaseType":"PLANNER","input":"Build a todo API"}'
[ "$RESP_CODE" = "201" ] && ok "start PLANNER -> 201" || bad "start PLANNER -> $RESP_CODE (expected 201)"
EXEC_ID="$(jget "['id']")"
[ "$(jget "['status']")" = "IN_PROGRESS" ] && ok "new run status = IN_PROGRESS" || bad "status = $(jget "['status']") (expected IN_PROGRESS)"

# cannot start a second open run of the same phase (engine guard)
req POST "/api/projects/$PROJECT_ID/phases" "$SUPER_TOKEN" '{"phaseType":"PLANNER"}'
[ "$RESP_CODE" = "409" ] && ok "duplicate open PLANNER -> 409 (engine guard)" || bad "duplicate PLANNER -> $RESP_CODE (expected 409)"

# --- manual submit moves it to AWAITING_REVIEW (free path the UI offers) ----
req POST "/api/phases/$EXEC_ID/output" "$SUPER_TOKEN" '{"output":"## Test Scope\n- endpoints: /todos"}'
[ "$RESP_CODE" = "200" ] && ok "submit output -> 200" || bad "submit output -> $RESP_CODE (expected 200)"
[ "$(jget "['status']")" = "AWAITING_REVIEW" ] && ok "status = AWAITING_REVIEW after submit" || bad "status = $(jget "['status']") (expected AWAITING_REVIEW)"

# empty output rejected (422) — UI disables Submit when empty, backend re-checks
req POST "/api/phases/$EXEC_ID/output" "$SUPER_TOKEN" '{"output":""}'
[ "$RESP_CODE" = "422" ] && ok "empty output -> 422 (validation)" || bad "empty output -> $RESP_CODE (expected 422)"

# --- PHASE_REVIEW guard: non-owner OPERATION cannot review -----------------
req POST "/api/phases/$EXEC_ID/review" "$TARGET_TOKEN" '{"action":"APPROVE"}'
[ "$RESP_CODE" = "403" ] && ok "OPERATION review -> 403 (owner-only guard)" || bad "OPERATION review -> $RESP_CODE (expected 403)"

# --- owner approves --------------------------------------------------------
req POST "/api/phases/$EXEC_ID/review" "$OWNER_TOKEN" '{"action":"APPROVE","note":"looks good"}'
[ "$RESP_CODE" = "200" ] && ok "owner approve -> 200" || bad "owner approve -> $RESP_CODE (expected 200)"
[ "$(jget "['status']")" = "APPROVED" ] && ok "status = APPROVED" || bad "status = $(jget "['status']") (expected APPROVED)"
[ "$(jget "['completedAt']")" != "None" ] && [ -n "$(jget "['completedAt']")" ] && ok "completedAt stamped on approve" || bad "completedAt not set on approve"

# reviewing an already-approved run is rejected (409)
req POST "/api/phases/$EXEC_ID/review" "$OWNER_TOKEN" '{"action":"APPROVE"}'
[ "$RESP_CODE" = "409" ] && ok "re-review approved run -> 409 (status guard)" || bad "re-review -> $RESP_CODE (expected 409)"

# submitting on an approved (closed) run is rejected (409)
req POST "/api/phases/$EXEC_ID/output" "$SUPER_TOKEN" '{"output":"late"}'
[ "$RESP_CODE" = "409" ] && ok "submit on approved run -> 409 (status guard)" || bad "submit on approved -> $RESP_CODE (expected 409)"

# --- detail now advances to DEV (drives the Start-phase panel) -------------
req GET "/api/projects/$PROJECT_ID" "$OWNER_TOKEN"
[ "$(jget "['nextPhase']")" = "DEV" ] && ok "detail nextPhase advances to DEV" || bad "nextPhase = $(jget "['nextPhase']") (expected DEV)"

# --- optional: real AI generate (costs tokens) -----------------------------
if [ "$GEN_TEST" = "1" ]; then
  req POST "/api/projects/$PROJECT_ID/phases" "$SUPER_TOKEN" '{"phaseType":"DEV"}'
  DEV_EXEC="$(jget "['id']")"
  req POST "/api/phases/$DEV_EXEC/generate" "$SUPER_TOKEN"
  if [ "$RESP_CODE" = "200" ]; then
    ok "AI generate -> 200"
    [ "$(jget "['status']")" = "AWAITING_REVIEW" ] && ok "generated run = AWAITING_REVIEW" || bad "generated status = $(jget "['status']")"
    [ -n "$(jget "['output']")" ] && ok "generated run has output" || bad "generated run output empty"
  elif [ "$RESP_CODE" = "503" ]; then
    echo "  ⏭️  SKIP — generate returned 503 (no ANTHROPIC_API_KEY on this host)"
  else
    bad "AI generate -> $RESP_CODE (expected 200 or 503)"
  fi
else
  echo "  ⏭️  SKIP — AI generate (set GEN_TEST=1 to exercise; spends Claude tokens)"
fi

echo "------------------------------------------------------------"
echo "Total: $((PASS+FAIL))  |  Passed: ${PASS}  |  Failed: ${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
