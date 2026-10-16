#!/usr/bin/env bash
# check-readme-current-release.sh — README.md must describe the CURRENT release.
#
# WHY THIS EXISTS: README.md carries two prose version tokens that
# version-consistency.yml's 5-location check never looked at — the
# "**Current release: vX.Y.Z**" heading and the "The current release is
# vX.Y.Z" line under "## Historical release highlights". Both sat at v7.3.3
# for weeks while /version, package.json, package-lock.json and CHANGELOG.md
# all moved on to v7.6.70. Readers of README.md — the first thing anyone
# sees — got a stale story.
#
# scripts/bump-version.sh now rolls the version number in both lines on
# every bump (it does not, and cannot, auto-write the surrounding
# description — that stays hand-authored per release, exactly like
# CHANGELOG.md entries already are). This script is the CI-side half: it
# fails the build if either number drifts from /version.
#
# Usage: bash scripts/check-readme-current-release.sh   (run from repo root)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FAIL=0

REPO_VER=$(head -1 version | tr -d '[:space:]')
echo "Repo /version: $REPO_VER"

# "**Current release: vX.Y.Z" heading must equal /version.
HEADER_VER=$(grep -oE '\*\*Current release: v[0-9]+\.[0-9]+\.[0-9]+' README.md | head -1 | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || echo "MISSING")
if [ "$HEADER_VER" != "$REPO_VER" ]; then
  echo "README DRIFT: '**Current release: $HEADER_VER' heading != /version ($REPO_VER)"
  FAIL=1
else
  echo "OK: README '**Current release' heading matches /version ($HEADER_VER)"
fi

# "The current release is vX.Y.Z" prose (under Historical release highlights) must equal /version.
PROSE_VER=$(grep -oE 'current release is v[0-9]+\.[0-9]+\.[0-9]+' README.md | head -1 | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || echo "MISSING")
if [ "$PROSE_VER" != "$REPO_VER" ]; then
  echo "README DRIFT: 'current release is $PROSE_VER' prose != /version ($REPO_VER)"
  FAIL=1
else
  echo "OK: README 'current release is' prose matches /version ($PROSE_VER)"
fi

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "FIX: run ./scripts/bump-version.sh \$(head -1 version) to re-roll both README"
  echo "     version tokens, or edit README.md by hand, then re-run this check."
  exit 1
fi

echo ""
echo "All README current-release markers agree."
