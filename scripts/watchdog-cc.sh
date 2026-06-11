#!/usr/bin/env bash
# watchdog-cc.sh — continuous crash detection via cc-health-check.sh (B.1).
# PRD Addendum B.1 (P0): MUST NOT implement its own green definition.
#
# EXIT CONTRACT:
#   exit 1 (definitive RED) → alert fired
#   exit 3 (UNKNOWN/transient) → logged as warn, NO alert (spec mandates this)
#   exit 0 (GREEN) → silent
#
# Schedule (crontab): */5 * * * *  /path/to/scripts/watchdog-cc.sh
# Env: WATCHDOG_PORT  WATCHDOG_CANONICAL_DIR  WATCHDOG_ALERT_LOG  WATCHDOG_ALERT_HOOK

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_CHECK="${SCRIPT_DIR}/cc-health-check.sh"

WATCHDOG_PORT="${WATCHDOG_PORT:-4000}"
WATCHDOG_CANONICAL_DIR="${WATCHDOG_CANONICAL_DIR:-}"
WATCHDOG_ALERT_LOG="${WATCHDOG_ALERT_LOG:-/tmp/cc-watchdog-alerts.log}"
WATCHDOG_ALERT_HOOK="${WATCHDOG_ALERT_HOOK:-}"

if [[ ! -x "$HEALTH_CHECK" ]]; then
  printf 'FATAL: cc-health-check.sh not found at %s\n' "$HEALTH_CHECK" >&2; exit 1
fi

ARGS=(--port "$WATCHDOG_PORT" --json-only)
[[ -n "$WATCHDOG_CANONICAL_DIR" ]] && ARGS+=(--canonical-dir "$WATCHDOG_CANONICAL_DIR")

RESULT_JSON=""; RESULT_EXIT=0
RESULT_JSON=$(bash "$HEALTH_CHECK" "${ARGS[@]}") || RESULT_EXIT=$?
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [[ "$RESULT_EXIT" -eq 0 ]]; then
  exit 0  # GREEN — silent
elif [[ "$RESULT_EXIT" -eq 3 ]]; then
  # UNKNOWN/transient — log as WARN, NEVER alert (spec: must not treat exit 3 as definitive)
  printf '[watchdog-cc] WARN (transient/UNKNOWN) at %s — port %s — not alerting (exit 3)\n' "$TS" "$WATCHDOG_PORT" >&2
  exit 0  # do not propagate as failure
else
  # Exit 1 = definitive RED — alert
  ALERT="{\"watchdog_alert\":true,\"timestamp\":\"${TS}\",\"port\":${WATCHDOG_PORT},\"result\":${RESULT_JSON}}"
  printf '%s\n' "$ALERT" >> "$WATCHDOG_ALERT_LOG"
  printf '[watchdog-cc] ALERT at %s — box on port %s is RED (definitive)\n' "$TS" "$WATCHDOG_PORT" >&2
  printf '%s\n' "$RESULT_JSON" >&2
  if [[ -n "$WATCHDOG_ALERT_HOOK" && -x "$WATCHDOG_ALERT_HOOK" ]]; then
    printf '%s\n' "$RESULT_JSON" | bash "$WATCHDOG_ALERT_HOOK" || true
  fi
  exit 1
fi
