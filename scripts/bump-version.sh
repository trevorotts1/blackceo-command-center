#!/usr/bin/env bash
# bump-version.sh — atomically bump the BlackCEO Command Center version across all locations.
# CC-specific version of the v10.6.2 onboarding-repo pattern.
#
# Locations updated:
#   - /version            (with v prefix, e.g. v3.1.0)
#   - /package.json       ("version" field, no v prefix, e.g. 3.1.0)
#   - /package-lock.json  (root "version" + packages[""].version, no v prefix)
#   - /CHANGELOG.md       (heading bump verification only — entry must be authored manually)
#
# Usage:
#   ./scripts/bump-version.sh v3.1.0          # update all + verify
#   ./scripts/bump-version.sh v3.1.0 --tag    # update all + create annotated git tag (REQUIRED for version-file changes)
#   ./scripts/bump-version.sh --check         # report drift, exit 1 if any
#   ./scripts/bump-version.sh --check-tag     # verify version file matches a git tag (used by CI)
#
# INVARIANT: every version-file change MUST have a matching annotated git tag.
# CI (version-consistency.yml) will reject any push where the version file changed
# without a corresponding annotated tag. Use --tag to satisfy this invariant.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

F_VERSION="$REPO_ROOT/version"
F_PKG="$REPO_ROOT/package.json"
F_LOCK="$REPO_ROOT/package-lock.json"
F_CL="$REPO_ROOT/CHANGELOG.md"

read_current() {
  V_ROOT=$(cat "$F_VERSION" 2>/dev/null | head -1 | tr -d '[:space:]' || echo "MISSING")
  V_PKG=$(python3 -c "import json; print(json.load(open('$F_PKG'))['version'])" 2>/dev/null || echo "MISSING")
  V_LOCK=$(python3 -c "import json; print(json.load(open('$F_LOCK'))['version'])" 2>/dev/null || echo "MISSING")
  V_LOCK_PKG=$(python3 -c "import json; print(json.load(open('$F_LOCK'))['packages'][''].get('version','MISSING'))" 2>/dev/null || echo "MISSING")
  V_CL=$(grep -oE '## \[v[0-9]+\.[0-9]+\.[0-9]+\]' "$F_CL" 2>/dev/null | head -1 | sed -E 's/## \[(v[0-9]+\.[0-9]+\.[0-9]+)\]/\1/' || echo "MISSING")
}

norm() { echo "${1#v}"; }

print_state() {
  read_current
  echo ""
  echo "Current version state (CC repo):"
  printf "  %-30s %s\n" "/version"               "$V_ROOT"
  printf "  %-30s %s\n" "package.json version"   "$V_PKG"
  printf "  %-30s %s\n" "package-lock.json root" "$V_LOCK"
  printf "  %-30s %s\n" "package-lock packages[''].version" "$V_LOCK_PKG"
  printf "  %-30s %s\n" "CHANGELOG top entry"    "$V_CL"
}

check_drift() {
  read_current
  local n_root=$(norm "$V_ROOT")
  local n_pkg=$(norm "$V_PKG")
  local n_lock=$(norm "$V_LOCK")
  local n_lock_pkg=$(norm "$V_LOCK_PKG")
  local n_cl=$(norm "$V_CL")
  [ "$n_root" = "$n_pkg" ] && [ "$n_root" = "$n_lock" ] && [ "$n_root" = "$n_lock_pkg" ] && [ "$n_root" = "$n_cl" ]
}

check_tag() {
  # Verify that the current version in the version file has a corresponding annotated git tag.
  # Returns 0 (success) if the tag exists, 1 otherwise.
  read_current
  local v="$V_ROOT"
  if git rev-parse --git-dir > /dev/null 2>&1; then
    # git tag -l with exact match; deref=annotated check via cat-file
    if git tag -l "$v" | grep -qx "$v"; then
      # Confirm it is an annotated tag (tag object), not a lightweight tag (commit object)
      local tag_type
      tag_type=$(git cat-file -t "$v" 2>/dev/null || echo "missing")
      if [ "$tag_type" = "tag" ]; then
        return 0
      else
        echo "WARNING: tag $v exists but is a LIGHTWEIGHT tag, not an annotated tag." >&2
        echo "  Re-create it as an annotated tag: git tag -d $v && git tag -a $v -m 'Release $v'" >&2
        return 1
      fi
    else
      return 1
    fi
  else
    echo "WARNING: not inside a git repo — tag check skipped." >&2
    return 0
  fi
}

if [ "${1:-}" = "--check" ]; then
  print_state
  if check_drift; then
    echo ""; echo "✅ All 5 version locations agree."; exit 0
  else
    echo ""; echo "❌ DRIFT DETECTED — at least one location disagrees with /version."; exit 1
  fi
fi

if [ "${1:-}" = "--check-tag" ]; then
  read_current
  echo "Checking git tag for version: $V_ROOT"
  if check_tag; then
    echo "✅ Annotated tag $V_ROOT exists and points at a tag object."
    exit 0
  else
    echo "❌ NO ANNOTATED TAG for $V_ROOT"
    echo "   Every version-file change requires a matching annotated git tag."
    echo "   Run: git tag -a $V_ROOT -m 'Release $V_ROOT' <commit-sha>"
    echo "   Or:  ./scripts/bump-version.sh $V_ROOT --tag"
    exit 1
  fi
fi

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "Usage: $0 vX.Y.Z [--tag]"
  echo "       $0 --check"
  exit 1
fi
if ! echo "$TARGET" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "ERROR: version must be vX.Y.Z format (got '$TARGET')" >&2
  exit 1
fi
TARGET_NOV="${TARGET#v}"

echo "Bumping CC repo at $REPO_ROOT → $TARGET"

echo "$TARGET" > "$F_VERSION"

python3 - <<PYEOF
import json
p = json.load(open("$F_PKG"))
p["version"] = "$TARGET_NOV"
with open("$F_PKG","w") as f:
    json.dump(p, f, indent=2)
    f.write("\n")
PYEOF

python3 - <<PYEOF
import json
p = json.load(open("$F_LOCK"))
p["version"] = "$TARGET_NOV"
if "" in p.get("packages", {}):
    p["packages"][""]["version"] = "$TARGET_NOV"
with open("$F_LOCK","w") as f:
    json.dump(p, f, indent=2)
    f.write("\n")
PYEOF

echo ""
print_state

if ! check_drift; then
  echo ""
  echo "❌ Bump completed but CHANGELOG.md top entry doesn't match $TARGET."
  echo "   Add a new '## [$TARGET] — YYYY-MM-DD — title' entry at the top of CHANGELOG.md, then re-run --check."
  exit 1
fi

echo ""
echo "✅ All 5 locations agree at $TARGET"

if [ "${2:-}" = "--tag" ]; then
  cd "$REPO_ROOT"
  if git rev-parse --git-dir > /dev/null 2>&1; then
    if git tag -l "$TARGET" | grep -qx "$TARGET"; then
      echo "Tag $TARGET already exists — skipping."
    else
      git tag -a "$TARGET" -m "Release $TARGET"
      echo "Created annotated tag $TARGET"
    fi
    echo ""
    echo "Remember to push the tag: git push origin $TARGET"
  fi
else
  echo ""
  echo "NOTE: version bumped but NO TAG created."
  echo "  A matching annotated tag is REQUIRED for every version-file change."
  echo "  CI will reject a push where the version file changed without a tag."
  echo "  Create the tag now: git tag -a $TARGET -m 'Release $TARGET'"
  echo "  Or re-run with --tag flag: ./scripts/bump-version.sh $TARGET --tag"
fi
