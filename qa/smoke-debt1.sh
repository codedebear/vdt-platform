#!/usr/bin/env bash
#
# QA smoke test for BE-DEBT-1 (backend debt + per-project AI cost budget).
#
# Covers the externally observable behaviour of this sub-phase:
#   - input max-length guard      -> start a phase with oversized input = 422
#   - project budget fields        -> create exposes budgetUsd / spentUsd
#   - PATCH /api/projects/:id/budget guards (owner ok / non-owner 403 / invalid 422 / null clears)
#   - budget HARD BLOCK            -> budget 0 makes generate return 402 (no Claude call, no tokens)
#   - (optional GEN_TEST=1)        -> a real generate accumulates spentUsd + sets costUsd
#
# The two concurrency fixes (per-run generationCount atomic claim, last-super-admin
# Serializable demotion) are not deterministically testable from a shell smoke;
# they are covered by the atomic DB operations + the unit suite.
#
# Usage (run on the Pi, repo root, backend running):
#   bash qa/smoke-debt1.sh
#   BASE=http://192.168.1.13:4000 bash qa/smoke-debt1.sh
#   GEN_TEST=1 bash qa/smoke-debt1.sh        # also exercise a real (paid) generate
#
# Seeds super@ -> SUPER_ADMIN, owner@ -> PROJECT_OWNER via qa/seed-roles.sql;
# target@codedebear.com stays OPERATION to prove the budget-change guard.
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

echo "QA smoke — BE-DEBT-1 budget + guards @ ${BASE}"
echo "============================================================"

for e in super@codedebear.com owner@codedebear.com target@codedebear.com; do auth_token "$e" >/dev/null; done
echo "Seeding roles (mode: $SEED_MODE)…"
if [ "$SEED_MODE" = "docker" ]; then
  docker compose exec -T "$COMPOSE_SVC" npx prisma db execute --file /app/qa/seed-roles.sql --schema /app/prisma/schema.prisma >/dev/null 2>&1 \
    || docker compose exec -T "$COMPOSE_SVC" sh -lc "npx prisma db execute --stdin --schema prisma/schema.prisma" < "$SEED_SQL" >/dev/null 2>&1
else
  ( cd "$REPO_DIR/backend" && DATABASE_URL="$DATABASE_URL" npx prisma db execute --file "$SEED_SQL" --schema prisma/schema.prisma ) >/dev/null 2>&1
fi

SUPER="$(auth_token super@codedebear.com)"
OWNER="$(auth_token owner@codedebear.com)"
TARGET="$(auth_token target@codedebear.com)"
[ -n "$SUPER" ] && ok "login super@ (SUPER_ADMIN)" || bad "login super@"

# --- create project: budget fields exposed --------------------------------
req POST /api/projects "$OWNER" '{"name":"DEBT1 Smoke","track":"FULL_SDLC"}'
[ "$RESP_CODE" = "201" ] && ok "owner creates project -> 201" || bad "create -> $RESP_CODE"
PID="$(jget "['id']")"
[ "$(jget "['spentUsd']")" = "0" ] && ok "new project spentUsd = 0" || bad "spentUsd = $(jget "['spentUsd']") (expected 0)"
# budgetUsd is null when PROJECT_BUDGET_USD_DEFAULT=0 (the shipped default)
printf '%s' "$RESP_BODY" | grep -q '"budgetUsd"' && ok "response includes budgetUsd field" || bad "budgetUsd field missing"

# --- input max-length guard (422) ------------------------------------------
BIG="$(python3 -c "import sys; sys.stdout.write('x'*100001)")"
req POST "/api/projects/$PID/phases" "$SUPER" "{\"phaseType\":\"PLANNER\",\"input\":\"$BIG\"}"
[ "$RESP_CODE" = "422" ] && ok "oversized input -> 422 (validation)" || bad "oversized input -> $RESP_CODE (expected 422)"

# --- a normal run to generate against --------------------------------------
req POST "/api/projects/$PID/phases" "$SUPER" '{"phaseType":"PLANNER","input":"ok"}'
[ "$RESP_CODE" = "201" ] && ok "start PLANNER (normal input) -> 201" || bad "start -> $RESP_CODE"
EXEC="$(jget "['id']")"

# --- PATCH budget guards ---------------------------------------------------
req PATCH "/api/projects/$PID/budget" "$TARGET" '{"budgetUsd":50}'
[ "$RESP_CODE" = "403" ] && ok "non-owner OPERATION sets budget -> 403" || bad "OPERATION budget -> $RESP_CODE (expected 403)"

req PATCH "/api/projects/$PID/budget" "$OWNER" '{"budgetUsd":-1}'
[ "$RESP_CODE" = "422" ] && ok "negative budget -> 422 (validation)" || bad "negative budget -> $RESP_CODE (expected 422)"

req PATCH "/api/projects/$PID/budget" "$OWNER" '{"budgetUsd":50}'
[ "$RESP_CODE" = "200" ] && [ "$(jget "['budgetUsd']")" = "50.0" -o "$(jget "['budgetUsd']")" = "50" ] \
  && ok "owner sets budget 50 -> 200" || bad "owner budget -> $RESP_CODE / $(jget "['budgetUsd']")"

# --- budget HARD BLOCK: budget 0 => generate 402 (no Claude call) -----------
req PATCH "/api/projects/$PID/budget" "$SUPER" '{"budgetUsd":0}'
[ "$RESP_CODE" = "200" ] && ok "super sets budget 0 -> 200" || bad "set budget 0 -> $RESP_CODE"
req POST "/api/phases/$EXEC/generate" "$SUPER"
[ "$RESP_CODE" = "402" ] && ok "generate over budget -> 402 (hard block, no tokens)" || bad "over-budget generate -> $RESP_CODE (expected 402)"

# --- clear budget (null = unlimited) ---------------------------------------
req PATCH "/api/projects/$PID/budget" "$OWNER" '{"budgetUsd":null}'
[ "$RESP_CODE" = "200" ] && [ "$(jget "['budgetUsd']")" = "None" ] \
  && ok "clear budget (null) -> 200, unlimited" || bad "clear budget -> $RESP_CODE / $(jget "['budgetUsd']")"

# --- optional: real generate accumulates spend -----------------------------
if [ "$GEN_TEST" = "1" ]; then
  req POST "/api/phases/$EXEC/generate" "$SUPER"
  if [ "$RESP_CODE" = "200" ]; then
    ok "real generate -> 200"
    [ -n "$(jget "['costUsd']")" ] && [ "$(jget "['costUsd']")" != "None" ] && ok "run costUsd recorded" || bad "costUsd not set"
    req GET "/api/projects/$PID" "$OWNER"
    python3 -c "import sys,json;exit(0 if json.load(sys.stdin)['spentUsd']>0 else 1)" <<<"$RESP_BODY" 2>/dev/null \
      && ok "project spentUsd accumulated > 0" || bad "spentUsd did not accumulate"
  elif [ "$RESP_CODE" = "503" ]; then
    skip "real generate (no ANTHROPIC_API_KEY on this host)"
  else
    bad "real generate -> $RESP_CODE (expected 200 or 503)"
  fi
else
  skip "real generate spend accounting (set GEN_TEST=1; spends Claude tokens)"
fi

echo "============================================================"
echo "Total: $((PASS+FAIL))  |  Passed: ${PASS}  |  Failed: ${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
