#!/bin/bash
# FB-SESSION HEARTBEAT cron wrapper. Crontab runs this every 15 minutes.
# Cron's environment is minimal, so pin PATH and the operator alert target here.
# Alert egress is ONLY scripts/alert-dedup.py -> `openclaw message send`.
set -u
export PATH="/Users/blackceomacmini/.local/bin:/Users/blackceomacmini/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export OPERATOR_TELEGRAM_CHAT_ID="${OPERATOR_TELEGRAM_CHAT_ID:-5252140759}"
ROOT="/Users/blackceomacmini/clawd/fb-session-heartbeat"
exec /opt/homebrew/bin/python3 "$ROOT/scripts/fb-session-check.py" >> "$ROOT/logs/cron.log" 2>&1
