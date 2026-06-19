#!/usr/bin/env bash
#
# QA smoke test for VDT Platform Dev Sub-phase 4 (User Management API).
# Verifies the /api/users endpoints and their authorization + safety rules:
#   - only SUPER_ADMIN (USER_MANAGE) may list/get users or change roles
#   - responses never leak passwordHash
#   - an admin cannot change their own role (self-lockout guard)
#   - promote/demote works, including demoting a super admin while another remains
#
# Usage (run on the Pi, from the repo root, with the backend running):
#   bash qa/smoke-phase4.sh
#   BASE=http://192.168.1.13:4000 bash qa/smoke-phase4.sh
#
# Reuses qa/seed-roles.sql to promote super@ -> SUPER_ADMIN and owner@ ->
# PROJECT_OWNER. target@codedebear.com is intentionally NOT seeded, so it stays
# OPERATION and serves as the role-change target.
#
# Requires: curl, python3, and the backend's npx/prisma (ships with the repo).
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

# jget_id_by_email EMAIL -> echoes the id of the user with that email from an
# array response body (empty if not found).
jget_id_by_email() {
  printf '%s' "$RESP_BODY" | python3 -c "
import sys,json
email=sys.argv[1]
try:
    data=json.load(sys.stdin)
except Exception:
    sys.exit(0)
for u in data if isinstance(data,list) else []:
    if u.get('email')==email:
        print(u.get('id',''));break
" "$1" 2>/dev/null
}

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

check() {
  if [ "$2" = "$3" ]; then
    printf 'PASS  %-52s (%s)\n' "$1" "$3"
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %-52s (expected %s, got %s)\n' "$1" "$2" "$3"
    printf '      body: %s\n' "$RESP_BODY"
    FAIL=$((FAIL + 1))
  fi
}

register() {
  req POST /api/auth/register "" "{\"email\":\"$1\",\"password\":\"$PASSWORD\",\"name\":\"$2\"}"
}
login() {
  req POST /api/auth/login "" "{\"email\":\"$1\",\"password\":\"$PASSWORD\"}"
  jget "['token']"
}

echo "== VDT Platform QA — Sub-phase 4 (User Management) =="
echo "Base URL: $BASE"
echo

# --- 1. Register users (all OPERATION initially) ---
register super@codedebear.com  "Super Admin"
register owner@codedebear.com  "Owner One"
register op@codedebear.com     "Operations"
register target@codedebear.com "Role Target"
echo "registered users (idempotent)"

# --- 2. Promote super@ and owner@ via seed-roles.sql ---
seed_ok=false
if [ "$SEED_MODE" = "docker" ]; then
  if ( cd "$REPO_DIR" && docker compose exec -T "$COMPOSE_SVC" \
        npx prisma db execute --stdin --schema prisma/schema.prisma < "$SEED_SQL" ) ; then
    seed_ok=true
  fi
else
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "FAIL  host seed mode needs DATABASE_URL (not found in env or $REPO_DIR/.env)"; exit 1
  fi
  if ( cd "$REPO_DIR/backend" && npx prisma db execute --stdin --url "$DATABASE_URL" < "$SEED_SQL" ) ; then
    seed_ok=true
  fi
fi
[ "$seed_ok" = true ] && echo "promoted roles via seed-roles.sql (mode: $SEED_MODE)" \
  || { echo "FAIL  could not run seed-roles.sql (mode: $SEED_MODE)"; exit 1; }
echo

# --- 3. Login (JWT carries the seeded role) ---
T_SUPER=$(login super@codedebear.com)
T_OWNER=$(login owner@codedebear.com)
T_OP=$(login op@codedebear.com)
for t in "$T_SUPER" "$T_OWNER" "$T_OP"; do
  [ -z "$t" ] && { echo "A login failed — aborting."; exit 1; }
done

echo "-- Authorization boundaries --"
req GET /api/users "" ""
check "missing token -> 401" 401 "$RESP_CODE"

req GET /api/users "$T_OP" ""
check "OPERATION cannot list users" 403 "$RESP_CODE"

req GET /api/users "$T_OWNER" ""
check "PROJECT_OWNER cannot list users" 403 "$RESP_CODE"

req GET /api/users "$T_SUPER" ""
check "SUPER_ADMIN lists users" 200 "$RESP_CODE"
if printf '%s' "$RESP_BODY" | grep -q passwordHash; then
  check "response omits passwordHash" "absent" "present"
else
  check "response omits passwordHash" "absent" "absent"
fi

TARGET_ID=$(jget_id_by_email target@codedebear.com)
SUPER_ID=$(jget_id_by_email super@codedebear.com)
OWNER_ID=$(jget_id_by_email owner@codedebear.com)
[ -z "$TARGET_ID" ] && { echo "could not resolve target id — aborting."; exit 1; }

echo
echo "-- Get single user / not-found --"
req GET "/api/users/$TARGET_ID" "$T_SUPER" ""
check "SUPER gets a single user" 200 "$RESP_CODE"

req GET "/api/users/00000000-0000-0000-0000-000000000000" "$T_SUPER" ""
check "get missing user -> 404" 404 "$RESP_CODE"

echo
echo "-- Role changes --"
req PATCH "/api/users/$TARGET_ID/role" "$T_OP" '{"role":"QA"}'
check "OPERATION cannot change roles" 403 "$RESP_CODE"

req PATCH "/api/users/$TARGET_ID/role" "$T_SUPER" '{"role":"NOPE"}'
check "invalid role -> 422" 422 "$RESP_CODE"

req PATCH "/api/users/$TARGET_ID/role" "$T_SUPER" '{"role":"QA"}'
check "SUPER promotes target to QA" 200 "$RESP_CODE"
check "  -> role == QA" "QA" "$(jget "['role']")"

req PATCH "/api/users/$SUPER_ID/role" "$T_SUPER" '{"role":"OPERATION"}'
check "SUPER cannot change own role -> 409" 409 "$RESP_CODE"

echo
echo "-- Last-super-admin safety (promote then demote) --"
req PATCH "/api/users/$OWNER_ID/role" "$T_SUPER" '{"role":"SUPER_ADMIN"}'
check "promote owner -> SUPER_ADMIN" 200 "$RESP_CODE"
check "  -> role == SUPER_ADMIN" "SUPER_ADMIN" "$(jget "['role']")"

req PATCH "/api/users/$OWNER_ID/role" "$T_SUPER" '{"role":"PROJECT_OWNER"}'
check "demote a super admin while another remains" 200 "$RESP_CODE"
check "  -> role == PROJECT_OWNER" "PROJECT_OWNER" "$(jget "['role']")"

echo
echo "================ SUMMARY ================"
echo "PASSED: $PASS   FAILED: $FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL GREEN ✅" || echo "SOME TESTS FAILED ❌"
exit "$FAIL"
