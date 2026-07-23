#!/usr/bin/env bash
# fix-disk-usage-alert-cron.sh — U014: fix disk-usage-alert cron delivery
# (same explicit channel + recipient pattern as U012's fix-cron-delivery.sh).
#
# The disk-usage-alert cron uses `announce -> last` delivery with no prior
# recipient, triggering "Refusing implicit isolated cron delivery" (99x errors).
# This script edits the cron job to set explicit delivery.channel + delivery.to.
#
# Usage:
#   ./scripts/fix-disk-usage-alert-cron.sh            # apply the fix
#   ./scripts/fix-disk-usage-alert-cron.sh --dry-run  # print commands, apply none
#
# Idempotent: re-running the script changes nothing if the fix is already applied.

set -euo pipefail

DRY_RUN=0
CHANNEL="${OPENCLAW_CRON_DELIVERY_CHANNEL:-telegram}"
RECIPIENT="${OPENCLAW_CRON_DELIVERY_TO:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)        DRY_RUN=1;         shift ;;
    --channel)        CHANNEL="$2";      shift 2 ;;
    --recipient)      RECIPIENT="$2";    shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$RECIPIENT" ]]; then
  echo "ERROR: OPENCLAW_CRON_DELIVERY_TO is not set. Set it or pass --recipient <chat_id>." >&2
  echo "  Example: OPENCLAW_CRON_DELIVERY_TO=123456789 ./scripts/fix-disk-usage-alert-cron.sh" >&2
  exit 2
fi

log() { printf '[fix-disk-usage-alert-cron] %s\n' "$*" >&2; }

CRON_NAME="disk-usage-alert"

if ! command -v openclaw &>/dev/null; then
  echo "ERROR: openclaw CLI not found on PATH." >&2
  exit 1
fi

# Check if the cron job exists.
JOB_INFO=$(openclaw cron list --json 2>/dev/null || echo "[]")
EXISTS=$(printf '%s' "$JOB_INFO" | python3 -s -c "
import sys, json
jobs = json.load(sys.stdin)
for j in jobs:
    if j.get('name') == '${CRON_NAME}':
        print('true')
        break
else:
    print('false')
" 2>/dev/null || echo "false")

if [[ "$EXISTS" != "true" ]]; then
  echo "ERROR: cron job '${CRON_NAME}' not found in openclaw cron list." >&2
  exit 1
fi

# Check current delivery config — if already has explicit channel + recipient, skip.
CURRENT_DELIVERY=$(printf '%s' "$JOB_INFO" | python3 -s -c "
import sys, json
jobs = json.load(sys.stdin)
for j in jobs:
    if j.get('name') == '${CRON_NAME}':
        d = j.get('delivery', {})
        ch = d.get('channel', '')
        to = d.get('to', '')
        print(ch + '\t' + to)
        break
" 2>/dev/null || echo $'\t')

CURRENT_CHANNEL="${CURRENT_DELIVERY%%$'\t'*}"
CURRENT_TO="${CURRENT_DELIVERY#*$'\t'}"

if [[ -n "$CURRENT_CHANNEL" && "$CURRENT_CHANNEL" != "null" && "$CURRENT_CHANNEL" != "announce" && -n "$CURRENT_TO" && "$CURRENT_TO" != "null" ]]; then
  log "cron '${CRON_NAME}' already has explicit delivery: channel=${CURRENT_CHANNEL}, to=${CURRENT_TO}"
  log "idempotent — nothing to do."
  exit 0
fi

log "cron '${CRON_NAME}' delivery: channel=${CURRENT_CHANNEL:-none}, to=${CURRENT_TO:-none} — needs fix"

EDIT_CMD="openclaw cron edit ${CRON_NAME} --delivery-channel ${CHANNEL} --delivery-to ${RECIPIENT}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "DRY-RUN: would run: ${EDIT_CMD}"
  exit 0
fi

log "running: ${EDIT_CMD}"
# shellcheck disable=SC2086
openclaw cron edit "$CRON_NAME" --delivery-channel "$CHANNEL" --delivery-to "$RECIPIENT"

log "fix applied. Verify with: openclaw cron list | grep ${CRON_NAME}"
