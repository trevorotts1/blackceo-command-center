#!/usr/bin/env bash
#
# fix-cron-delivery.sh — U012: give the fleet-heartbeat and mission-control-standup
# OpenClaw crons an explicit delivery route so they stop failing closed.
#
# THE DEFECT. Both crons use `announce -> last` delivery with NO prior recipient,
# so every fire fail-closes with "Refusing implicit isolated cron delivery"
# (fleet-heartbeat: 91x, mission-control-standup: 58x). The fleet heartbeat —
# the closest thing to a fleet status feed — is completely dead.
#
# THE FIX. `openclaw cron edit <id>` — set an explicit `delivery.channel=telegram`
# + `delivery.to=<Trevor's chat_id>` on both jobs. The edit is IN-PLACE (it sets
# the delivery fields), so re-running changes nothing — idempotent by
# construction, never an append. Same pattern U014's disk-usage-alert cron reuses.
#
# SAFETY / NAMED STOP. This edits LIVE cron jobs, so application is a deliberate
# operator step (a Named Stop). The default is DRY-RUN: it prints the two
# `openclaw cron edit` commands without executing them. Run with --apply to
# actually edit the live jobs.
#
# NO HARDCODED SECRETS. Trevor's Telegram chat_id is read from the environment
# (TREVOR_TELEGRAM_CHAT_ID, falling back to RESCUE_RANGERS_CHAT_ID — the same
# convention fleet-heartbeat-cron.sh uses), NEVER hardcoded (this is a fleet-wide
# repo). The cron job ids are read from env too (FLEET_HEARTBEAT_CRON_ID /
# MISSION_CONTROL_STANDUP_CRON_ID); the fleet-heartbeat id defaults to the value
# recorded in fleet-heartbeat/scripts/FIX-RESCUE-12-cleanup-and-cron.md, the
# standup id is discovered from `openclaw cron list` when not set.
#
# Usage:
#   scripts/fix-cron-delivery.sh --dry-run     # print the 2 edits, apply none (default)
#   scripts/fix-cron-delivery.sh --apply       # actually edit the live cron jobs
#
# Exit codes: 0 ok / dry-run printed; 2 usage or missing chat_id / cron id (fail
# closed — never edits with an empty recipient).

set -euo pipefail

# The fleet-heartbeat cron id, as recorded in
# fleet-heartbeat/scripts/FIX-RESCUE-12-cleanup-and-cron.md. Overridable via env
# in case the job is re-created with a new id.
readonly DEFAULT_FLEET_HEARTBEAT_CRON_ID="3f0f33c9-41d9-4244-a02f-3a94819eaa8e"

log() { printf '%s fix-cron-delivery: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 2; }

usage() {
  cat >&2 <<'USAGE'
Usage: fix-cron-delivery.sh [--dry-run | --apply]

Sets an explicit delivery.channel=telegram + delivery.to=<chat_id> on the
fleet-heartbeat and mission-control-standup OpenClaw crons so they stop
failing closed ("Refusing implicit isolated cron delivery").

  --dry-run   print the two `openclaw cron edit` commands, apply none (default)
  --apply     actually edit the live cron jobs (Named Stop — deliberate)

Environment (never hardcoded):
  TREVOR_TELEGRAM_CHAT_ID / RESCUE_RANGERS_CHAT_ID   recipient chat id (required)
  FLEET_HEARTBEAT_CRON_ID        fleet-heartbeat cron id (default: the id from
                                 FIX-RESCUE-12-cleanup-and-cron.md)
  MISSION_CONTROL_STANDUP_CRON_ID  standup cron id (else discovered via
                                 `openclaw cron list`)
USAGE
}

# ── argument parse ────────────────────────────────────────────────────────────
APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) APPLY=0; shift ;;
    --apply)   APPLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)         usage; die "unknown argument: $1" ;;
  esac
done

# ── resolve the recipient chat id (NEVER hardcoded) ───────────────────────────
CHAT_ID="${TREVOR_TELEGRAM_CHAT_ID:-${RESCUE_RANGERS_CHAT_ID:-}}"
[ -n "$CHAT_ID" ] || die "no recipient chat id: set TREVOR_TELEGRAM_CHAT_ID (or RESCUE_RANGERS_CHAT_ID). Refusing to edit a cron with an empty delivery.to."

# ── resolve the two cron job ids ──────────────────────────────────────────────
FLEET_HEARTBEAT_CRON_ID="${FLEET_HEARTBEAT_CRON_ID:-$DEFAULT_FLEET_HEARTBEAT_CRON_ID}"
MISSION_CONTROL_STANDUP_CRON_ID="${MISSION_CONTROL_STANDUP_CRON_ID:-}"
if [ -z "$MISSION_CONTROL_STANDUP_CRON_ID" ]; then
  # Discover it from the live cron list (name match). Fail closed if it cannot
  # be found rather than editing the wrong job.
  if command -v openclaw >/dev/null 2>&1; then
    MISSION_CONTROL_STANDUP_CRON_ID="$(openclaw cron list 2>/dev/null \
      | grep -i 'mission-control-standup' \
      | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' \
      | head -1 || true)"
  fi
fi
[ -n "$FLEET_HEARTBEAT_CRON_ID" ] || die "no fleet-heartbeat cron id (set FLEET_HEARTBEAT_CRON_ID)"
[ -n "$MISSION_CONTROL_STANDUP_CRON_ID" ] || die "no mission-control-standup cron id (set MISSION_CONTROL_STANDUP_CRON_ID, or ensure 'openclaw cron list' shows it)"

# ── build the edit command for one job ────────────────────────────────────────
# `openclaw cron edit <id> --channel telegram --to <chat_id>` sets the delivery
# route IN PLACE (idempotent — re-running sets the same fields, never appends).
cron_edit_cmd() {
  local id="$1"
  printf 'openclaw cron edit %s --channel telegram --to %s' "$id" "$CHAT_ID"
}

FLEET_CMD="$(cron_edit_cmd "$FLEET_HEARTBEAT_CRON_ID")"
STANDUP_CMD="$(cron_edit_cmd "$MISSION_CONTROL_STANDUP_CRON_ID")"

# ── dry-run: print, apply none ────────────────────────────────────────────────
if [ "$APPLY" -ne 1 ]; then
  log "DRY-RUN — the following edits would be applied (run with --apply to execute):"
  printf '%s\n' "$FLEET_CMD"
  printf '%s\n' "$STANDUP_CMD"
  exit 0
fi

# ── apply: edit the live cron jobs (Named Stop) ───────────────────────────────
command -v openclaw >/dev/null 2>&1 || die "openclaw CLI not found on PATH; cannot apply"

log "applying: $FLEET_CMD"
eval "$FLEET_CMD"
log "applying: $STANDUP_CMD"
eval "$STANDUP_CMD"

log "done. Verify with: openclaw cron list | grep -E 'fleet-heartbeat|mission-control-standup'"
log "both jobs should now show delivery.channel=telegram and a non-empty delivery.to."
exit 0
