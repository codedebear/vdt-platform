#!/usr/bin/env bash
# Smoke test for E-1 (edit project) and E-2 (delete project).
# Requires: a running backend at localhost:4000 with a seeded SUPER_ADMIN user.
# Usage: ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=secret bash qa/smoke-e1e2.sh
set -euo pipefail

BASE="http://localhost:4000"
EMAIL="${ADMIN_EMAIL:-admin@example.com}"
PASS="${ADMIN_PASSWORD:-password}"

echo "==> Waiting for backend..."
until curl -sf "$BASE/health" > /dev/null; do sleep 1; done

echo "==> Login"
TOKEN=$(curl -sf -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" | jq -r '.token')
AUTH="Authorization: Bearer $TOKEN"

echo "==> Create test project"
PROJ=$(curl -sf -X POST "$BASE/api/projects" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"name":"Smoke E1E2","track":"QA_ONLY"}')
ID=$(echo "$PROJ" | jq -r '.id')
echo "   Created: $ID"

echo "==> E-1: PATCH name + description"
UPDATED=$(curl -sf -X PATCH "$BASE/api/projects/$ID" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"name":"Smoke E1E2 Updated","description":"edit works"}')
echo "$UPDATED" | jq -r '"   name=\(.name) description=\(.description)"'

echo "==> E-2: DELETE project"
curl -sf -X DELETE "$BASE/api/projects/$ID" -H "$AUTH" -o /dev/null -w "   HTTP %{http_code}\n"

echo "==> Verify 404"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/projects/$ID" -H "$AUTH")
if [ "$STATUS" = "404" ]; then
  echo "   Got 404 as expected"
else
  echo "ERROR: expected 404, got $STATUS" && exit 1
fi

echo "==> All E-1/E-2 smoke checks passed"
