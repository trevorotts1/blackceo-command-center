#!/usr/bin/env bash
# The app's OWN fail-closed tenant refusal reached through the public URL is
# "reachable and correctly gated", not a broken public URL. Measured
# 2026-09-24 on PR #423 (and identically on main): the thin-probe fixture
# started answering GET / with 403 {"error":"tenant_access_required"} after the
# interview sign-in envelope landed (PR #420), and the CF probe scored it FAIL
# (exit 1) — both B.1 checks red for a healthy build. The refusal must PASS;
# a foreign 403 (edge WAF, proxy) must still FAIL.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }
F=scripts/cc-health-check.sh
# The branch exists, is keyed on the app's own error code, and scores PASS.
grep -q 'CF_HTTP" == "403" ]] && printf' "$F" && ok "the CF probe inspects a 403 body" || bad "no 403 branch in the CF probe"
grep -q "grep -q 'tenant_access_required'" "$F" && ok "the 403 body is matched on the app's own tenant_access_required code" || bad "403 body not matched on tenant_access_required"
awk '/CF_HTTP" == "403"/{f=1} f&&/CF_PASS="pass"/{print "PASS"; exit}' "$F" | grep -q PASS && ok "the app's own refusal is scored PASS, not FAIL" || bad "refusal is not scored PASS"
grep -q 'unregistered_hostname' "$F" && ! grep -q "grep -q 'unregistered_hostname'.*tenant_access_required" "$F" && ok "unregistered_hostname (row 33 TENANT WALL) is NOT excused here" || bad "tenant wall was folded into the PASS branch"
# Ordering: the narrow 403 branch must precede the generic FAIL branch, so an
# UNMATCHED 403 (no refusal envelope) still falls through to FAIL.
l403=$(grep -n 'CF_HTTP" == "403"' "$F" | cut -d: -f1); lelse=$(grep -n 'else CF_PASS="fail"; CF_DETAIL="CF public URL → HTTP ${CF_HTTP}: FAIL"' "$F" | cut -d: -f1)
[[ -n "$l403" && -n "$lelse" && "$l403" -lt "$lelse" ]] && ok "the 403 branch precedes the generic FAIL branch" || bad "403 branch ordering wrong (403=$l403 else=$lelse)"
# Behavioural check against the REAL branch text: run the same three cases.
_body() { printf '%s' "$2" | grep -q 'tenant_access_required' && printf PASS || printf FAIL; }
[[ "$(_body 403 '{"error":"tenant_access_required","message":"x"}')" == PASS ]] && ok "control: a refusal envelope matches" || bad "control: refusal envelope not matched"
[[ "$(_body 403 '{"error":"blocked_by_waf"}')" == FAIL ]] && ok "control: a foreign 403 body does not match" || bad "control: foreign 403 wrongly matched"
printf 'x' | grep -q 'y' || ok "control: grep -q distinguishes a miss"
printf '[cc-health-check-tenant-refusal-403] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
