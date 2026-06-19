#!/usr/bin/env bash
#
# QA smoke test for the VDT Platform frontend (nginx container).
# Run on the deploy host AFTER `docker compose up --build -d`.
#
# Verifies the SPA is served, client-side routing falls back to index.html,
# security headers are present, and the /api + /health proxy reaches the
# backend container. Uses only unauthenticated probes (a 401 from /api proves
# the proxy + backend auth are wired) so it needs no credentials.
#
# Usage:
#   ./qa/smoke-frontend.sh                 # defaults to http://localhost:8080
#   BASE_URL=http://pi.local:8080 ./qa/smoke-frontend.sh
#
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
PASS=0
FAIL=0

ok()   { echo "  ✅ PASS — $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ FAIL — $1"; FAIL=$((FAIL+1)); }

echo "QA smoke — frontend @ ${BASE_URL}"
echo "------------------------------------------------------------"

# 1. SPA root returns 200 and the mount div.
body="$(curl -fsS "${BASE_URL}/" 2>/dev/null)"
code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/")"
[ "$code" = "200" ] && ok "GET / -> 200" || bad "GET / -> $code (expected 200)"
echo "$body" | grep -q '<div id="root">' && ok "index.html has #root mount" || bad "index.html missing #root"

# 2. SPA fallback — a deep client route returns index.html, not 404.
code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/projects/does-not-exist")"
fb="$(curl -fsS "${BASE_URL}/projects/does-not-exist" 2>/dev/null)"
[ "$code" = "200" ] && ok "deep route -> 200 (SPA fallback)" || bad "deep route -> $code (expected 200)"
echo "$fb" | grep -q '<div id="root">' && ok "deep route serves index.html" || bad "deep route did not serve SPA shell"

# 3. Security headers on the SPA edge.
hdr="$(curl -fsSI "${BASE_URL}/" 2>/dev/null | tr -d '\r')"
echo "$hdr" | grep -qi '^X-Content-Type-Options: nosniff' && ok "X-Content-Type-Options: nosniff" || bad "missing X-Content-Type-Options"
echo "$hdr" | grep -qi '^X-Frame-Options: DENY' && ok "X-Frame-Options: DENY" || bad "missing X-Frame-Options"
echo "$hdr" | grep -qi '^Content-Security-Policy:' && ok "Content-Security-Policy present" || bad "missing CSP"
echo "$hdr" | grep -qi '^Referrer-Policy:' && ok "Referrer-Policy present" || bad "missing Referrer-Policy"

# 4. Static asset is long-cached.
asset="$(echo "$body" | grep -oE '/assets/index-[^"]+\.js' | head -1)"
if [ -n "$asset" ]; then
  ah="$(curl -fsSI "${BASE_URL}${asset}" 2>/dev/null | tr -d '\r')"
  echo "$ah" | grep -qiE '^HTTP/.* 200' && ok "asset ${asset} -> 200" || bad "asset ${asset} not 200"
  echo "$ah" | grep -qi 'Cache-Control: .*immutable' && ok "asset is immutable-cached" || bad "asset missing immutable cache header"
else
  bad "could not find hashed JS asset in index.html"
fi

# 5. /health proxied to backend.
hbody="$(curl -fsS "${BASE_URL}/health" 2>/dev/null)"
echo "$hbody" | grep -q '"status":"ok"' && ok "/health proxied -> {status:ok}" || bad "/health proxy failed (got: ${hbody:-<empty>})"

# 6. /api proxied to backend — protected route without a token returns 401.
code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL}/api/projects")"
[ "$code" = "401" ] && ok "GET /api/projects (no token) -> 401 (proxy + auth)" || bad "GET /api/projects -> $code (expected 401)"

# 7. /api proxied — bad login returns 401 from the backend.
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE_URL}/api/auth/login" \
  -H 'Content-Type: application/json' -d '{"email":"nobody@example.com","password":"wrongpass"}')"
[ "$code" = "401" ] && ok "POST /api/auth/login (bad creds) -> 401" || bad "login probe -> $code (expected 401)"

echo "------------------------------------------------------------"
echo "Total: $((PASS+FAIL))  |  Passed: ${PASS}  |  Failed: ${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
