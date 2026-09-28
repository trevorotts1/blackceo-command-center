#!/usr/bin/env bash
# Self-test for scripts/check-doc-number-drift.sh.
#
# Builds a throwaway fixture repo (a trimmed canonical-slug.ts, sop-authoring.ts,
# SOP-LAYERS.md, migrations.ts and QC.md) with a copy of the real script inside
# it. Proves a matched fixture PASSES, and each of the six drift shapes the
# script exists to catch (the canonical-slug.ts docstring, each of
# sop-authoring.ts's three counts, the SOP-LAYERS.md count, and the QC.md
# migration count/range) independently FAILS it — the mutation proof that
# stops this test from passing vacuously.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REAL_SCRIPT="$REPO_ROOT/scripts/check-doc-number-drift.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/scripts" "$TMP/src/lib/routing" "$TMP/src/lib" "$TMP/src/lib/db" "$TMP/docs"
cp "$REAL_SCRIPT" "$TMP/scripts/check-doc-number-drift.sh"

# A 3-entry CANONICAL_SLUGS fixture (small, but the script only counts quoted
# lines inside the Set literal, so this exercises the same extraction path).
write_canonical_slug() {
  local count="$1"
  cat > "$TMP/src/lib/routing/canonical-slug.ts" <<EOF
/**
 * Canonical set (ZHC ${count}-department model, +1 mandatory catch-all):
 */
export const CANONICAL_SLUGS = new Set([
  'marketing',
  'sales',
  'general-task',
]);
EOF
}

write_sop_authoring() {
  local a="$1" b="$2" c="$3"
  cat > "$TMP/src/lib/sop-authoring.ts" <<EOF
/**
 * ${a}-slug canonical ZHC set (i.e. it is a CUSTOM department), this module:
 *   (a) the department slug is in CANONICAL_SLUGS (${b} ZHC depts), OR
 */
export function isCanonicalContext() {
  return { canonical: true, reason: \`department "x" is in the ${c}-slug ZHC canonical set\` };
}
EOF
}

write_sop_layers() {
  local count="$1"
  cat > "$TMP/docs/SOP-LAYERS.md" <<EOF
## Layer 3b
- **Canonical departments (${count} ZHC slugs) → REFUSED.**
EOF
}

write_migrations() {
  # 3 entries, highest id 005 (mirrors the real file's non-contiguous ids).
  cat > "$TMP/src/lib/db/migrations.ts" <<'EOF'
export const MIGRATIONS = [
  { id: '001', name: 'a' },
  { id: '003', name: 'b' },
  { id: '005', name: 'c' },
];
EOF
}

write_qc() {
  local count="$1" max="$2"
  cat > "$TMP/QC.md" <<EOF
| **7**   | 1.5    | All migrations present (${count} entries spanning 001-${max}) |
EOF
}

reset_good_fixture() {
  write_canonical_slug 3
  write_sop_authoring 3 3 3
  write_sop_layers 3
  write_migrations
  write_qc 3 005
}

run_check() {
  (cd "$TMP" && bash scripts/check-doc-number-drift.sh) >"$TMP/out.log" 2>&1
}

pass=0
fail=0

expect_pass() {
  local name="$1"
  if run_check; then
    echo "PASS: $name"
    pass=$((pass + 1))
  else
    echo "FAIL (expected pass): $name"
    cat "$TMP/out.log"
    fail=$((fail + 1))
  fi
}

expect_fail() {
  local name="$1"
  if run_check; then
    echo "FAIL (expected failure, but check passed): $name"
    cat "$TMP/out.log"
    fail=$((fail + 1))
  else
    echo "PASS: $name correctly rejected"
    pass=$((pass + 1))
  fi
}

# 1. Everything in sync -> passes.
reset_good_fixture
expect_pass "all counts in sync"

# 2. canonical-slug.ts docstring drifts.
reset_good_fixture
write_canonical_slug 9
expect_fail "canonical-slug.ts docstring count drifted"

# 3. sop-authoring.ts header comment drifts.
reset_good_fixture
write_sop_authoring 9 3 3
expect_fail "sop-authoring.ts header comment count drifted"

# 4. sop-authoring.ts docblock count drifts.
reset_good_fixture
write_sop_authoring 3 9 3
expect_fail "sop-authoring.ts docblock count drifted"

# 5. sop-authoring.ts runtime reason-string count drifts.
reset_good_fixture
write_sop_authoring 3 3 9
expect_fail "sop-authoring.ts runtime reason string count drifted"

# 6. docs/SOP-LAYERS.md count drifts.
reset_good_fixture
write_sop_layers 9
expect_fail "docs/SOP-LAYERS.md count drifted"

# 7. QC.md migration count drifts (count wrong, range right).
reset_good_fixture
write_qc 9 005
expect_fail "QC.md migration entry count drifted"

# 8. QC.md migration range drifts (count right, max wrong).
reset_good_fixture
write_qc 3 009
expect_fail "QC.md migration range (highest id) drifted"

echo ""
echo "check-doc-number-drift.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
