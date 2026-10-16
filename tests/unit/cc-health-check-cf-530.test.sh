#!/usr/bin/env bash
# HTTP 530 from the public URL is Cloudflare's "no connector for this hostname"
# answer: a tunnel fault, never a build fault. It must be UNKNOWN (row 27), not
# FAIL. Measured 2026-09-18: a healthy 7.6.14 build was rolled back on a Mac
# whose tunnel was down, and the rollback then refused its pre-inventory build.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }
F=scripts/cc-health-check.sh
grep -q 'CF_HTTP" == "530" ]]; then CF_INDET=true' "$F" && ok "530 is scored UNKNOWN (CF_INDET=true)" || bad "530 is not scored UNKNOWN"
l530=$(grep -n 'CF_HTTP" == "530"' "$F" | cut -d: -f1); lelse=$(grep -n 'else CF_PASS="fail"; CF_DETAIL="CF public URL → HTTP ${CF_HTTP}: FAIL"' "$F" | cut -d: -f1)
[[ -n "$l530" && -n "$lelse" && "$l530" -lt "$lelse" ]] && ok "the 530 branch precedes the generic FAIL branch" || bad "530 branch ordering wrong (530=$l530 else=$lelse)"
grep -q 'CF_HTTP" == "000" ]]; then CF_INDET=true' "$F" && ok "000 (no answer) is still UNKNOWN" || bad "000 branch changed"
grep -q 'elif \[\[ "$CF_HTTP" == "200" \]\]; then CF_PASS="pass"' "$F" && ok "200 is still PASS" || bad "200 branch changed"
# a 5xx from the ORIGIN through Cloudflare (500/502/503) stays FAIL: no branch may match them as UNKNOWN
if grep -qE 'CF_HTTP" (==|=~) "?\^?5(0|\[)' "$F"; then bad "a generic 5xx UNKNOWN branch exists (origin errors must stay FAIL)"; else ok "origin 5xx answers still score FAIL"; fi
printf '[cc-health-check-cf-530] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
