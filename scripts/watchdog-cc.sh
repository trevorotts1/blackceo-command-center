#!/usr/bin/env bash
# watchdog-cc.sh — continuous crash detection via cc-health-check.sh (B.1).
#
# PRD Addendum B.1 (P0): This script is one of the REQUIRED callers of
# cc-health-check.sh. It MUST NOT implement its own green definition.
#
# Intended schedule (crontab): */5 * * * *  /path/to/scripts/watchdog-cc.sh
# Or run in a loop: while true; do bash watchdog-cc.sh; sleep 300; done
#
# On non-green result: writes a timestamped alert to $WATCHDOG_ALERT_LOG
# and optionally calls $WATCHDOG_ALERT_HOOK (a script path to invoke on failure).
#
# Environment:
#   WATCHDOG_PORT          — CC port (default: 4000)
#   WATCHDOG_CANONICAL_DIR — canonical install dir
#   WATCHDOG_DB_PATH       — explicit DB path (optional)
#   WATCHDOG_ALERT_LOG     — path to append alerts (default: /tmp/cc-watchdog-alerts.log)
#   WATCHDOG_ALERT_HOOK    — optional script to call on non-green (receives JSON on stdin)
#   WATCHDOG_PM2_WINDOW    — pm2 restart-count window in seconds (default: 0 for watchdog,
#                            since it runs on a short cron cycle already)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_CHECK="${SCRIPT_DIR}/cc-health-check.sh"

WATCHDOG_PORT="${WATCHDOG_PORT:-4000}"
WATCHDOG_CANONICAL_DIR="${WATCHDOG_CANONICAL_DIR:-}"
WATCHDOG_DB_PATH="${WATCHDOG_DB_PATH:-}"
WATCHDOG_ALERT_LOG="${WATCHDOG_ALERT_LOG:-/tmp/cc-watchdog-alerts.log}"
WATCHDOG_ALERT_HOOK="${WATCHDOG_ALERT_HOOK:-}"
WATCHDOG_PM2_WINDOW="${WATCHDOG_PM2_WINDOW:-0}"

if [[ ! -x "$HEALTH_CHECK" ]]; then
  printf 'FATAL: cc-health-check.sh not found at %s\n' "$HEALTH_CHECK" >&2
  exit 1
fi

# Build args array
ARGS=(
  --port "$WATCHDOG_PORT"
  --pm2-check-window "$WATCHDOG_PM2_WINDOW"
  --json-only
)
[[ -n "$WATCHDOG_CANONICAL_DIR" ]] && ARGS+=(--canonical-dir "$WATCHDOG_CANONICAL_DIR")
[[ -n "$WATCHDOG_DB_PATH" ]]       && ARGS+=(--db-path "$WATCHDOG_DB_PATH")

RESULT_JSON=""
RESULT_EXIT=0
RESULT_JSON=$(bash "$HEALTH_CHECK" "${ARGS[@]}") || RESULT_EXIT=$?

TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [[ "$RESULT_EXIT" -ne 0 ]]; then
  ALERT="{\"watchdog_alert\":true,\"timestamp\":\"${TS}\",\"port\":${WATCHDOG_PORT},\"result\":${RESULT_JSON}}"
  printf '%s\n' "$ALERT" >> "$WATCHDOG_ALERT_LOG"
  printf '[watchdog-cc] ALERT at %s — box on port %s NOT GREEN\n' "$TS" "$WATCHDOG_PORT" >&2
  printf '%s\n' "$RESULT_JSON" >&2

  if [[ -n "$WATCHDOG_ALERT_HOOK" && -x "$WATCHDOG_ALERT_HOOK" ]]; then
    printf '%s\n' "$RESULT_JSON" | bash "$WATCHDOG_ALERT_HOOK" || true
  fi
  exit 1
fi

exit 0
