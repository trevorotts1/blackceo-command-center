#!/usr/bin/env bash
# Self-test for scripts/check-readme-current-release.sh.
#
# Builds a throwaway fixture repo (version + README.md) in a temp dir, with a
# copy of the real script inside it (the script locates its own repo root via
# BASH_SOURCE, so the copy must sit at fixture/scripts/). Proves both
# directions: a matched fixture PASSES, and each of the two drift shapes the
# script exists to catch (stale heading, stale highlights prose) independently
# FAILS it — the mutation proof that stops this test from passing vacuously.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REAL_SCRIPT="$REPO_ROOT/scripts/check-readme-current-release.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/scripts"
cp "$REAL_SCRIPT" "$TMP/scripts/check-readme-current-release.sh"

write_fixture() {
  local repo_ver="$1" header_ver="$2" prose_ver="$3"
  echo "$repo_ver" > "$TMP/version"
  cat > "$TMP/README.md" <<EOF
# Fixture

**Current release: ${header_ver} (2026-09-28)** — Some description.

## Historical release highlights

The highlights below describe earlier releases. The current release is ${prose_ver}; the complete history is in CHANGELOG.md.
EOF
}

run_check() {
  (cd "$TMP" && bash scripts/check-readme-current-release.sh) >"$TMP/out.log" 2>&1
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
write_fixture "v7.6.70" "v7.6.70" "v7.6.70"
expect_pass "both markers in sync"

# 2. Stale "**Current release" heading (the exact real-world defect: heading
#    frozen at an old version while /version moved on) -> fails.
write_fixture "v7.6.70" "v7.3.3" "v7.6.70"
expect_fail "stale '**Current release' heading"

# 3. Stale "current release is" prose under Historical release highlights -> fails.
write_fixture "v7.6.70" "v7.6.70" "v7.3.3"
expect_fail "stale 'current release is' prose"

echo ""
echo "check-readme-current-release.test.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
