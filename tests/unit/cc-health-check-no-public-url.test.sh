#!/usr/bin/env bash
# An UNCONFIGURED public URL is a known state (row 27: N/A), never an
# indeterminate one. With CC_PUBLIC_URL unset the old code forced the whole
# verdict to UNKNOWN (exit 3): every deploy on a box without a public URL ended
# UNKNOWN and the box watchdog could never act. Measured 2026-09-18 on eight VPS
# boxes. A CONFIGURED but unreachable URL must still be UNKNOWN.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }
F=scripts/cc-health-check.sh
grep -q 'row 27: N/A' "$F" && ok "unset public URL is labelled N/A" || bad "unset public URL is not labelled N/A"
if grep -qE '^else CF_INDET=true; fi$' "$F"; then bad "the unset-URL branch still forces CF_INDET=true"; else ok "the unset-URL branch no longer forces CF_INDET=true"; fi
grep -q 'CF_HTTP" == "000" ]]; then CF_INDET=true' "$F" && ok "a configured but unreachable URL is still UNKNOWN" || bad "unreachable configured URL no longer UNKNOWN"
# Control: the removed pattern must be detectable by this test.
printf 'else CF_INDET=true; fi\n' | grep -qE '^else CF_INDET=true; fi$' && ok "control: the removed pattern is detectable" || bad "control: pattern not detectable"
printf '[cc-health-check-no-public-url] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
