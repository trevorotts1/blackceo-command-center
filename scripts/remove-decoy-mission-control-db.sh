#!/usr/bin/env bash
# ============================================================
#  remove-decoy-mission-control-db.sh -- U026
#  Removes a 0-byte mission-control.db at the project root
#  (a decoy that shadows the real data/mission-control.db).
#
#  Idempotent: safe to run when the decoy is already gone.
#  Safety:   only removes 0-byte files. Non-zero files are
#            left alone (the real DB could be mislocated).
# ============================================================

set -euo pipefail

CC_ROOT="${1:-}"
if [ -z "$CC_ROOT" ]; then
  CC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi

DECOY="$CC_ROOT/mission-control.db"

if [ ! -f "$DECOY" ]; then
  exit 0
fi

SIZE=$(stat -f%z "$DECOY" 2>/dev/null || echo -1)
if [ "$SIZE" -eq 0 ]; then
  rm -f "$DECOY"
  echo "  ✓ Removed 0-byte decoy: $DECOY"
elif [ "$SIZE" -gt 0 ]; then
  echo "  ⚠ mission-control.db exists at $DECOY ($SIZE bytes) -- NOT removing (safety: non-zero file may be real DB)"
  exit 0
fi
