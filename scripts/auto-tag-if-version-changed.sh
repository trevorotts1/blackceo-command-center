#!/usr/bin/env bash
# auto-tag-if-version-changed.sh -- cut + push the annotated release tag the
# INSTANT a version bump lands on main, with NO agent action required.
#
# WHY THIS EXISTS IN THIS REPO (measured 2026-09-15)
# --------------------------------------------------
# The Command Center had NO auto-tagging at all, and its version-consistency
# guard has no wait. So EVERY release showed a red main: the guard sampled the
# tag set at checkout, the tag did not exist yet, and nothing was ever going to
# create it automatically. It stayed red until a human ran
# `scripts/bump-version.sh vX.Y.Z --tag` by hand AND manually re-ran the failed
# job. That is precisely what happened on the v7.4.0 (Skill 69 archify) release:
# the guard reported "NO TAG for v7.4.0" at 01:14:38, the tag was pushed
# manually at ~01:16, and the job passed immediately on re-run — a false
# negative on a correct release, with no code defect behind it.
#
# The onboarding repo closed this exact class of failure in its 2026-08-20
# delay audit (Section 2 D3 / Section 4(b) / Section 7 item 3), where an
# untagged release on main turned main AND every open PR red, and PRs were
# opened whose only purpose was to make an agent remember to push a tag. The
# structural fix is the same here: no agent has to remember, so it becomes
# impossible for main to sit untagged for longer than one CI run.
#
# THIS IS DELIBERATELY A THIN WRAPPER. The "did /version change since the
# previous commit" comparison mirrors this repo's own tag guard so the two can
# never disagree about WHEN a tag is due. The actual tag-cutting is fully
# delegated to scripts/push-version-tag.sh, which carries the hardened
# SHA-resolution + ancestry-proof logic that prevents orphaned tags (a tag
# resolved by NAME can be published from another agent's unmerged branch; see
# that script's header). This script adds NO new tagging logic; it only removes
# the human "someone has to run it" step.
#
# Usage:
#   scripts/auto-tag-if-version-changed.sh [--remote origin]
#
# Must be run from a checkout with full history (fetch-depth 0) at the commit
# that was just pushed to main (HEAD == the new main tip; HEAD^1 == what main
# was before this push). Exits 0 whether or not a tag was needed. Exits
# non-zero ONLY if a tag WAS needed and scripts/push-version-tag.sh refused or
# failed -- i.e. a real problem worth failing the build over (see that
# script's "REFUSING TO PUSH" cases: not-an-ancestor, or a differing tag
# already published at that name).

set -euo pipefail

REMOTE="origin"
while [ $# -gt 0 ]; do
  case "$1" in
    --remote) REMOTE="$2"; shift 2 ;;
    -h|--help) sed -n '1,43p' "$0"; exit 0 ;;
    *) echo "Unexpected argument: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -f "$REPO_ROOT/version" ]; then
  echo "ERROR: $REPO_ROOT/version not found -- not a blackceo-command-center checkout?" >&2
  exit 2
fi

CURRENT_VER=$(head -1 version | tr -d '[:space:]')
echo "Current /version on HEAD: $CURRENT_VER"

PREV_SHA=$(git rev-parse HEAD^1 2>/dev/null || echo "")
if [ -z "$PREV_SHA" ]; then
  echo "No previous commit (root commit) -- nothing to compare against. Exiting."
  exit 0
fi

PREV_VER=$(git show "${PREV_SHA}:version" 2>/dev/null | head -1 | tr -d '[:space:]' || echo "")

if [ "$CURRENT_VER" = "$PREV_VER" ]; then
  echo "Version unchanged ($CURRENT_VER) since the previous commit on this ref -- no tag due."
  exit 0
fi

if [[ ! "$CURRENT_VER" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: /version changed to '$CURRENT_VER', which is not a vX.Y.Z string. Refusing to tag." >&2
  exit 1
fi

echo "Version changed: ${PREV_VER:-<none>} -> $CURRENT_VER. Cutting the annotated tag now ..."
exec "$SCRIPT_DIR/push-version-tag.sh" "$CURRENT_VER" "$(git rev-parse HEAD)" --remote "$REMOTE"
