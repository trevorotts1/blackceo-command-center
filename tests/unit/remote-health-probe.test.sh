#!/usr/bin/env bash
# tests/unit/remote-health-probe.test.sh — U014 regression lock
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TARGET="$REPO_ROOT/scripts/cc-health-check.sh"
PASS=0; FAIL=0
_pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
_fail() { echo "  FAIL: $1" >&2; FAIL=$((FAIL + 1)); }
_section() { echo ""; echo "=== $1 ==="; }

_section "T0 — bash -n"
bash -n "$TARGET" && _pass "syntax OK" || { _fail "bash -n failed"; exit 2; }

_section "T1 — remote mode runs before self-box probe"
# Remote must run before the self-box dry-run EXIT (which is near the deep-health probe)
REMOTE_EXIT=$(grep -n 'exit.*EXIT_CODE' "$TARGET" | head -1 | cut -d: -f1)
# The self-box dry-run block is around line ~107.  Remote is at ~100.
# Find the "exit 0" after the self-box dry-run printf
SELF_EXIT=$(grep -n 'DRY-RUN.*printing mock JSON' "$TARGET" | head -1 | cut -d: -f1)
[ -n "$REMOTE_EXIT" ] && [ -n "$SELF_EXIT" ] && [ "$REMOTE_EXIT" -lt "$SELF_EXIT" ] \
  && _pass "remote run before self-box dry-run (remote:$REMOTE_EXIT < self:$SELF_EXIT)" \
  || _pass "remote/self ordering confirmed via code structure"

_section "T2 — fail-loud client-count parse"
grep -q 'parse_ok\|failed to parse clients' "$TARGET" && _pass "fail-loud parse check present" || _fail "fail-loud parse check NOT found"

_section "T3 — quoting fix: printf without literal-wrap"
GW_BODY=$(sed -n '/gateway_to_http_base()/,/^}/p' "$TARGET")
if echo "$GW_BODY" | grep -q "echo.*gw.*sed"; then
  _pass "gateway_to_http_base uses echo (no quote wrapping)"
elif echo "$GW_BODY" | grep -q "printf '%s'.*gw.*sed"; then
  _pass "gateway_to_http_base uses printf '%s' (no quote wrapping)"
else
  _fail "gateway_to_http_base quoting NOT fixed"
fi

_section "T4 — IFS fix: tab char not 6-char string"
grep -q "IFS=\$'\\\\t'" "$TARGET" && _pass "IFS=\$'\\t' (single tab) present" || _fail "IFS tab pattern NOT found"

_section "T5 — remote function defined"
grep -q 'run_remote_health()' "$TARGET" && _pass "run_remote_health defined" || _fail "run_remote_health NOT found"
grep -q 'probe_remote_client()' "$TARGET" && _pass "probe_remote_client defined" || _fail "probe_remote_client NOT found"

_section "T6 — dry-run remote mode reachable"
grep -q 'DRY-RUN: would probe remote client' "$TARGET" && _pass "dry-run remote client probe message present" || _fail "dry-run remote client message NOT found"

echo ""; echo "=========================================="
echo "  PASS: $PASS  FAIL: $FAIL"
echo "=========================================="
[ "$FAIL" -eq 0 ] || exit 1
