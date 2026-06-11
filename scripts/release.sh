#!/usr/bin/env bash
# release.sh — cut a BlackCEO Command Center release.
#
# Usage:
#   ./scripts/release.sh vX.Y.Z "Short release title"
#
# Steps performed:
#   1. Validate args + git state
#   2. Prepend CHANGELOG.md entry (if not already present)
#   3. Run bump-version.sh vX.Y.Z  (updates version / package.json / package-lock.json)
#   4. Run bump-version.sh --check (verify all 5 locations agree)
#   5. Stage + commit version files + CHANGELOG
#   6. Create annotated git tag via bump-version.sh --tag
#   7. Push commit + tag to origin
#   8. Create GitHub release (gh release create)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Args ──────────────────────────────────────────────────────────────────────
TARGET="${1:-}"
TITLE="${2:-}"

if [[ -z "$TARGET" || -z "$TITLE" ]]; then
  echo "Usage: $0 vX.Y.Z \"Short release title\""
  echo "  Example: $0 v4.34.0 \"fix(b1): B.1 deep health check — 65 vitest rows green\""
  exit 1
fi

if ! echo "$TARGET" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "ERROR: version must be vX.Y.Z format (got '$TARGET')" >&2
  exit 1
fi

cd "$REPO_ROOT"

# ── Guard: must be on main, clean ─────────────────────────────────────────────
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "ERROR: releases must be cut from main (currently on '$CURRENT_BRANCH')" >&2
  exit 1
fi

DIRTY=$(git status --porcelain 2>/dev/null | grep -v "^??" || true)
if [[ -n "$DIRTY" ]]; then
  echo "ERROR: working tree has uncommitted changes — commit or stash first" >&2
  git status --short
  exit 1
fi

# ── Guard: tag must not already exist ────────────────────────────────────────
if git tag -l "$TARGET" | grep -qx "$TARGET"; then
  echo "ERROR: tag $TARGET already exists — aborting to avoid overwrite" >&2
  exit 1
fi

TODAY=$(date -u +%Y-%m-%d)
F_CL="$REPO_ROOT/CHANGELOG.md"

# ── Step 1: Prepend CHANGELOG entry (idempotent) ─────────────────────────────
if grep -q "## \[$TARGET\]" "$F_CL" 2>/dev/null; then
  echo "CHANGELOG already has entry for $TARGET — skipping prepend"
else
  echo "Prepending CHANGELOG entry for $TARGET..."
  ENTRY="## [$TARGET] — $TODAY — $TITLE"$'\n'
  TMP_CL=$(mktemp)
  printf '%s\n' "$ENTRY" | cat - "$F_CL" > "$TMP_CL"
  mv "$TMP_CL" "$F_CL"
  echo "  Added: $ENTRY"
fi

# ── Step 2: bump-version.sh (version / package.json / package-lock.json) ─────
echo ""
echo "Running bump-version.sh $TARGET ..."
"$SCRIPT_DIR/bump-version.sh" "$TARGET"

# ── Step 3: verify all 5 locations agree ─────────────────────────────────────
echo ""
echo "Verifying version consistency..."
"$SCRIPT_DIR/bump-version.sh" --check

# ── Step 4: stage + commit ────────────────────────────────────────────────────
echo ""
echo "Staging version files + CHANGELOG..."
git add version package.json package-lock.json CHANGELOG.md

echo "Creating release commit..."
git commit -m "chore(release): $TARGET — $TITLE"

# ── Step 5: annotated tag ─────────────────────────────────────────────────────
echo ""
echo "Creating annotated tag $TARGET ..."
git tag -a "$TARGET" -m "Release $TARGET — $TITLE"

# ── Step 6: push commit + tag ─────────────────────────────────────────────────
echo ""
echo "Pushing commit + tag to origin..."
git push origin main
git push origin "$TARGET"

# ── Step 7: GitHub release ────────────────────────────────────────────────────
echo ""
echo "Creating GitHub release $TARGET ..."

# Extract CHANGELOG body for this version (lines between this heading and next ## heading)
CL_BODY=$(awk "/^## \[$TARGET\]/,/^## \[v[0-9]/" "$F_CL" \
  | head -n -1 \
  | tail -n +2 \
  | sed '/^[[:space:]]*$/d' \
  | head -40)

gh release create "$TARGET" \
  --repo "trevorotts1/blackceo-command-center" \
  --title "$TARGET — $TITLE" \
  --notes "${CL_BODY:-$TITLE}"

echo ""
echo "✅ Release $TARGET cut successfully."
echo "   https://github.com/trevorotts1/blackceo-command-center/releases/tag/$TARGET"
