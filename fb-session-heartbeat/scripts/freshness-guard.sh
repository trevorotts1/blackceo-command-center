#!/bin/bash
# FB-SESSION HEARTBEAT dead-man guard (hourly cron, a SEPARATE crontab line).
# Exists because this project's ledger reconciler died for 3+ days when its
# single crontab line was commented out while its output still looked fresh.
# This guard catches exactly that failure mode:
#   1. state/last-run.json older than STALE_MIN minutes  -> ALERT (heartbeat
#      is not actually firing; its output must never be trusted as current).
#   2. the main run.sh crontab line missing/commented    -> ALERT.
# A one-line comment-out of the main job cannot silence both lines at once.
# Alerts route through the same dedup guardrail (6h window; no daily spam).
set -u
export PATH="/Users/blackceomacmini/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export OPERATOR_TELEGRAM_CHAT_ID="${OPERATOR_TELEGRAM_CHAT_ID:-5252140759}"
ROOT="/Users/blackceomacmini/clawd/fb-session-heartbeat"
DEDUP="/opt/homebrew/bin/python3 $ROOT/scripts/alert-dedup.py"
STATE_DIR="$ROOT/state/alerts"
LAST="$ROOT/state/last-run.json"
STALE_MIN=40
now=$(date +%s)
problems=0

if [ ! -f "$LAST" ]; then
  $DEDUP raise --state-dir "$STATE_DIR" --client operator \
    --service heartbeat --failure-class stale \
    --message "fb-session heartbeat has NEVER written state/last-run.json. It is not running. Facebook session status is UNKNOWN, not green." || true
  problems=1
else
  age_min=$(( (now - $(stat -f %m "$LAST")) / 60 ))
  if [ "$age_min" -gt "$STALE_MIN" ]; then
    $DEDUP raise --state-dir "$STATE_DIR" --client operator \
      --service heartbeat --failure-class stale \
      --message "fb-session heartbeat output is STALE: last run ${age_min} min ago (limit ${STALE_MIN}). The check is NOT firing; do not trust its last status. Check crontab and $ROOT/logs/cron.log." || true
    problems=1
  fi
fi

if ! crontab -l 2>/dev/null | grep -E '^[^#]*fb-session-heartbeat/scripts/run\.sh' >/dev/null; then
  $DEDUP raise --state-dir "$STATE_DIR" --client operator \
    --service heartbeat --failure-class cron_missing \
    --message "fb-session heartbeat crontab line for run.sh is MISSING or commented out. The session check is dead until it is restored (this is the reconciler failure mode)." || true
  problems=1
fi

if [ "$problems" -eq 0 ]; then
  $DEDUP recover --state-dir "$STATE_DIR" --client operator \
    --service heartbeat --failure-class stale \
    --message "fb-session heartbeat is firing on schedule again." >/dev/null || true
  $DEDUP recover --state-dir "$STATE_DIR" --client operator \
    --service heartbeat --failure-class cron_missing \
    --message "fb-session heartbeat crontab line restored." >/dev/null || true
fi
echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] guard done problems=$problems"
