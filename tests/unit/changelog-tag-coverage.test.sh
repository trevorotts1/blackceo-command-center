#!/usr/bin/env bash
# Proves scripts/check-changelog-tag-coverage.sh actually catches a missing
# CHANGELOG.md entry for a real annotated release tag, and does not just
# pass vacuously.
#
# WHY THIS EXISTS: a coverage check that always exits 0 is worse than no
# check at all — it looks green while proving nothing. This builds an
# isolated throwaway git repo with two annotated tags: first with every tag
# covered in CHANGELOG.md (must pass), then with one entry removed (must
# fail, and must name the tag it's missing).
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
CHECK_SCRIPT="$(pwd)/scripts/check-changelog-tag-coverage.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

if [ ! -f "$CHECK_SCRIPT" ]; then
  bad "check script not found at $CHECK_SCRIPT"
  printf '[changelog-tag-coverage] %s passed, %s failed\n' "$PASS" "$FAIL"
  exit 1
fi

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
git init -q
git config user.email test@example.com
git config user.name test

cat > CHANGELOG.md <<'EOF'
## [v1.0.1] — 2026-01-02 — second release

- did the second thing

## [v1.0.0] — 2026-01-01 — first release

- did the first thing
EOF
git add CHANGELOG.md
git commit -q -m "v1.0.0"
git tag -a v1.0.0 -m "Release v1.0.0"
git commit -q --allow-empty -m "v1.0.1"
git tag -a v1.0.1 -m "Release v1.0.1"

OUT="$TMP/out.txt"
if bash "$CHECK_SCRIPT" 60 >"$OUT" 2>&1; then
  ok "fully-covered fixture passes"
else
  bad "fully-covered fixture was rejected (false positive) — output:"
  sed 's/^/       /' "$OUT"
fi

# ---- MUTATION PROOF -------------------------------------------------------
# Drop the v1.0.1 entry from CHANGELOG.md and confirm the check now fails and
# names the tag it's missing, rather than passing vacuously.
cat > CHANGELOG.md <<'EOF'
## [v1.0.0] — 2026-01-01 — first release

- did the first thing
EOF
git add CHANGELOG.md
git commit -q -m "drop v1.0.1 entry (mutation)"

MUT_OUT="$TMP/mut_out.txt"
if bash "$CHECK_SCRIPT" 60 >"$MUT_OUT" 2>&1; then
  bad "mutation proof FAILED — check passed even with v1.0.1's entry deleted"
else
  if grep -q "v1.0.1" "$MUT_OUT"; then
    ok "mutation proof: deleting v1.0.1's entry is caught and named"
  else
    bad "check failed but did not name the missing tag v1.0.1 — output:"
    sed 's/^/       /' "$MUT_OUT"
  fi
fi

# ---- STRAY TAG (not reachable from HEAD) ----------------------------------
# Restore the v1.0.1 entry, then add an annotated tag on a commit outside HEAD's
# history (a foreign repo's tag in a developer clone). It has no CHANGELOG entry
# and never can; it must not fail the check.
cat > CHANGELOG.md <<'EOF'
## [v1.0.1] — 2026-01-02 — second release

## [v1.0.0] — 2026-01-01 — first release
EOF
git add CHANGELOG.md
git commit -q -m "restore v1.0.1 entry"
STRAY=$(git commit-tree "$(git write-tree)" -m stray)
git tag -a v9.9.9 "$STRAY" -m "stray foreign tag"
if bash "$CHECK_SCRIPT" 60 >"$OUT" 2>&1; then
  ok "stray tag outside HEAD history is ignored"
else
  bad "stray unreachable tag failed the check — output:"
  sed 's/^/       /' "$OUT"
fi

printf '[changelog-tag-coverage] %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
