#!/usr/bin/env bash
# check-qc-independence.sh — Assert QC-scorer independence in CHANGELOG.md.
#
# Every QC score entry in CHANGELOG must be scored by an agent INDEPENDENT of
# the writer. Self-assessed entries that have NOT been followed by an
# independent correction are a CI failure.
#
# Detection rules (FAIL):
#   A "self-scored" or "self-assessed" QC header that is NOT followed within
#   60 lines by an independence declaration.
#
# Independence declarations (any of):
#   "AF5 independent", "independent Sonnet", "independent scorer",
#   "Scored by independent", "Scored by Sonnet QC", "Sonnet QC agent",
#   "independent QC", "Independent re-score", "independent Haiku"
#
# Self-assessment patterns (trigger scan):
#   - "self-scored"
#   - "self-assessed"
#   - "self_scored"
#   - "self_assessed"
#   - "QC Score (self"       (covers "QC Score (self-assessed, ...)")
#   - "QC Self-Assessment"
#   - "self-scored" inside a rubric header line
#
# Usage:
#   bash scripts/check-qc-independence.sh [CHANGELOG_FILE]
#
# Default file: CHANGELOG.md in the repo root.
# Exit 0 = all self-assessed entries have a following independent correction.
# Exit 1 = one or more uncorrected self-assessed entries.
#
# Fixture mode (CI self-test):
#   bash scripts/check-qc-independence.sh scripts/fixtures/qc-self-assessed-fixture.md
#   This SHOULD exit 1 (planted self-assessed entry has no independent correction).

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHANGELOG="${1:-$ROOT/CHANGELOG.md}"

red()    { printf "\033[31m%s\033[0m\n" "$1"; }
green()  { printf "\033[32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[33m%s\033[0m\n" "$1"; }
blue()   { printf "\033[34m%s\033[0m\n" "$1"; }

if [ ! -f "$CHANGELOG" ]; then
  red "ERROR: CHANGELOG file not found: $CHANGELOG"
  exit 1
fi

blue "── QC Independence check ── ($CHANGELOG)"

FAIL=0

# Patterns that identify a self-assessment (case-insensitive)
SELF_PATTERNS=(
  "self-scored"
  "self-assessed"
  "self_scored"
  "self_assessed"
  "QC Score (self"
  "QC Self-Assessment"
)

# Patterns that constitute an independence declaration (case-insensitive)
IND_PATTERNS=(
  "AF5 independent"
  "independent Sonnet"
  "independent scorer"
  "Scored by independent"
  "Scored by Sonnet QC"
  "Sonnet QC agent"
  "independent QC"
  "Independent re-score"
  "independent Haiku"
  "independent re-audit"
  "independent.*re-score"
)

TOTAL_LINES=$(wc -l < "$CHANGELOG")

# For each self-assessed marker found, check if there's an independence
# declaration within the next 60 lines OR the previous 10 lines.
# (Previous = an independence block already appeared above this self-score,
#  which happens in newest-first changelogs where the independent re-score
#  section is prepended before the historical self-scored entry.)

for pattern in "${SELF_PATTERNS[@]}"; do
  while IFS=: read -r lineno linecontent; do
    # Determine the window to check for independence
    prev_start=$((lineno > 10 ? lineno - 10 : 1))
    next_end=$((lineno + 60 < TOTAL_LINES ? lineno + 60 : TOTAL_LINES))
    window=$(sed -n "${prev_start},${next_end}p" "$CHANGELOG")

    found_independent=0
    for ind in "${IND_PATTERNS[@]}"; do
      if echo "$window" | grep -qiE "$ind"; then
        found_independent=1
        break
      fi
    done

    if [ $found_independent -eq 0 ]; then
      red "  FAIL [line $lineno]: Self-assessed QC entry with no independent correction:"
      red "       $(echo "$linecontent" | head -c 120)"
      FAIL=$((FAIL+1))
    else
      green "  OK   [line $lineno]: Self-assessed entry has independent correction nearby: \"$pattern\""
    fi
  done < <(grep -in "$pattern" "$CHANGELOG" 2>/dev/null || true)
done

echo ""
if [ $FAIL -gt 0 ]; then
  red "FAIL — $FAIL uncorrected self-assessed QC entry/entries found."
  red "       Each must be followed (or preceded) by an independent re-score block."
  red "       See scripts/check-qc-independence.sh for the required independence markers."
  exit 1
else
  green "PASS — all self-assessed QC entries have an independent correction (or no self-assessed entries found)"
  exit 0
fi
