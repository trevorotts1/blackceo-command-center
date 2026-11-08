#!/usr/bin/env bash
# check-changelog-coverage-since-release.sh — every landing on main since the
# newest reachable release tag must carry a CHANGELOG.md change.
#
# WHY THIS EXISTS: scripts/check-changelog-tag-coverage.sh proves
# tag -> CHANGELOG (every recent tag has an entry), and version-consistency.yml
# proves /version -> top CHANGELOG heading. Neither proves merged work ->
# CHANGELOG. So code can land after a release stamp in silence while every
# existing check stays green. Measured 2026-11-01 on main 4f3c859d4a:
# "merge s75/S75-T38-cc-r1 into batch/s75-cc-frontier" is past v7.6.126 with
# no CHANGELOG.md diff, and `check-changelog-tag-coverage.sh` exits 0.
#
# UNIT OF COVERAGE = one first-parent landing: a direct commit, or a merge
# whose diff against its first parent is the whole PR / batch diff. A landing
# that changes no tracked file has no work to record, so it is skipped.
#
# TAG ORDER IS BY CREATION DATE, NOT `--sort=-v:refname`, and only tags
# reachable from HEAD count — the same two reasons check-changelog-tag-coverage.sh
# documents (a local v21-v25 epoch sorts above the v7.x line; stray foreign
# tags exist in developer clones).
#
# Usage: bash scripts/check-changelog-coverage-since-release.sh [max landings]
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

MAX="${1:-100}"

TAG=$(git for-each-ref --merged HEAD --sort=-creatordate \
        --format='%(refname:short)' refs/tags \
      | awk '/^v[0-9]+\.[0-9]+\.[0-9]+$/{print; exit}')

if [ -z "$TAG" ]; then
  echo "❌ No reachable release tag (vX.Y.Z) at all — this check would pass vacuously. Refusing to proceed."
  exit 1
fi

COUNT=$(git rev-list --first-parent --count "$TAG"..HEAD)
if [ "$COUNT" -eq 0 ]; then
  echo "✅ HEAD is $TAG (newest reachable release tag) — no landing since, nothing to be out of sync."
  exit 0
fi

MISSING=""
MISSING_COUNT=0
CHECKED=0
for c in $(git rev-list --first-parent "$TAG"..HEAD | tail -n "$MAX"); do
  CHANGED=$(git diff --name-only "$c^1" "$c")
  [ -n "$CHANGED" ] || continue          # no tracked-file work: nothing to record
  CHECKED=$((CHECKED + 1))
  if ! printf '%s\n' "$CHANGED" | awk '$0=="CHANGELOG.md"{found=1} END{exit found?0:1}'; then
    MISSING="$MISSING$(git log -1 --format='%h %s' "$c")\n"
    MISSING_COUNT=$((MISSING_COUNT + 1))
  fi
done

echo "Checked $CHECKED landing(s) since $TAG for a CHANGELOG.md change."

if [ "$MISSING_COUNT" -gt 0 ]; then
  echo ""
  echo "❌ $MISSING_COUNT landing(s) since $TAG recorded no CHANGELOG.md entry:"
  printf '   - %b' "$MISSING"
  echo ""
  echo "FIX: add the entry to CHANGELOG.md in the landing that carries the work"
  echo "     (a '## [Unreleased]' bullet is enough until a release stamp claims it),"
  echo "     or state in the commit why the landing needs no changelog line."
  exit 1
fi

echo "✅ Every landing since $TAG carries a CHANGELOG.md change."
