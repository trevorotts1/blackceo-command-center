#!/usr/bin/env bash
# check-doc-number-drift.sh — hardcoded counts in docs/comments must track
# their real source of truth, so they can't silently go stale again.
#
# WHY THIS EXISTS: a 2026-09-28 sweep found two counts that had drifted from
# the code they describe, uncaught because nothing compared them:
#   - QC.md claimed "migrations 001-021 present" while the real file had
#     grown to 164 entries (162 present; 022/023 intentionally reserved).
#   - src/lib/routing/canonical-slug.ts's own docstring, src/lib/sop-authoring.ts
#     (3 places) and docs/SOP-LAYERS.md all said "24-slug ZHC canonical set"
#     after CANONICAL_SLUGS had grown to 26 entries (engineering, funnels
#     added later with no comment update).
#
# This script re-derives both real counts from their actual source and fails
# if any of the describing locations disagrees. Run from the repo root.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FAIL=0

# ---------------------------------------------------------------------------
# 1. CANONICAL_SLUGS (ZHC canonical department set) vs its describing comments.
# ---------------------------------------------------------------------------
CANON_FILE="src/lib/routing/canonical-slug.ts"
CANON_COUNT=$(awk '/export const CANONICAL_SLUGS = new Set\(\[/{flag=1; next} /^\]\);/{flag=0} flag' "$CANON_FILE" \
  | grep -cE "^\s*'[a-z0-9-]+',?\s*$")
echo "CANONICAL_SLUGS actual size: $CANON_COUNT"

check_slug_count() {
  local file="$1" pattern="$2" label="$3"
  local found
  found=$(grep -oE "$pattern" "$file" | grep -oE '[0-9]+' | head -1 || true)
  if [ -z "$found" ]; then
    echo "MISSING: $label not found in $file (pattern: $pattern)"
    FAIL=1
    return
  fi
  if [ "$found" != "$CANON_COUNT" ]; then
    echo "DRIFT: $label says $found, but CANONICAL_SLUGS has $CANON_COUNT entries ($file)"
    FAIL=1
  else
    echo "OK: $label matches ($found) — $file"
  fi
}

check_slug_count "$CANON_FILE" 'ZHC [0-9]+-department model' "canonical-slug.ts docstring department-model count"
check_slug_count "src/lib/sop-authoring.ts" '[0-9]+-slug canonical ZHC set' "sop-authoring.ts header comment"
check_slug_count "src/lib/sop-authoring.ts" 'CANONICAL_SLUGS \([0-9]+ ZHC depts\)' "sop-authoring.ts isCanonicalContext docblock"
check_slug_count "src/lib/sop-authoring.ts" 'in the [0-9]+-slug ZHC canonical set' "sop-authoring.ts runtime reason string"
check_slug_count "docs/SOP-LAYERS.md" 'Canonical departments \([0-9]+ ZHC slugs\)' "docs/SOP-LAYERS.md Layer 3b"

# ---------------------------------------------------------------------------
# 2. Migration count/range in src/lib/db/migrations.ts vs QC.md's rubric row.
# ---------------------------------------------------------------------------
MIG_FILE="src/lib/db/migrations.ts"
MIG_IDS=$(grep -oE "id: '[0-9]+'" "$MIG_FILE" | grep -oE '[0-9]+' | sort -n -u)
MIG_COUNT=$(echo "$MIG_IDS" | grep -c .)
# Keep the id's own zero-padded width (e.g. "164", not "5" from "005") so it
# compares byte-for-byte against QC.md's "001-NNN" range string below.
MIG_MAX=$(grep -oE "id: '[0-9]+'" "$MIG_FILE" | grep -oE '[0-9]+' | sort -n | tail -1)
echo "migrations.ts actual: $MIG_COUNT entries, highest id $MIG_MAX"

QC_MATCH=$(grep -oE '\([0-9]+ entries spanning 001-[0-9]+' QC.md | head -1 || true)
if [ -z "$QC_MATCH" ]; then
  echo "MISSING: QC.md item 7 no longer states '(NNN entries spanning 001-NNN' — update the check or QC.md"
  FAIL=1
else
  QC_COUNT=$(echo "$QC_MATCH" | grep -oE '^\([0-9]+' | tr -d '(')
  QC_MAX=$(echo "$QC_MATCH" | grep -oE '001-[0-9]+' | sed 's/001-//')
  if [ "$QC_COUNT" != "$MIG_COUNT" ] || [ "$QC_MAX" != "$MIG_MAX" ]; then
    echo "DRIFT: QC.md says $QC_COUNT entries spanning 001-$QC_MAX, but migrations.ts has $MIG_COUNT entries through $MIG_MAX"
    FAIL=1
  else
    echo "OK: QC.md migration count/range matches migrations.ts ($QC_COUNT entries, 001-$QC_MAX)"
  fi
fi

echo ""
if [ "$FAIL" -ne 0 ]; then
  echo "FIX: update the drifted location(s) above to match the real source of truth,"
  echo "     or re-derive the source of truth if it changed intentionally."
  exit 1
fi
echo "All checked doc/comment counts agree with their real source of truth."
