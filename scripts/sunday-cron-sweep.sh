#!/usr/bin/env bash
# sunday-cron-sweep.sh — weekly fleet health sweep via cc-health-check.sh (B.1).
# PRD Addendum B.1 (P0): MUST NOT implement its own green definition.
#
# Schedule: 0 3 * * 0  /path/to/scripts/sunday-cron-sweep.sh
# Fleet file ($FLEET_BOXES_FILE): each line = PORT CANONICAL_DIR DB_PATH LABEL [PUBLIC_URL]
# Exit: 0 = all boxes green, 1 = one or more definitive RED. exit 3 (UNKNOWN) does NOT set exit 1.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_CHECK="${SCRIPT_DIR}/cc-health-check.sh"
FLEET_BOXES_FILE="${FLEET_BOXES_FILE:-${SCRIPT_DIR}/../.fleet-boxes}"

if [[ ! -x "$HEALTH_CHECK" ]]; then
  printf 'FATAL: cc-health-check.sh not found at %s\n' "$HEALTH_CHECK" >&2; exit 1
fi

OVERALL_EXIT=0
SWEEP_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
printf '[sunday-cron-sweep] Starting fleet sweep at %s\n' "$SWEEP_TS" >&2

run_box() {
  local port="$1" canon="$2" dbpath="$3" label="$4"
  local args=(--port "$port" --json-only)
  [[ -n "$canon" ]]  && args+=(--canonical-dir "$canon")

  local result="" exit_code=0
  result=$(bash "$HEALTH_CHECK" "${args[@]}") || exit_code=$?
  printf '{"label":"%s","port":%s,"result":%s}\n' "$label" "$port" "$result"

  if [[ "$exit_code" -eq 0 ]]; then
    printf '[sunday-cron-sweep] BOX GREEN: %s\n' "$label" >&2
  elif [[ "$exit_code" -eq 3 ]]; then
    # UNKNOWN is not NOT-GREEN — spec: exit 3 = transient, do not set OVERALL_EXIT=1
    printf '[sunday-cron-sweep] BOX UNKNOWN (transient): %s — not counting as failure\n' "$label" >&2
  else
    printf '[sunday-cron-sweep] BOX NOT GREEN: %s — alert required\n' "$label" >&2
    OVERALL_EXIT=1
  fi
}

if [[ ! -f "$FLEET_BOXES_FILE" ]]; then
  printf '[sunday-cron-sweep] No fleet file at %s — checking local box\n' "$FLEET_BOXES_FILE" >&2
  run_box "${CC_PORT:-4000}" "${CC_CANONICAL_DIR:-}" "" "local"
else
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }" ]] && continue
    PORT=$(printf '%s' "$line" | awk '{print $1}')
    CANON=$(printf '%s' "$line" | awk '{print $2}')
    DB=$(printf '%s' "$line" | awk '{print $3}')
    LABEL=$(printf '%s' "$line" | awk '{print $4}'); LABEL="${LABEL:-unknown}"
    run_box "$PORT" "$CANON" "$DB" "$LABEL"
  done < "$FLEET_BOXES_FILE"
fi

printf '[sunday-cron-sweep] Sweep complete. Overall: %s\n' \
  "$([[ "$OVERALL_EXIT" -eq 0 ]] && echo GREEN || echo 'NOT GREEN')" >&2
exit "$OVERALL_EXIT"
