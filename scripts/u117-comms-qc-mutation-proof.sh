#!/usr/bin/env bash
#
# u117-comms-qc-mutation-proof.sh — U117 (E6-3/G9) CC leg, BINARY acceptance
# (e): "the CI conformance guard FAILS on a scratch-branch mutation ...
# then passes when restored (mutation proof)."
#
# WHAT THIS PROVES: `tests/unit/u117-e6-3-comms-qc-conformance.test.ts` is a
# REAL guard, not decoration. A test suite that passes on both the guarded
# and the un-guarded code proves nothing (it would pass even if the gate in
# src/lib/qc-scorer.ts were deleted). This script:
#   1. Backs up src/lib/qc-scorer.ts.
#   2. Applies a literal, single-line mutation that neuters the U117
#      comms-conformance gate condition (mirrors the ONB leg's own
#      `u117-comms-qc-guard.test.sh` pattern: seed a real mutation, prove
#      the guard fails, restore, prove it passes again).
#   3. Runs the comms-conformance test file — MUST exit non-zero (the
#      mutated tree can no longer block a comms-conformance FAIL, so the
#      [U117-d] and [U117-coexist] assertions must fail).
#   4. Restores the original file byte-for-byte.
#   5. Re-runs the same test file — MUST exit zero (green again).
# Exits 0 only when steps 3 AND 5 behaved exactly as expected; exits 1 (and
# ALWAYS restores the file first) on any deviation.
#
# Run from the repo root. Requires `npm ci` to have already populated
# node_modules (same precondition as `npm run test:unit`).

set -u  # NOT -e — we need to inspect exit codes ourselves and always restore

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET="src/lib/qc-scorer.ts"
TEST_FILE="tests/unit/u117-e6-3-comms-qc-conformance.test.ts"
BACKUP="$(mktemp)"

red()   { printf "\033[31m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
blue()  { printf "\033[34m%s\033[0m\n" "$1"; }

cleanup_restore() {
  if [ -f "$BACKUP" ]; then
    cp "$BACKUP" "$TARGET"
    rm -f "$BACKUP"
  fi
}
trap cleanup_restore EXIT

if [ ! -f "$TARGET" ]; then
  red "FAIL: $TARGET not found"
  exit 1
fi
if [ ! -f "$TEST_FILE" ]; then
  red "FAIL: $TEST_FILE not found"
  exit 1
fi

cp "$TARGET" "$BACKUP"

blue "── Step 1/4: applying the mutation (neuter the U117 comms-conformance gate) ──"
python3 - "$TARGET" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    content = f.read()
anchor = (
    "      if (\n"
    "        isCommsQcConformanceEnabled() &&\n"
    "        result.pass &&\n"
    "        producerScorecard.commsQcPassed === false\n"
    "      ) {"
)
count = content.count(anchor)
if count != 1:
    print(f"MUTATION-ANCHOR-ERROR: expected exactly 1 occurrence of the U117 gate "
          f"condition in {path}, found {count}. The gate's source shape has "
          f"drifted — update this script's anchor string to match.", file=sys.stderr)
    sys.exit(2)
mutated = content.replace(
    anchor,
    anchor.replace("isCommsQcConformanceEnabled() &&", "false && isCommsQcConformanceEnabled() &&"),
)
with open(path, "w", encoding="utf-8") as f:
    f.write(mutated)
print("Mutation applied: U117 gate condition short-circuited to `false &&`.")
PYEOF
MUTATE_RC=$?
if [ "$MUTATE_RC" -ne 0 ]; then
  red "FAIL: could not apply the mutation (anchor drift or I/O error, rc=$MUTATE_RC)"
  exit 1
fi

blue "── Step 2/4: running the guard test against the MUTATED tree (must FAIL) ──"
if NODE_ENV=test node --import tsx --import ./tests/setup/no-owner-telegram.ts --test "$TEST_FILE" >/tmp/u117-mutation-proof-mutated.log 2>&1; then
  red "FAIL: the guard test PASSED on a tree with the U117 comms-conformance gate neutered."
  red "      This means the test suite would not catch a real regression that deletes the"
  red "      gate — it is decoration, not a guard. See /tmp/u117-mutation-proof-mutated.log"
  tail -40 /tmp/u117-mutation-proof-mutated.log
  exit 1
fi
green "OK: guard test correctly FAILED on the mutated tree (gate proven load-bearing)."

blue "── Step 3/4: restoring the original file ──"
cp "$BACKUP" "$TARGET"

blue "── Step 4/4: running the guard test against the RESTORED tree (must PASS) ──"
if ! NODE_ENV=test node --import tsx --import ./tests/setup/no-owner-telegram.ts --test "$TEST_FILE" >/tmp/u117-mutation-proof-restored.log 2>&1; then
  red "FAIL: the guard test did NOT pass after restoring the original file."
  red "      Restore may be incomplete, or the test itself is flaky. See /tmp/u117-mutation-proof-restored.log"
  tail -60 /tmp/u117-mutation-proof-restored.log
  exit 1
fi
green "OK: guard test correctly PASSED again on the restored tree."

green ""
green "U117 (E6-3/G9) mutation proof PASSED: mutated=FAIL, restored=PASS."
exit 0
