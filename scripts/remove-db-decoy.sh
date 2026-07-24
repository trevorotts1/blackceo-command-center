#!/bin/bash
#
# remove-db-decoy.sh — U026: remove the 0-byte mission-control.db decoy at the
# command-center root.
#
# THE DEFECT. <command-center>/mission-control.db is a 0-byte file (NOT the real
# DB). The real DB is data/mission-control.db (68.6M). Any script using a legacy
# candidate list that probes the root before data/ could hit the 0-byte decoy
# and open an empty database instead of the real one.
#
# THE FIX. Remove the 0-byte mission-control.db at the command-center root if it
# exists and is 0 bytes. Keep only data/mission-control.db (the real DB).
#
# SAFETY:
#   - Removes ONLY a file that EXISTS and is EXACTLY 0 bytes ([ -f ] && [ ! -s ]).
#     A NON-empty mission-control.db at the root is NEVER removed (it might be a
#     real DB someone placed there — operator review required).
#   - NEVER touches data/mission-control.db (the real DB). The target is the
#     root-level path only; a defensive guard refuses to operate on any path
#     under data/ or equal to the real DB path.
#   - IDEMPOTENT: if the decoy is already gone, does nothing (exit 0).
#
# Usage:
#   scripts/remove-db-decoy.sh --dry-run   # report what would be removed
#   scripts/remove-db-decoy.sh             # remove the 0-byte decoy
#
# Env:
#   CC_APP_DIR   command-center root (default: the repo this script lives in).
#
# Exit codes: 0 ok / nothing to do; 2 usage or safety violation (never removes
# on a safety violation).

set -euo pipefail

DRY_RUN=false
for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=true ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown argument: $arg (usage: remove-db-decoy.sh [--dry-run])" >&2; exit 2 ;;
  esac
done

# Resolve the command-center root. CC_APP_DIR wins (matches update.sh's
# convention); else the repo this script lives in (scripts/.. ).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CC_APP_DIR="${CC_APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

DECOY="$CC_APP_DIR/mission-control.db"
REAL_DB="$CC_APP_DIR/data/mission-control.db"

# SAFETY GUARD: the target must be the root-level mission-control.db, never the
# real DB under data/. Refuse (exit 2, remove nothing) if the target resolves
# under data/ or equals the real DB path.
case "$DECOY" in
  */data/mission-control.db)
    echo "SAFETY: target resolves to the real DB under data/ — refusing to remove" >&2
    exit 2 ;;
esac
if [ "$DECOY" = "$REAL_DB" ]; then
  echo "SAFETY: target equals the real DB path — refusing to remove" >&2
  exit 2
fi

# Idempotent: nothing to do if the decoy is absent.
if [ ! -e "$DECOY" ]; then
  echo "no decoy at $DECOY — nothing to do (idempotent)"
  exit 0
fi

# Safety: only remove a 0-byte file. A non-empty mission-control.db at the root
# is NEVER removed (might be a real DB; operator review required).
if [ -s "$DECOY" ]; then
  echo "SAFETY: $DECOY is NOT 0 bytes ($(wc -c < "$DECOY" | tr -d ' ') bytes) — NOT removing (operator review required)"
  exit 0
fi

# It exists and is 0 bytes — it's the decoy.
if [ "$DRY_RUN" = true ]; then
  echo "DRY-RUN: would remove 0-byte decoy $DECOY (real DB $REAL_DB untouched)"
  exit 0
fi

rm -f "$DECOY"
echo "removed 0-byte decoy $DECOY (real DB $REAL_DB untouched)"
exit 0
