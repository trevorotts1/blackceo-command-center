#!/usr/bin/env bash
# fleet-refresh-verify.sh — post-deploy canary gate for a single CC box.
# PRD Addendum B.1 (P0): MUST NOT implement its own green definition.
#
# Exit codes: 0 = green, 1 = red, 3 = UNKNOWN/transient (relayed distinctly per spec)
# Called by fleet-refresh automation after each per-box restart.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_CHECK="${SCRIPT_DIR}/cc-health-check.sh"

if [[ ! -x "$HEALTH_CHECK" ]]; then
  printf 'FATAL: cc-health-check.sh not found at %s\n' "$HEALTH_CHECK" >&2; exit 1
fi

RESULT_JSON=""; RESULT_EXIT=0
RESULT_JSON=$(bash "$HEALTH_CHECK" "$@") || RESULT_EXIT=$?
printf '%s\n' "$RESULT_JSON"

if [[ "$RESULT_EXIT" -eq 0 ]]; then
  printf '[fleet-refresh-verify] GREEN — box passed all B.1 checks\n' >&2
elif [[ "$RESULT_EXIT" -eq 3 ]]; then
  # Relay UNKNOWN distinctly — fleet caller decides whether to retry or escalate
  printf '[fleet-refresh-verify] UNKNOWN (transient) — retry advised; do NOT block deploy on this\n' >&2
else
  printf '[fleet-refresh-verify] NOT GREEN — deploy blocked; see JSON above\n' >&2
fi

exit "$RESULT_EXIT"
