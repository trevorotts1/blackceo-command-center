#!/usr/bin/env bash
# ============================================================
#  Tests for remove-decoy-mission-control-db.sh -- U026
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLEANUP="$SCRIPT_DIR/remove-decoy-mission-control-db.sh"
PASS=0
FAIL=0
TMPDIR=""

cleanup() { [ -n "${TMPDIR:-}" ] && rm -rf "$TMPDIR"; }
trap cleanup EXIT

TMPDIR="$(mktemp -d)"

assert_removed() {
  if [ -f "$TMPDIR/mission-control.db" ]; then
    echo "FAIL: $1 -- file still exists"
    FAIL=$((FAIL + 1))
  else
    echo "PASS: $1"
    PASS=$((PASS + 1))
  fi
}

assert_exists() {
  if [ -f "$TMPDIR/mission-control.db" ]; then
    echo "PASS: $1"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $1 -- file was removed but should NOT have been"
    FAIL=$((FAIL + 1))
  fi
}

echo "--- Test 1: 0-byte decoy removal ---"
touch "$TMPDIR/mission-control.db"
bash "$CLEANUP" "$TMPDIR"
assert_removed "0-byte decoy should be removed"

echo "--- Test 2: Non-zero file safety ---"
echo "real db content" > "$TMPDIR/mission-control.db"
bash "$CLEANUP" "$TMPDIR"
assert_exists "Non-zero file should NOT be removed"

echo "--- Test 3: No decoy (idempotent) ---"
rm -f "$TMPDIR/mission-control.db"
bash "$CLEANUP" "$TMPDIR"
if [ ! -f "$TMPDIR/mission-control.db" ]; then
  echo "PASS: No file -- cleanup is idempotent (no error)"
  PASS=$((PASS + 1))
else
  echo "FAIL: No file -- unexpected file created"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "========== RESULTS =========="
echo "Passed: $PASS"
echo "Failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "SOME TESTS FAILED"
  exit 1
fi
echo "All tests passed."
