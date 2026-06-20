#!/usr/bin/env bash
#
# QA smoke test for Frontend FE-DOC-1 (attachment UI).
#
# FE-DOC-1 adds NO backend code — it binds the existing BE-DOC-1 attachment
# endpoints to the UI. This script verifies the exact API contract the new UI
# performs, plus (optionally) that the frontend still type-checks and builds.
#
# Two parts:
#   A. Build artifacts (optional, needs node/npm in frontend/) — tsc strict +
#      vite build succeed and emit dist/. Skipped automatically off-toolchain.
#   B. API contract behind the UI (needs the backend running):
#      - StartPhaseCard sequence: start a phase -> multipart upload to the NEW
#        run id (field "files") -> 201; list reflects it; delete -> 204.
#      - AttachmentsPanel "editable" rule: uploading once a run is APPROVED
#        (closed) -> 409, which is exactly when the UI hides the add/remove
#        controls.
#      - response never leaks file bytes (the UI only ever sees metadata).
#
# No Claude tokens are spent.
#
# Usage (run on the Pi, repo root, backend running):
#   bash qa/smoke-fe-doc1.sh
#   BASE=http://192.168.1.13:4000 bash qa/smoke-fe-doc1.sh
#   SKIP_BUILD=1 bash qa/smoke-fe-doc1.sh    # API contract only
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
ok()   { echo "  ✅ PASS — $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ FAIL — $1"; FAIL=$((FAIL+1)); }
skip() { echo "  ⏭️  SKIP — $1"; }
jget() { printf '%s' "$RESP_BODY" | python3 -c "import sys,json;print(json.load(sys.stdin)$1)" 2>/dev/null; }

req() {  # METHOD PATH TOKEN [JSON_BODY]
  local method=$1 path=$2 token=$3 body=${4:-}
  local args=(-s -w $'\n%{http_code}' -X "$method" "$BASE$path" -H 'Content-Type: application/json')
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-d "$body")
  local out; out=$(curl "${args[@]}")
  RESP_CODE=$(printf '%s' "$out" | tail -n1); RESP_BODY=$(printf '%s' "$out" | sed '$d')
}

# upload mirrors what the browser does: multipart, field name "files", and NO
# explicit Content-Type (curl/browser set the boundary) — same as api.ts.
upload() {  # PATH TOKEN FILE...
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

echo "QA smoke — FE-DOC-1 attachment UI @ ${BASE}"
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
echo "Part B — API contract behind the UI"
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
[ -n "$SUPER" ] && ok "login super@ (SUPER_ADMIN)" || bad "login super@"

# StartPhaseCard sequence: create the project + run, THEN attach to the run id.
req POST /api/projects "$OWNER" '{"name":"FE-DOC1 Smoke","track":"FULL_SDLC"}'
PID="$(jget "['id']")"
req POST "/api/projects/$PID/phases" "$SUPER" '{"phaseType":"PLANNER","input":"context"}'
EXEC="$(jget "['id']")"
[ "$(jget "['status']")" = "IN_PROGRESS" ] && ok "started PLANNER run (IN_PROGRESS)" || bad "could not start an open run"

printf 'SRS: build a todo API with CRUD endpoints.' > "$TMP/spec.txt"
printf 'col1,col2\n1,2\n'                            > "$TMP/data.csv"

# config endpoint the FE reads for limits + accepted types (no auth needed)
req GET /api/config ""
[ "$RESP_CODE" = "200" ] && ok "GET /api/config -> 200" || bad "config -> $RESP_CODE (expected 200)"
[ -n "$(jget "['attachments']['maxFileMb']")" ] && ok "config exposes attachments.maxFileMb" || bad "config missing maxFileMb"
printf '%s' "$RESP_BODY" | python3 -c 'import sys,json;a=json.load(sys.stdin)["attachments"];exit(0 if ".pdf" in a["acceptedExtensions"] else 1)' 2>/dev/null \
  && ok "config acceptedExtensions includes .pdf" || bad "config acceptedExtensions missing .pdf"

# upload-on-start: the two staged files attach to the freshly created run
upload "/api/phases/$EXEC/attachments" "$SUPER" "$TMP/spec.txt" "$TMP/data.csv"
[ "$RESP_CODE" = "201" ] && ok "upload to new run (multipart 'files') -> 201" || bad "upload -> $RESP_CODE (expected 201)"
CNT="$(printf '%s' "$RESP_BODY" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null)"
[ "$CNT" = "2" ] && ok "response lists 2 attachments" || bad "expected 2, got $CNT"
printf '%s' "$RESP_BODY" | grep -q '"data"' && bad "response leaked file bytes" || ok "metadata only (no bytes) — UI never sees data"
ATT_ID="$(printf '%s' "$RESP_BODY" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])' 2>/dev/null)"

# project detail now embeds attachment metadata per run (no extra per-card GET)
req GET "/api/projects/$PID" "$OWNER"
printf '%s' "$RESP_BODY" | python3 -c '
import sys,json
p=json.load(sys.stdin)
ex=next((e for e in p["executions"] if e["id"]=="'"$EXEC"'"), None)
atts=(ex or {}).get("attachments")
ok = isinstance(atts,list) and len(atts)==2 and all("data" not in a for a in atts)
exit(0 if ok else 1)' 2>/dev/null \
  && ok "project detail embeds 2 attachments (metadata only)" || bad "project detail did not embed attachment metadata"

# AttachmentsPanel list-on-mount
req GET "/api/phases/$EXEC/attachments" "$SUPER"
[ "$RESP_CODE" = "200" ] && ok "list (panel mount) -> 200" || bad "list -> $RESP_CODE"

# AttachmentsPanel add-more while the run is still open
upload "/api/phases/$EXEC/attachments" "$SUPER" "$TMP/data.csv"
[ "$RESP_CODE" = "201" ] && ok "add another file on open run -> 201" || bad "add-more -> $RESP_CODE (expected 201)"

# AttachmentsPanel delete
req DELETE "/api/phases/$EXEC/attachments/$ATT_ID" "$SUPER"
[ "$RESP_CODE" = "204" ] && ok "delete attachment -> 204" || bad "delete -> $RESP_CODE (expected 204)"

# editable rule: once the run is APPROVED the UI hides add/remove — backend 409s
req POST "/api/phases/$EXEC/output" "$SUPER" '{"output":"scope"}'    # -> AWAITING_REVIEW
req POST "/api/phases/$EXEC/review" "$OWNER" '{"action":"APPROVE"}'  # -> APPROVED
upload "/api/phases/$EXEC/attachments" "$SUPER" "$TMP/spec.txt"
[ "$RESP_CODE" = "409" ] && ok "upload on approved run -> 409 (panel read-only)" || bad "closed-run upload -> $RESP_CODE (expected 409)"
# list still works on a closed run (reviewer can see what the AI read)
req GET "/api/phases/$EXEC/attachments" "$SUPER"
[ "$RESP_CODE" = "200" ] && ok "list still readable on closed run -> 200" || bad "closed-run list -> $RESP_CODE"

echo "============================================================"
echo "Total: $((PASS+FAIL))  |  Passed: ${PASS}  |  Failed: ${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
