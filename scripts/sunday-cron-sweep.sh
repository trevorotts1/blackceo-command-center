#!/usr/bin/env bash
# sunday-cron-sweep.sh — weekly fleet health sweep via cc-health-check.sh (B.1).
#
# PRD Addendum B.1 (P0): This script is one of the REQUIRED callers of
# cc-health-check.sh. It MUST NOT implement its own green definition.
#
# Schedule (host crontab): 0 3 * * 0  /path/to/scripts/sunday-cron-sweep.sh
#
# Reads FLEET_BOXES from environment or the file at $FLEET_BOXES_FILE.
# Each line in the file: PORT CANONICAL_DIR DB_PATH LABEL (tab/space separated)
# Example:
#   4000  /data/projects/command-center  /data/projects/command-center/mission-control.db  trevor
#
# Exit: 0 = all boxes green, 1 = one or more boxes not green.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_CHECK="${SCRIPT_DIR}/cc-health-check.sh"
FLEET_BOXES_FILE="${FLEET_BOXES_FILE:-${SCRIPT_DIR}/../.fleet-boxes}"

if [[ ! -x "$HEALTH_CHECK" ]]; then
  printf 'FATAL: cc-health-check.sh not found at %s\n' "$HEALTH_CHECK" >&2
  exit 1
fi

OVERALL_EXIT=0
SWEEP_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
printf '[sunday-cron-sweep] Starting fleet sweep at %s\n' "$SWEEP_TS" >&2

# Default: sweep local box only if no fleet file is present
if [[ ! -f "$FLEET_BOXES_FILE" ]]; then
  printf '[sunday-cron-sweep] No fleet boxes file at %s — checking local box\n' "$FLEET_BOXES_FILE" >&2
  RESULT_JSON=""
  RESULT_EXIT=0
  RESULT_JSON=$(bash "$HEALTH_CHECK" --pm2-check-window 15 --json-only) || RESULT_EXIT=$?
  printf '%s\n' "$RESULT_JSON"
  if [[ "$RESULT_EXIT" -ne 0 ]]; then
    printf '[sunday-cron-sweep] LOCAL BOX NOT GREEN — alert required\n' >&2
    OVERALL_EXIT=1
  fi
else
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue  # skip comments
    [[ -z "${line// }" ]] && continue             # skip blank lines

    PORT=$(printf '%s' "$line" | awk '{print $1}')
    CANON_DIR=$(printf '%s' "$line" | awk '{print $2}')
    DB_PATH=$(printf '%s' "$line" | awk '{print $3}')
    LABEL=$(printf '%s' "$line" | awk '{print $4}')
    LABEL="${LABEL:-unknown}"

    printf '[sunday-cron-sweep] Checking box: %s (port %s)\n' "$LABEL" "$PORT" >&2

    RESULT_JSON=""
    BOX_EXIT=0
    RESULT_JSON=$(bash "$HEALTH_CHECK" \
      --port "$PORT" \
      --canonical-dir "$CANON_DIR" \
      --db-path "$DB_PATH" \
      --pm2-check-window 15 \
      --json-only) || BOX_EXIT=$?

    printf '{"label":"%s","port":%s,"result":%s}\n' "$LABEL" "$PORT" "$RESULT_JSON"

    if [[ "$BOX_EXIT" -ne 0 ]]; then
      printf '[sunday-cron-sweep] BOX NOT GREEN: %s — alert required\n' "$LABEL" >&2
      OVERALL_EXIT=1
    else
      printf '[sunday-cron-sweep] BOX GREEN: %s\n' "$LABEL" >&2
    fi
  done < "$FLEET_BOXES_FILE"
fi

printf '[sunday-cron-sweep] Sweep complete. Overall: %s\n' \
  "$( [[ "$OVERALL_EXIT" -eq 0 ]] && echo GREEN || echo 'NOT GREEN')" >&2
exit "$OVERALL_EXIT"
