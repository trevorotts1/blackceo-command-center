#!/bin/bash
# fix-cron-delivery.sh — repair fleet-heartbeat + mission-control-standup cron
# delivery so they no longer fail-closed with "announce -> last" having no route.
#
# U012: Both cron jobs use `announce -> last` delivery with no prior recipient,
# so every fire fails with "Refusing implicit isolated cron delivery" (91x / 58x).
# This script sets explicit `delivery.channel=telegram` + `delivery.to=<chat_id>`
# on each job.  Idempotent — re-running it on an already-corrected job is a no-op.

set -euo pipefail

die()  { printf 'ERROR: %s\n' "$1" >&2; exit 1; }
warn() { printf 'WARN:  %s\n' "$1" >&2; }
info() { printf 'INFO:  %s\n' "$1" >&2; }

OPENCLAW="${OPENCLAW:-openclaw}"

DRY_RUN=true
APPLY=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true;  APPLY=false ;;
    --apply)   DRY_RUN=false; APPLY=true  ;;
    *) die "Unknown flag: $arg  (use --dry-run or --apply)" ;;
  esac
done
$DRY_RUN && info "DRY-RUN mode — printing planned edits, no changes will be made."

resolve_chat_id() {
  if [[ -n "${TELEGRAM_CHAT_ID:-}" ]]; then
    printf '%s' "$TELEGRAM_CHAT_ID"
    return 0
  fi
  local cfg="${OPENCLAW_CONFIG:-${HOME}/.openclaw/openclaw.json}"
  if [[ -f "$cfg" ]] && command -v jq &>/dev/null; then
    local from_cfg
    from_cfg="$(jq -r '.channels.telegram.allowFrom[0] // empty' "$cfg" 2>/dev/null)" || true
    if [[ -n "$from_cfg" ]]; then
      printf '%s' "$from_cfg"
      return 0
    fi
  fi
  return 1
}

CHAT_ID=""
if CHAT_ID="$(resolve_chat_id)"; then
  info "chat_id resolved to: $CHAT_ID"
else
  die "TELEGRAM_CHAT_ID not set and not found in OpenClaw config.
  Set TELEGRAM_CHAT_ID or ensure ~/.openclaw/openclaw.json has channels.telegram.allowFrom[0]."
fi

discover_cron_jobs() {
  local list_json
  list_json="$("$OPENCLAW" cron list --json 2>/dev/null)" || {
    die "openclaw cron list failed — is the OpenClaw CLI installed and on PATH?"
  }
  printf '%s' "$list_json" | jq -c '[.[] | select(
    (.name // "" | ascii_downcase | test("fleet-heartbeat"))
    or
    (.name // "" | ascii_downcase | test("mission-control-standup"))
  ) | {name: .name, id: .id}]' 2>/dev/null
}

cron_delivery_is_fixed() {
  local id="$1"
  local detail
  detail="$("$OPENCLAW" cron inspect "$id" --json 2>/dev/null)" || return 1
  local channel to
  channel="$(printf '%s' "$detail" | jq -r '.delivery.channel // empty' 2>/dev/null)" || true
  to="$(printf '%s' "$detail" | jq -r '.delivery.to // empty' 2>/dev/null)" || true
  [[ "$channel" == "telegram" && -n "$to" ]]
}

fix_one_cron() {
  local name="$1" id="$2"
  if cron_delivery_is_fixed "$id"; then
    info "  $name ($id): already fixed — skipping (idempotent)"
    return 0
  fi
  if $DRY_RUN; then
    printf '  DRY-RUN: openclaw cron edit %s --set delivery.channel=telegram --set delivery.to=%s\n' \
      "$id" "$CHAT_ID"
    return 0
  fi
  info "  $name ($id): setting delivery.channel=telegram + delivery.to=$CHAT_ID"
  "$OPENCLAW" cron edit "$id" \
    --set "delivery.channel=telegram" \
    --set "delivery.to=$CHAT_ID" \
    2>&1 || die "Failed to edit cron job $name ($id)"
  sleep 0.3
  if cron_delivery_is_fixed "$id"; then
    info "  $name ($id): verified — delivery now channel=telegram, to=<chat_id>"
  else
    warn "  $name ($id): edit appeared to succeed but post-verify failed — check manually"
  fi
}

JOBS_JSON="$(discover_cron_jobs)"
if [[ -z "$JOBS_JSON" || "$JOBS_JSON" == "[]" ]]; then
  die "No fleet-heartbeat or mission-control-standup cron jobs found.
  Confirm both crons exist: openclaw cron list | grep -E 'fleet-heartbeat|mission-control-standup'"
fi

JOB_COUNT="$(printf '%s' "$JOBS_JSON" | jq 'length')"
info "Found $JOB_COUNT cron job(s) to check."

FIXED=0 ALREADY=0
while IFS= read -r job; do
  name="$(printf '%s' "$job" | jq -r '.name')"
  id="$(printf '%s' "$job" | jq -r '.id')"
  if cron_delivery_is_fixed "$id"; then
    info "  $name ($id): already fixed — skipping"
    ALREADY=$((ALREADY + 1))
  else
    fix_one_cron "$name" "$id"
    $DRY_RUN || FIXED=$((FIXED + 1))
  fi
done < <(printf '%s' "$JOBS_JSON" | jq -c '.[]')

echo ""
if $DRY_RUN; then
  echo "DRY-RUN complete.  $ALREADY already fixed, $JOB_COUNT total."
  echo "Run with --apply to execute the changes."
else
  echo "Done.  Fixed: $FIXED, already OK: $ALREADY."
fi
