#!/usr/bin/env bash
# A tenant-gated root (401/403 with the tenant-identity JSON) must send the
# outside-in asset probe to /interview, the lock-exempt shell that carries the
# /_next/static refs. Measured 2026-09-18: a healthy 7.6.17 VPS box sat UNKNOWN
# through 36 health attempts because GET / answered 403 instead of 302.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }
F=scripts/cc-health-check.sh
grep -q 'ROOT_CODE" == "401" || "$ROOT_CODE" == "403"' "$F" && ok "401/403 on / is recognised as a tenant-gated root" || bad "no 401/403 branch"
awk '/ROOT_CODE" == "401"/{f=1} f&&/PROBE_PATH="\/interview"/{print "OK"; exit}' "$F" | grep -q OK && ok "the probe moves to /interview" || bad "probe path not moved to /interview"
grep -q 'is_interview_gate_redirect "$ROOT_LOC" "$BASE_URL"' "$F" && ok "the same-origin 302 path is unchanged" || bad "302 path changed"
grep -q 'PROBE_CODE" == "403" ]] && printf' "$F" && ok "a 403 on the probed page itself is still the TENANT WALL (RED)" || bad "tenant wall branch missing"
printf '[cc-health-check-tenant-gated-root] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
