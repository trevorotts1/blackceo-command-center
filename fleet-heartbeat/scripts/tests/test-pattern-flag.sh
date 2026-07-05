#!/usr/bin/env bash
# Offline unit tests for FIX-RESCUE-10 (remediate.sh incidents.tsv index +
# monthly change-log rotation). Sources remediate.sh in REMEDIATE_LIB_ONLY mode
# and exercises the pure helpers against a temp state dir. No SSH, no secrets.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REMEDIATE="$HERE/../remediate.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
check() { # check "name" "expected" "actual"
  if [ "$2" = "$3" ]; then echo "  ok   - $1"; else echo "  FAIL - $1 (expected '$2' got '$3')"; fail=1; fi
}

# Source the library only (8 dummy positional args satisfy set -u).
REMEDIATE_LIB_ONLY=1 REMEDIATE_DRY_RUN=0 . "$REMEDIATE" \
  "TestClient" "persona" "1.2.3.4" "rescue-test-box" "v1" "gw" "ssh" "notes" || {
  echo "  FAIL - could not source remediate.sh in lib-only mode"; exit 1; }

# Redirect all state into the temp dir.
ROOT="$TMP"
CHANGE_LOG="$TMP/change-log.md"
INCIDENTS_TSV="$TMP/incidents.tsv"
CHANGE_LOG_MONTH_MARKER="$TMP/.change-log-month"

now=$(date +%s)
day=86400

echo "FIX-RESCUE-10: pattern_flag reads the compact incidents.tsv"
# No history yet: a fresh class on a fresh client -> NONE.
CLIENT="Alpha"
check "empty history -> NONE" "NONE" "$(pattern_flag gateway-port-closed)"

# Same client + same class twice within 7d -> REPEAT (incl. the pending entry).
printf '%s\t%s\t%s\t%s\n' "$((now - 2*day))" "Alpha" "gateway-port-closed" "FIXED" >> "$INCIDENTS_TSV"
check "one prior + pending -> REPEAT" "REPEAT" "$(pattern_flag gateway-port-closed)"

# Same class across 3 distinct clients within 30d -> FLEET-WIDE.
: > "$INCIDENTS_TSV"
printf '%s\t%s\t%s\t%s\n' "$((now - 3*day))"  "Beta"  "config-invalid" "FIXED" >> "$INCIDENTS_TSV"
printf '%s\t%s\t%s\t%s\n' "$((now - 4*day))"  "Gamma" "config-invalid" "FIXED" >> "$INCIDENTS_TSV"
CLIENT="Delta"   # the pending entry adds the 3rd distinct client
check "2 distinct + pending distinct -> FLEET-WIDE" "FLEET-WIDE" "$(pattern_flag config-invalid)"

# Old entries outside the window are ignored.
: > "$INCIDENTS_TSV"
printf '%s\t%s\t%s\t%s\n' "$((now - 40*day))" "Alpha" "container-exited" "FIXED" >> "$INCIDENTS_TSV"
CLIENT="Alpha"
check "40-day-old entry outside window -> NONE" "NONE" "$(pattern_flag container-exited)"

echo "FIX-RESCUE-10: append_change_log writes the index + prose"
: > "$INCIDENTS_TSV"; : > "$CHANGE_LOG"
CLIENT="Echo"
DRY_RUN=0
append_change_log "gateway-port-closed" "FIXED" "12" "docker restart" "diag" "NONE" "root"
tsv_lines=$(wc -l < "$INCIDENTS_TSV" | tr -d ' ')
check "append wrote 1 tsv index line" "1" "$tsv_lines"
tsv_class=$(awk -F'\t' 'NR==1{print $3}' "$INCIDENTS_TSV")
check "tsv line carries the failure class" "gateway-port-closed" "$tsv_class"
grep -q "gateway-port-closed" "$CHANGE_LOG" && prose=yes || prose=no
check "prose change-log still written" "yes" "$prose"

echo "FIX-RESCUE-10: monthly rotation archives the prior month"
printf 'last month prose\n' > "$CHANGE_LOG"
printf '2020-01' > "$CHANGE_LOG_MONTH_MARKER"   # force a stale month marker
rotate_change_log_if_month_rolled
[ -f "$TMP/change-log-2020-01.md" ] && archived=yes || archived=no
check "prior-month prose archived" "yes" "$archived"
cur=$(date +%Y-%m)
marker=$(cat "$CHANGE_LOG_MONTH_MARKER")
check "month marker advanced to current" "$cur" "$marker"
grep -q "change-log —" "$CHANGE_LOG" && fresh=yes || fresh=no
check "fresh change-log started" "yes" "$fresh"

if [ "$fail" -ne 0 ]; then echo ""; echo "pattern-flag tests FAILED"; exit 1; fi
echo ""; echo "All pattern-flag tests passed."
