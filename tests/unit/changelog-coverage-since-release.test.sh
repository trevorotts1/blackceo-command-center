#!/usr/bin/env bash
# Proves scripts/check-changelog-coverage-since-release.sh accepts a CHANGELOG.md
# change on every landing since the newest release tag (negative case) and
# catches a landing that touches code without one (positive case) — same
# instrument, same fixture, opposite answer. A check that only ever exits 0 is
# worse than no check, so the mutation here is the code-only landing itself.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
CHECK_SCRIPT="$(pwd)/scripts/check-changelog-coverage-since-release.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

if [ ! -f "$CHECK_SCRIPT" ]; then
  bad "check script not found at $CHECK_SCRIPT"
  printf '[changelog-coverage-since-release] %s passed, %s failed\n' "$PASS" "$FAIL"
  exit 1
fi

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
OUT="$TMP/out.txt"

init_fixture() {
  rm -rf "$TMP/repo"; mkdir -p "$TMP/repo/src"; cd "$TMP/repo"
  git init -q; git config user.email test@example.com; git config user.name test
  printf '## [v1.0.0] — 2026-01-01 — first release\n\n- first thing\n' > CHANGELOG.md
  echo one > src/a.txt
  git add CHANGELOG.md src/a.txt && git commit -q -m "v1.0.0 release"
  git tag -a v1.0.0 -m "Release v1.0.0"
}

# ---- NEGATIVE CASE: every landing since the tag carries a CHANGELOG change ---
init_fixture
echo two > src/a.txt
printf '\n## [Unreleased]\n\n- second thing\n' >> CHANGELOG.md
git add src/a.txt CHANGELOG.md && git commit -q -m "fix(src): second thing"
if bash "$CHECK_SCRIPT" >"$OUT" 2>&1; then
  if awk '/Checked 1 landing/{found=1} END{exit found?0:1}' "$OUT"; then
    ok "covered landing passes and reports it checked the landing (not vacuous)"
  else
    bad "covered landing passed but did not report what it checked — output:"
    sed 's/^/       /' "$OUT"
  fi
else
  bad "covered landing was rejected (false positive) — output:"
  sed 's/^/       /' "$OUT"
fi

# ---- POSITIVE CASE (mutation): a code landing with no CHANGELOG change ------
echo three > src/a.txt
git add src/a.txt && git commit -q -m "fix(src): unreviewed third thing"
if bash "$CHECK_SCRIPT" >"$OUT" 2>&1; then
  bad "code landing with no CHANGELOG.md change PASSED — the check is vacuous"
else
  if awk '/unreviewed third thing/{found=1} END{exit found?0:1}' "$OUT"; then
    ok "code landing with no CHANGELOG.md change is caught and named"
  else
    bad "check failed but did not name the uncovered landing — output:"
    sed 's/^/       /' "$OUT"
  fi
fi

# ---- POSITIVE CASE: the uncovered landing is a MERGE whose branch is bare ----
git reset -q --hard HEAD~1
git checkout -q -b feat/bare
echo four > src/a.txt
git add src/a.txt && git commit -q -m "fix(src): bare branch work"
git checkout -q master 2>/dev/null || git checkout -q main
git merge -q --no-ff feat/bare -m "Merge branch 'feat/bare'"
if bash "$CHECK_SCRIPT" >"$OUT" 2>&1; then
  bad "merge landing with no CHANGELOG.md change PASSED — merge diffs are not being read"
else
  if awk "/Merge branch 'feat\/bare'/{found=1} END{exit found?0:1}" "$OUT"; then
    ok "merge landing with no CHANGELOG.md change is caught and named"
  else
    bad "merge landing was caught but not named — output:"
    sed 's/^/       /' "$OUT"
  fi
fi

# ---- VACUITY CONTROL: no reachable release tag must refuse, not pass --------
cd "$TMP/repo" && git tag -d v1.0.0 >/dev/null
if bash "$CHECK_SCRIPT" >"$OUT" 2>&1; then
  bad "no release tag at all PASSED — vacuous green"
else
  if awk '/vacuously/{found=1} END{exit found?0:1}' "$OUT"; then
    ok "no reachable release tag refuses instead of passing vacuously"
  else
    bad "no-tag case failed without naming the vacuity — output:"
    sed 's/^/       /' "$OUT"
  fi
fi

printf '[changelog-coverage-since-release] %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
