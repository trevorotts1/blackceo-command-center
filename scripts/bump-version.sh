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
#   ./scripts/bump-version.sh v3.1.0 --tag    # also create git tag
#   ./scripts/bump-version.sh --check         # report drift, exit 1 if any
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

if [ "${1:-}" = "--check" ]; then
  print_state
  if check_drift; then
    echo ""; echo "✅ All 5 version locations agree."; exit 0
  else
    echo ""; echo "❌ DRIFT DETECTED — at least one location disagrees with /version."; exit 1
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
    git tag | grep -qx "$TARGET" || git tag -a "$TARGET" -m "Release $TARGET"
    echo "Tagged $TARGET"
  fi
fi
