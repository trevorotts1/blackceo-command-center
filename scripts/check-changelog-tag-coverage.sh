#!/usr/bin/env bash
# check-changelog-tag-coverage.sh — every recent annotated release tag needs
# a CHANGELOG.md entry.
#
# WHY THIS EXISTS: version-consistency.yml's existing "Verify annotated tag
# exists for current version" step only checks ONE version — whatever
# /version says right now. It says nothing about older tags whose
# CHANGELOG.md entry was never written, or was later deleted by accident.
# This closes that gap by walking the most recent annotated release tags and
# confirming each one has a `## [vX.Y.Z]` heading in CHANGELOG.md.
#
# TAG ORDER IS BY CREATION DATE, NOT `--sort=-v:refname`. This repo's local
# tag namespace can also carry a much older, unrelated v21-v25 numbering
# epoch (from before this repo and openclaw-onboarding were split into
# separate projects) that git's version-sort ranks ABOVE the current v7.x
# line purely because 21-25 > 7 numerically. A GitHub Actions checkout of
# this repo's own `origin` never has those tags (confirmed: `git ls-remote
# --tags origin` returns none of them), so this is theoretical in CI, but
# creation-date order is the only ordering that reliably means "most recent"
# and costs nothing extra, so it's used everywhere in this script.
#
# Usage: bash scripts/check-changelog-tag-coverage.sh [N]   (default N=60)
set -euo pipefail

# Repo root is resolved from the CALLER's working directory (`git
# rev-parse`), not this script's own file location. That is what makes the
# unit test below able to point it at an isolated throwaway git repo instead
# of always re-checking the repo this script happens to live in.
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

N="${1:-60}"

TAGS_FILE="$(mktemp)"
trap 'rm -f "$TAGS_FILE"' EXIT
git for-each-ref --sort=-creatordate --format='%(refname:short)' refs/tags \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n "$N" > "$TAGS_FILE"

TAG_COUNT=$(wc -l < "$TAGS_FILE" | tr -d '[:space:]')
if [ "$TAG_COUNT" -eq 0 ]; then
  echo "❌ No version tags found at all — this check would pass vacuously. Refusing to proceed."
  exit 1
fi

MISSING=""
MISSING_COUNT=0
LIGHTWEIGHT=""
while IFS= read -r t; do
  [ -n "$t" ] || continue
  ty=$(git cat-file -t "$t" 2>/dev/null || echo "missing")
  if [ "$ty" != "tag" ]; then
    LIGHTWEIGHT="$LIGHTWEIGHT$t ($ty)\n"
    continue
  fi
  if ! grep -qF "## [$t]" CHANGELOG.md; then
    MISSING="$MISSING$t\n"
    MISSING_COUNT=$((MISSING_COUNT + 1))
  fi
done < "$TAGS_FILE"

echo "Checked $TAG_COUNT most-recent release tag(s) for CHANGELOG.md coverage."

if [ -n "$LIGHTWEIGHT" ]; then
  echo ""
  echo "ℹ️  Skipped (not annotated tags, so out of scope for this check):"
  printf '   - %b' "$LIGHTWEIGHT"
fi

if [ "$MISSING_COUNT" -gt 0 ]; then
  echo ""
  echo "❌ MISSING CHANGELOG.md ENTRY for $MISSING_COUNT annotated tag(s):"
  printf '   - %b' "$MISSING"
  echo ""
  echo "FIX: add a dated '## [vX.Y.Z] — YYYY-MM-DD — <summary>' entry to CHANGELOG.md"
  echo "     for each tag listed above, describing what that release shipped"
  echo "     (git log --oneline <prev-tag>..<tag> is a good starting point)."
  exit 1
fi

echo "✅ Every one of the last $TAG_COUNT annotated release tags has a CHANGELOG.md entry."
