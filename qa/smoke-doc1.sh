#!/usr/bin/env bash
#
# QA smoke test for BE-DOC-1 (phase-run attachment upload API).
#
# Exercises the attachment endpoints and their guards:
#   upload  -> POST   /api/phases/:id/attachments   (multipart "files")
#   list    -> GET    /api/phases/:id/attachments
#   delete  -> DELETE /api/phases/:id/attachments/:attachmentId
#
# Covered: valid upload + list, unsupported type (415), oversized file (413),
# wrong-role upload (403), delete (204), and upload on a closed/approved run
# (409). No Claude tokens are spent (BE-DOC-1 only stores files; AI reading
# comes in BE-DOC-2).
#
# Usage (run on the Pi, repo root, backend running):
#   bash qa/smoke-doc1.sh
#   BASE=http://192.168.1.13:4000 bash qa/smoke-doc1.sh
#
# Seeds super@ -> SUPER_ADMIN, owner@ -> PROJECT_OWNER via qa/seed-roles.sql;
# target@codedebear.com stays OPERATION to prove the role guard.
set -uo pipefail

BASE="${BASE:-http://localhost:4000}"
PASSWORD="${PASSWORD:-changeme123}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$SCRIPT_DIR/..}"
SEED_SQL="$SCRIPT_DIR/seed-roles.sql"
SEED_MODE="${SEED_MODE:-auto}"
COMPOSE_SVC="${COMPOSE_SVC:-backend}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -z "${DATABASE_URL:-}" ] && [ -f "$REPO_DIR/.env" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$REPO_DIR/.env" | head -1 | cut -d= -f2-)"
fi
if [ "$SEED_MODE" = "auto" ]; then
  if command -v docker >/dev/null 2>&1; then SEED_MODE="docker"; else SEED_MODE="host"; fi
fi

PASS=0; FAIL=0
RESP_BODY=""; RESP_CODE=""
ok()  { echo "  ✅ PASS — $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ FAIL — $1"; FAIL=$((FAIL+1)); }
jget() { printf '%s' "$RESP_BODY" | python3 -c "import sys,json;print(json.load(sys.stdin)$1)" 2>/dev/null; }

req() {  # METHOD PATH TOKEN [JSON_BODY]
  local method=$1 path=$2 token=$3 body=${4:-}
  local args=(-s -w $'\n%{http_code}' -X "$method" "$BASE$path" -H 'Content-Type: application/json')
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-d "$body")
  local out; out=$(curl "${args[@]}")
  RESP_CODE=$(printf '%s' "$out" | tail -n1); RESP_BODY=$(printf '%s' "$out" | sed '$d')
}

upload() {  # PATH TOKEN FILE... -> sets RESP_CODE/RESP_BODY
  local path=$1 token=$2; shift 2
  local args=(-s -w $'\n%{http_code}' -X POST "$BASE$path" -H "Authorization: Bearer $token")
  for f in "$@"; do args+=(-F "files=@$f"); done
  local out; out=$(curl "${args[@]}")
  RESP_CODE=$(printf '%s' "$out" | tail -n1); RESP_BODY=$(printf '%s' "$out" | sed '$d')
}

auth_token() {
  local email=$1
  req POST /api/auth/register "" "{\"name\":\"${email%%@*}\",\"email\":\"$email\",\"password\":\"$PASSWORD\"}" >/dev/null 2>&1
  req POST /api/auth/login "" "{\"email\":\"$email\",\"password\":\"$PASSWORD\"}"
  jget "['token']"
}

echo "QA smoke — BE-DOC-1 attachments @ ${BASE}"
echo "------------------------------------------------------------"

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

# project + a PLANNER run to attach to
req POST /api/projects "$OWNER" '{"name":"DOC1 Smoke","track":"FULL_SDLC"}'
PID="$(jget "['id']")"
req POST "/api/projects/$PID/phases" "$SUPER" '{"phaseType":"PLANNER"}'
EXEC="$(jget "['id']")"
[ -n "$EXEC" ] && ok "started PLANNER run" || bad "could not start run"

# test files
printf 'SRS: build a todo API with CRUD endpoints.' > "$TMP/spec.txt"
printf 'col1,col2\n1,2\n'                            > "$TMP/data.csv"
printf 'PNGDATA'                                     > "$TMP/pic.png"
head -c $((11*1024*1024)) /dev/zero > "$TMP/big.pdf"   # 11MB > 10MB cap

# 1. valid upload (txt + csv)
upload "/api/phases/$EXEC/attachments" "$SUPER" "$TMP/spec.txt" "$TMP/data.csv"
[ "$RESP_CODE" = "201" ] && ok "upload txt+csv -> 201" || bad "upload -> $RESP_CODE (expected 201)"
CNT="$(printf '%s' "$RESP_BODY" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null)"
[ "$CNT" = "2" ] && ok "response lists 2 attachments" || bad "expected 2 attachments, got $CNT"
printf '%s' "$RESP_BODY" | grep -q '"data"' && bad "response leaked file bytes (data field)" || ok "response has no file bytes"
ATT_ID="$(printf '%s' "$RESP_BODY" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])' 2>/dev/null)"

# 2. list
req GET "/api/phases/$EXEC/attachments" "$SUPER"
[ "$RESP_CODE" = "200" ] && ok "list -> 200" || bad "list -> $RESP_CODE"

# 3. unsupported type
upload "/api/phases/$EXEC/attachments" "$SUPER" "$TMP/pic.png"
[ "$RESP_CODE" = "415" ] && ok "upload .png -> 415 (unsupported)" || bad "png -> $RESP_CODE (expected 415)"

# 4. oversized file
upload "/api/phases/$EXEC/attachments" "$SUPER" "$TMP/big.pdf"
[ "$RESP_CODE" = "413" ] && ok "upload 11MB -> 413 (too large)" || bad "oversized -> $RESP_CODE (expected 413)"

# 5. wrong role (OPERATION)
upload "/api/phases/$EXEC/attachments" "$TARGET" "$TMP/spec.txt"
[ "$RESP_CODE" = "403" ] && ok "OPERATION upload -> 403 (role guard)" || bad "OPERATION upload -> $RESP_CODE (expected 403)"

# 6. delete
req DELETE "/api/phases/$EXEC/attachments/$ATT_ID" "$SUPER"
[ "$RESP_CODE" = "204" ] && ok "delete attachment -> 204" || bad "delete -> $RESP_CODE (expected 204)"

# 7. upload on a closed (approved) run -> 409
req POST "/api/phases/$EXEC/output" "$SUPER" '{"output":"scope"}'   # -> AWAITING_REVIEW
req POST "/api/phases/$EXEC/review" "$OWNER" '{"action":"APPROVE"}' # -> APPROVED
upload "/api/phases/$EXEC/attachments" "$SUPER" "$TMP/spec.txt"
[ "$RESP_CODE" = "409" ] && ok "upload on approved run -> 409 (closed)" || bad "closed-run upload -> $RESP_CODE (expected 409)"

echo "------------------------------------------------------------"
echo "Total: $((PASS+FAIL))  |  Passed: ${PASS}  |  Failed: ${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
