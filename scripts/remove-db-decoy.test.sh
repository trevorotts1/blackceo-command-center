#!/bin/bash
#
# remove-db-decoy.test.sh — U026 verification.
#
# Tests scripts/remove-db-decoy.sh: it removes the 0-byte mission-control.db
# DECOY at the command-center root, never the real data/mission-control.db, and
# never a non-empty root-level mission-control.db.
#
# Usage:
#   bash scripts/remove-db-decoy.test.sh
#
# Pass criteria (all must hold):
#   1. bash -n scripts/remove-db-decoy.sh passes (AC#4).
#   2. AC#1: a 0-byte mission-control.db at the root is removed.
#   3. AC#2 (safety): a NON-zero mission-control.db at the root is NOT removed.
#   4. AC#2: the real data/mission-control.db is NEVER removed.
#   5. AC#3: idempotent — decoy already gone -> does nothing, exit 0.
#   6. --dry-run reports but removes nothing.
#
# MUTATION PROOF (verified during development): replacing the non-empty guard
# `[ -s "$DECOY" ]` with `[ ! -s "$DECOY" ]` (i.e. removing the safety check)
# makes test 3 FAIL (RED); reverting restores GREEN. The safety test therefore
# genuinely guards the "never remove a non-empty DB" invariant.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/remove-db-decoy.sh"

pass() { echo "[PASS] $*"; }
fail() { echo "[FAIL] $*" >&2; exit 1; }

# ─── GUARD 1: bash -n (AC#4) ─────────────────────────────────────────────────
bash -n "$SCRIPT" || fail "bash -n remove-db-decoy.sh failed (AC#4)"
pass "bash -n remove-db-decoy.sh passes (AC#4)"

# ─── Hermetic fixture: a fake command-center root ────────────────────────────
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/data"

# ─── AC#1: a 0-byte decoy at the root is removed ─────────────────────────────
: > "$TMP_ROOT/mission-control.db"          # 0-byte decoy
echo "REAL-DATABASE-CONTENTS" > "$TMP_ROOT/data/mission-control.db"   # real DB
CC_APP_DIR="$TMP_ROOT" "$SCRIPT" >/dev/null
[ ! -e "$TMP_ROOT/mission-control.db" ] || fail "AC#1: 0-byte decoy must be removed"
pass "AC#1: 0-byte mission-control.db at root is removed"

# ─── AC#2: the real data/mission-control.db is NEVER removed ─────────────────
[ -f "$TMP_ROOT/data/mission-control.db" ] || fail "AC#2: real DB must NOT be removed"
[ "$(cat "$TMP_ROOT/data/mission-control.db")" = "REAL-DATABASE-CONTENTS" ] \
  || fail "AC#2: real DB contents must be intact"
pass "AC#2: real data/mission-control.db is never removed (contents intact)"

# ─── AC#2 (safety): a NON-zero root-level mission-control.db is NOT removed ──
echo "SOME-REAL-LOOKING-DATA" > "$TMP_ROOT/mission-control.db"   # non-empty
CC_APP_DIR="$TMP_ROOT" "$SCRIPT" >/dev/null
[ -f "$TMP_ROOT/mission-control.db" ] || fail "AC#2: a NON-zero root mission-control.db must NOT be removed"
[ "$(cat "$TMP_ROOT/mission-control.db")" = "SOME-REAL-LOOKING-DATA" ] \
  || fail "AC#2: non-zero root DB contents must be intact"
pass "AC#2 (safety): non-zero root mission-control.db is NOT removed"

# ─── AC#3: idempotent — decoy already gone -> does nothing, exit 0 ───────────
rm -f "$TMP_ROOT/mission-control.db"
rc=0
out="$(CC_APP_DIR="$TMP_ROOT" "$SCRIPT" 2>&1)" || rc=$?
[ "$rc" -eq 0 ] || fail "AC#3: idempotent run must exit 0, got $rc"
echo "$out" | grep -qi "nothing to do" || fail "AC#3: idempotent run must report nothing to do, got: $out"
pass "AC#3: idempotent — decoy already gone does nothing (exit 0)"

# ─── --dry-run reports but removes nothing ───────────────────────────────────
: > "$TMP_ROOT/mission-control.db"          # 0-byte decoy again
rc=0
out="$(CC_APP_DIR="$TMP_ROOT" "$SCRIPT" --dry-run 2>&1)" || rc=$?
[ "$rc" -eq 0 ] || fail "--dry-run must exit 0, got $rc"
[ -f "$TMP_ROOT/mission-control.db" ] || fail "--dry-run must NOT remove the decoy"
echo "$out" | grep -qi "DRY-RUN" || fail "--dry-run must announce DRY-RUN, got: $out"
pass "--dry-run reports but removes nothing"

echo ""
echo "All U026 tests passed."
