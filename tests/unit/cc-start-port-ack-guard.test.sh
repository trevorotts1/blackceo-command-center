#!/usr/bin/env bash
#
# cc-start-port-ack-guard.test.sh — P1-02 Unit B, item 4: the non-4000 drift
# ACK guard in scripts/cc-start.sh.
#
# THE INVARIANT UNDER TEST: cc-start.sh must never silently start the CC on a
# port other than the canonical 4000 (P1-02: "port 4000 is the universal
# decision"). If CC_PORT resolves (via --port flag or the CC_PORT env var) to
# anything other than 4000, the launcher must:
#   1. Print a LOUD warning that names the SOURCE of the drift (CLI flag vs
#      env var) and quotes the drifted value.
#   2. Refuse to start (exit non-zero) unless CC_PORT_OVERRIDE_ACK=1 is set.
#   3. Refuse BEFORE the orphan-port killer runs — no side effects (killing
#      whatever is listening on an arbitrary port) from a start that is about
#      to be refused anyway.
#   4. When CC_PORT_OVERRIDE_ACK=1 IS set, log the deliberate override and
#      proceed past the guard (it may still exit non-zero later for unrelated
#      reasons — e.g. no compiled build in a throwaway checkout — that is
#      expected and out of scope; only the GUARD's own behaviour is tested).
#   5. Never fire at all when CC_PORT resolves to the canonical 4000.
#
# FAIL-FIRST: run this against a pre-P1-02 tree (no ACK guard in
# cc-start.sh) and every assertion in Tests 1-3 fails — no warning is ever
# printed and the script proceeds straight past to the orphan-port killer
# regardless of port. Post-fix, all assertions pass.
#
# Wireable into CI (qc-cc): `bash tests/unit/cc-start-port-ack-guard.test.sh`.

set -uo pipefail  # deliberately NOT -e: several invocations below are expected to exit non-zero

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CC_START="$REPO_ROOT/scripts/cc-start.sh"

FAIL=0

pass() { printf '  PASS: %s\n' "$1"; }
fail() { printf '  FAIL: %s\n' "$1"; FAIL=1; }

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    pass "$label"
  else
    fail "$label (expected to find: $needle)"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    fail "$label (unexpectedly found: $needle)"
  else
    pass "$label"
  fi
}

if [[ ! -f "$CC_START" ]]; then
  echo "[cc-start-port-ack-guard] FAIL — $CC_START does not exist"
  exit 1
fi

echo "[cc-start-port-ack-guard] Test 1: CC_PORT=3000, no ACK -> must LOUD-refuse, exit non-zero, before orphan-port killer"
OUT1="$(cd "$REPO_ROOT" && CC_PORT=3000 CC_PORT_OVERRIDE_ACK= bash "$CC_START" 2>&1)"
CODE1=$?
if [[ "$CODE1" -eq 0 ]]; then
  fail "Test 1: cc-start.sh exited 0 with a non-canonical port and no ACK (must refuse)"
else
  pass "Test 1: cc-start.sh exited non-zero ($CODE1) as expected"
fi
assert_contains "$OUT1" "CC_PORT_OVERRIDE_ACK" "Test 1: warning names the CC_PORT_OVERRIDE_ACK escape hatch"
assert_contains "$OUT1" "3000" "Test 1: warning quotes the drifted port value"
assert_contains "$OUT1" "CC_PORT environment variable" "Test 1: warning names the env var as the drift source"
assert_not_contains "$OUT1" "ORPHAN-PORT KILLER" "Test 1: refuses BEFORE the orphan-port killer runs (no side effects)"

echo "[cc-start-port-ack-guard] Test 2: --port 3000 (CLI flag), no ACK -> source attribution names the CLI flag"
OUT2="$(cd "$REPO_ROOT" && CC_PORT_OVERRIDE_ACK= bash "$CC_START" --port 3000 2>&1)"
assert_contains "$OUT2" "--port CLI flag" "Test 2: warning names the CLI flag as the drift source"
assert_not_contains "$OUT2" "ORPHAN-PORT KILLER" "Test 2: refuses BEFORE the orphan-port killer runs"

echo "[cc-start-port-ack-guard] Test 3: CC_PORT=3000 WITH CC_PORT_OVERRIDE_ACK=1 -> guard does not refuse"
OUT3="$(cd "$REPO_ROOT" && CC_PORT=3000 CC_PORT_OVERRIDE_ACK=1 bash "$CC_START" 2>&1)"
assert_not_contains "$OUT3" "FATAL: refusing to start on a non-canonical port" "Test 3: ACK'd override does not trip the refusal"
assert_contains "$OUT3" "CC_PORT_OVERRIDE_ACK=1 set" "Test 3: guard logs the deliberate override"

echo "[cc-start-port-ack-guard] Test 4: CC_PORT unset (canonical default 4000) -> guard never fires"
OUT4="$(cd "$REPO_ROOT" && CC_PORT_OVERRIDE_ACK= bash "$CC_START" 2>&1)"
assert_not_contains "$OUT4" "NOT the canonical port 4000" "Test 4: default port 4000 never trips the drift warning"

if [[ "$FAIL" -eq 0 ]]; then
  echo "[cc-start-port-ack-guard] PASS — all assertions held"
  exit 0
else
  echo "[cc-start-port-ack-guard] FAIL — see above"
  exit 1
fi
