#!/usr/bin/env bash
# The app refusing its own loopback probe with 403 {"error":"unregistered_hostname"}
# is a deterministic fault (no tenant registry / public URL for this
# installation), never "verified nothing". Measured 2026-09-18: two VPS boxes
# and a Mac cycled 36 UNKNOWN health attempts with the 403 wall live.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }
F=scripts/cc-health-check.sh
grep -q 'PROBE_CODE" == "403" ]] && printf' "$F" && ok "the gated-page probe inspects its HTTP code" || bad "probe does not inspect the HTTP code"
grep -q "grep -q 'unregistered_hostname'" "$F" && ok "the 403 body is matched on unregistered_hostname" || bad "403 body is not matched"
awk '/PROBE_CODE" == "403"/{f=1} f&&/ASSET_PASS="fail"/{print "RED"; exit}' "$F" | grep -q RED && ok "a tenant wall is scored RED (ASSET_PASS=fail), not UNKNOWN" || bad "tenant wall is not scored RED"
grep -q 'row 33: TENANT WALL' "$F" && ok "the row is labelled TENANT WALL with a remedy" || bad "no TENANT WALL label"
grep -q 'ASSET_INDET=true' "$F" && ok "a genuinely empty page (no asset ref, no 403) is still UNKNOWN" || bad "empty-page UNKNOWN path removed"
printf 'x' | grep -q 'y' || ok "control: grep -q distinguishes a miss"
printf '[cc-health-check-tenant-wall] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
