#!/usr/bin/env bash
# fleet-refresh-verify.sh — post-deploy canary gate for a single CC box.
#
# PRD Addendum B.1 (P0): This script is one of the REQUIRED callers of
# cc-health-check.sh. It MUST NOT implement its own green definition.
#
# Usage:
#   bash scripts/fleet-refresh-verify.sh [--port PORT] [--canonical-dir DIR] \
#        [--db-path PATH] [--host HOSTNAME]
#
# Exit: 0 = green (deploy safe to proceed/mark done), 1 = not green (alert + block)
#
# Called by: fleet-refresh automation after each per-box restart.
# Emits: cc-health-check.sh JSON to stdout plus a one-line summary to stderr.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_CHECK="${SCRIPT_DIR}/cc-health-check.sh"

if [[ ! -x "$HEALTH_CHECK" ]]; then
  printf 'FATAL: cc-health-check.sh not found at %s\n' "$HEALTH_CHECK" >&2
  printf 'Fleet-refresh canary cannot run without the B.1 health check script.\n' >&2
  exit 1
fi

# Pass all arguments through to cc-health-check.sh unchanged.
# fleet-refresh callers supply --port, --canonical-dir, --db-path etc. as needed.
RESULT_JSON=""
RESULT_EXIT=0
RESULT_JSON=$(bash "$HEALTH_CHECK" "$@") || RESULT_EXIT=$?

printf '%s\n' "$RESULT_JSON"

if [[ "$RESULT_EXIT" -eq 0 ]]; then
  printf '[fleet-refresh-verify] GREEN — box passed all B.1 checks\n' >&2
else
  printf '[fleet-refresh-verify] NOT GREEN — deploy blocked; see JSON above\n' >&2
fi

exit "$RESULT_EXIT"
