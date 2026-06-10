#!/usr/bin/env bash
# sunday-cron-sweep.sh — weekly fleet health sweep via cc-health-check.sh (B.1).
#
# PRD Addendum B.1 (P0): This script is one of the REQUIRED callers of
# cc-health-check.sh. It MUST NOT implement its own green definition.
#
# Also runs b5-cf-access-check.sh (B.5) per box when PUBLIC_URL is in the fleet
# file (5th column). B.5 is a warning-level check; it does not affect OVERALL_EXIT.
#
# Schedule (host crontab): 0 3 * * 0  /path/to/scripts/sunday-cron-sweep.sh
#
# Reads FLEET_BOXES from environment or the file at $FLEET_BOXES_FILE.
# Each line in the file: PORT CANONICAL_DIR DB_PATH LABEL [PUBLIC_URL] (tab/space sep)
# Example:
#   4000  /data/projects/command-center  /data/projects/command-center/mission-control.db  trevor  https://trevor.zerohumanworkforce.com
#
# Exit: 0 = all boxes green, 1 = one or more boxes not green (exit 3 = UNKNOWN does not set exit 1).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_CHECK="${SCRIPT_DIR}/cc-health-check.sh"
B5_CHECK="${SCRIPT_DIR}/b5-cf-access-check.sh"
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
    PUBLIC_URL_FIELD=$(printf '%s' "$line" | awk '{print $5}')
    LABEL="${LABEL:-unknown}"

    # FIX #9: absolutify CANON_DIR and DB_PATH from the fleet file.
    # A relative value causes false cwd-mismatch + DB-not-found in cc-health-check.sh.
    if [[ -n "$CANON_DIR" && "$CANON_DIR" != /* ]]; then
      CANON_DIR="$(cd "$CANON_DIR" 2>/dev/null && pwd)" || {
        printf '[sunday-cron-sweep] WARN: cannot absolutify CANON_DIR=%s for box %s — skipping\n' "$CANON_DIR" "$LABEL" >&2
        continue
      }
    fi
    if [[ -n "$DB_PATH" && "$DB_PATH" != /* ]]; then
      DB_PATH="$(cd "$(dirname "$DB_PATH")" 2>/dev/null && pwd)/$(basename "$DB_PATH")" || {
        printf '[sunday-cron-sweep] WARN: cannot absolutify DB_PATH=%s for box %s — skipping\n' "$DB_PATH" "$LABEL" >&2
        continue
      }
    fi

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

    # REDO #10: exit 3 (UNKNOWN) is transient — do NOT set OVERALL_EXIT=1 for it.
    # Only a definitive exit 1 (not-green) triggers the alert.
    if [[ "$BOX_EXIT" -eq 0 ]]; then
      printf '[sunday-cron-sweep] BOX GREEN: %s\n' "$LABEL" >&2
    elif [[ "$BOX_EXIT" -eq 3 ]]; then
      printf '[sunday-cron-sweep] BOX UNKNOWN (transient — retry): %s\n' "$LABEL" >&2
    else
      printf '[sunday-cron-sweep] BOX NOT GREEN: %s — alert required\n' "$LABEL" >&2
      OVERALL_EXIT=1
    fi

    # B.5 CF-Access check (warning-level; does not affect OVERALL_EXIT)
    if [[ -n "${PUBLIC_URL_FIELD:-}" && -x "$B5_CHECK" ]]; then
      B5_RESULT=""
      B5_EXIT=0
      B5_RESULT=$(bash "$B5_CHECK" --public-url "$PUBLIC_URL_FIELD" --json-only 2>/dev/null) || B5_EXIT=$?
      if [[ "$B5_EXIT" -eq 0 ]]; then
        printf '[sunday-cron-sweep] CF-Access OK: %s (%s)\n' "$LABEL" "$PUBLIC_URL_FIELD" >&2
      else
        printf '[sunday-cron-sweep] CF-Access WARN: %s (%s) — %s\n' "$LABEL" "$PUBLIC_URL_FIELD" "$B5_RESULT" >&2
      fi
    fi
  done < "$FLEET_BOXES_FILE"
fi

printf '[sunday-cron-sweep] Sweep complete. Overall: %s\n' \
  "$( [[ "$OVERALL_EXIT" -eq 0 ]] && echo GREEN || echo 'NOT GREEN')" >&2
exit "$OVERALL_EXIT"
