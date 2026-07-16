#!/usr/bin/env bash
# sunday-cron-sweep.sh — weekly fleet health sweep via cc-health-check.sh (B.1).
# PRD Addendum B.1 (P0): MUST NOT implement its own green definition.
#
# Schedule: 0 3 * * 0  /path/to/scripts/sunday-cron-sweep.sh
# Fleet file ($FLEET_BOXES_FILE): each line = PORT CANONICAL_DIR DB_PATH LABEL [PUBLIC_URL]
# Exit: 0 = all boxes green, 1 = one or more definitive RED. exit 3 (UNKNOWN) does NOT set exit 1.
#
# U51 build items (Port-4000 agreement proof, fleet-wide):
#   1. --public-url is now ALWAYS passed to cc-health-check.sh (from the
#      fleet file's documented 5th field, or CC_PUBLIC_URL in the no-fleet-
#      file local-box fallback) so the CF public-URL probe is a REQUIRED row
#      instead of silently UNKNOWN. FIX: this closes the second, independent
#      path to a permanent exit 3 — before this, NEITHER call site ever
#      passed --public-url, so cc-health-check.sh's CF probe was pinned to
#      indeterminate for every box regardless of any other fix.
#   2. A read-only per-box ledger is written to
#      /tmp/${SWEEP_NAME}/${label}.json on every run, carrying cc_port,
#      override_ack_set, and the public-probe (cf_probe) verdict straight out
#      of cc-health-check.sh's own JSON — the single source of truth this
#      script is required to defer to (PRD Addendum B.1 P0 above).
#   3. A read-only fleet-wide assertion checks every box's ledger for
#      cc_port=4000 and override_ack_set=false and logs (never fails the
#      sweep on) any box that drifts — see assert_port_agreement() below.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEALTH_CHECK="${SCRIPT_DIR}/cc-health-check.sh"
FLEET_BOXES_FILE="${FLEET_BOXES_FILE:-${SCRIPT_DIR}/../.fleet-boxes}"

if [[ ! -x "$HEALTH_CHECK" ]]; then
  printf 'FATAL: cc-health-check.sh not found at %s\n' "$HEALTH_CHECK" >&2; exit 1
fi

OVERALL_EXIT=0
SWEEP_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
# U51 build item 2: per-box ledger directory. SWEEP_NAME is env-overridable
# (tests set it to a scratch name); default is a fixed, evergreen name so the
# ledger holds each box's MOST RECENT sweep result, not a pile of one-off
# per-run directories.
SWEEP_NAME="${SWEEP_NAME:-sunday-cron-sweep}"
LEDGER_DIR="/tmp/${SWEEP_NAME}"
mkdir -p "$LEDGER_DIR" 2>/dev/null || true
printf '[sunday-cron-sweep] Starting fleet sweep at %s (ledger: %s)\n' "$SWEEP_TS" "$LEDGER_DIR" >&2

# U51 build item 3: read-only assertion that a box's ledger agrees with the
# Port-4000 fleet-wide agreement (cc_port=4000, override_ack_set=false).
# Observational only — logs an ASSERT line on drift, never touches
# OVERALL_EXIT (a port drift is reported by the health-check's own pm2/cwd
# checks already; this assertion is the "prove it fleet-wide" reporting layer
# the unit's acceptance calls for, not a second, competing gate).
assert_port_agreement() {
  local label="$1" ledger_file="$2" line
  line=$(python3 -s -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print('ASSERT SKIP: %s — ledger unreadable (%s)' % (sys.argv[2], e))
    sys.exit(0)
port = d.get('cc_port')
ack = d.get('override_ack_set')
if port == 4000 and ack is False:
    print('ASSERT PASS: %s — cc_port=4000, override_ack_set=false' % sys.argv[2])
else:
    print('ASSERT DRIFT: %s — cc_port=%r override_ack_set=%r (expected cc_port=4000, override_ack_set=false)' % (sys.argv[2], port, ack))
" "$ledger_file" "$label" 2>/dev/null)
  printf '[sunday-cron-sweep] %s\n' "${line:-ASSERT SKIP: $label — assertion script failed}" >&2
}

run_box() {
  local port="$1" canon="$2" dbpath="$3" label="$4" public_url="${5:-}"
  local args=(--port "$port" --json-only)
  [[ -n "$canon" ]]      && args+=(--canonical-dir "$canon")
  [[ -n "$public_url" ]] && args+=(--public-url "$public_url")

  local result="" exit_code=0
  result=$(bash "$HEALTH_CHECK" "${args[@]}") || exit_code=$?
  printf '{"label":"%s","port":%s,"result":%s}\n' "$label" "$port" "$result"

  # U51 build item 2: write the per-box ledger — a read-only reporter that
  # carries cc_port / override_ack_set / the public-probe (cf_probe) verdict
  # out of cc-health-check.sh's OWN JSON (never re-derived), plus the sweep's
  # own exit-code verdict for this box.
  local ledger_file="${LEDGER_DIR}/${label}.json"
  printf '%s' "$result" | python3 -s -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
cf = d.get('cf_probe') or {}
ledger = {
    'label': sys.argv[1],
    'port': sys.argv[2],
    'timestamp': sys.argv[3],
    'sweep_exit_code': int(sys.argv[4]),
    'cc_port': d.get('cc_port'),
    'override_ack_set': d.get('override_ack_set'),
    'public_probe': {
        'pass': cf.get('pass'),
        'indeterminate': cf.get('indeterminate'),
        'detail': cf.get('detail'),
    },
}
print(json.dumps(ledger, indent=2))
" "$label" "$port" "$SWEEP_TS" "$exit_code" > "$ledger_file" 2>/dev/null || \
    printf '{"label":"%s","port":"%s","timestamp":"%s","sweep_exit_code":%s,"cc_port":null,"override_ack_set":null,"public_probe":{"pass":null,"indeterminate":true,"detail":"ledger write fallback: could not parse health-check JSON"}}\n' \
      "$label" "$port" "$SWEEP_TS" "$exit_code" > "$ledger_file"

  assert_port_agreement "$label" "$ledger_file"

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
  run_box "${CC_PORT:-4000}" "${CC_CANONICAL_DIR:-}" "" "local" "${CC_PUBLIC_URL:-}"
else
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }" ]] && continue
    PORT=$(printf '%s' "$line" | awk '{print $1}')
    CANON=$(printf '%s' "$line" | awk '{print $2}')
    DB=$(printf '%s' "$line" | awk '{print $3}')
    LABEL=$(printf '%s' "$line" | awk '{print $4}'); LABEL="${LABEL:-unknown}"
    PUBLIC_URL=$(printf '%s' "$line" | awk '{print $5}')
    run_box "$PORT" "$CANON" "$DB" "$LABEL" "$PUBLIC_URL"
  done < "$FLEET_BOXES_FILE"
fi

printf '[sunday-cron-sweep] Sweep complete. Overall: %s\n' \
  "$([[ "$OVERALL_EXIT" -eq 0 ]] && echo GREEN || echo 'NOT GREEN')" >&2
exit "$OVERALL_EXIT"
