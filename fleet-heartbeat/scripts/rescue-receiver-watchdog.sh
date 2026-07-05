#!/usr/bin/env bash
# rescue-receiver-watchdog.sh
#
# Watchdog for the rescue-receiver HTTP service (port 8799).
#
# Runs from cron every minute:
#   * * * * * /Users/blackceomacmini/clawd/fleet-heartbeat/scripts/rescue-receiver-watchdog.sh
#
# Behaviour:
#   1. Pings http://127.0.0.1:8799/health (5s connect / 8s total timeout).
#   2. If 200 OK: clear the alarm flag (re-arms for next down-episode) and exit.
#   3. If any other response:
#      a. Kickstart via launchctl to restart the receiver.
#      b. Post ONE alarm line to the OpenClaw Fixer topic
#         (chat -1003865262028, thread 3) using the Rescue Rangers bot.
#         A flag file prevents spam: alarm fires only on the first detection
#         of a down-episode; the flag is cleared only when 200 is seen again
#         (down->up transition), re-arming for the next incident.
#
# Anti-furnace guarantees:
#   - Hard ulimit on CPU seconds and virtual memory.
#   - No loops; the script runs once and exits.
#   - All curl calls have explicit --max-time caps.
#   - Log rotation guard: log is capped at 5 000 lines via tail-trim on each run.

set -uo pipefail

# ---------------------------------------------------------------------------
# Anti-furnace: hard resource caps so this script can never spin
# ---------------------------------------------------------------------------
ulimit -t 30       2>/dev/null || true   # max 30 CPU seconds
ulimit -v 524288   2>/dev/null || true   # max 512 MB virtual memory

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
HEALTH_URL="http://127.0.0.1:8799/health"
LOG="$HOME/.openclaw/logs/rescue-receiver-watchdog.log"
FLAG_FILE="$HOME/.openclaw/logs/rescue-receiver-watchdog-alarm.flag"
LAUNCHD_LABEL="ai.openclaw.rescue-receiver"
FIXER_CHAT_ID="-1003865262028"
FIXER_THREAD_ID="3"
LOG_MAX_LINES=5000
# Bounded auto-restart: stop kickstarting after MAX_RESTARTS consecutive DOWN
# ticks so a genuinely broken receiver is not churned forever (anti-crash-loop).
# The counter resets to 0 on the first healthy (200) tick. Cron runs every
# minute, so this auto-restarts for ~MAX_RESTARTS minutes, then holds + escalates.
MAX_RESTARTS=5
RESTART_COUNT_FILE="$HOME/.openclaw/logs/rescue-receiver-watchdog-restart.count"
# FIX-RESCUE-02 crash-loop escalation dedup flag. Distinct from FLAG_FILE: the
# first-detection alarm fires once per down-episode ("auto-restarting"); THIS
# flag fires once when the kickstart budget is exhausted while the receiver is
# still down -- i.e. kickstart is provably NOT helping (a deterministic crash in
# rescue-receiver-run.sh / .env, not a transient stall). Both clear on recovery.
CRASHLOOP_FLAG="$HOME/.openclaw/logs/rescue-receiver-watchdog-crashloop.flag"

mkdir -p "$(dirname "$LOG")"

# Trim log if it exceeds LOG_MAX_LINES (anti-furnace: bounded disk usage)
if [ -f "$LOG" ]; then
  LINE_COUNT="$(wc -l < "$LOG" 2>/dev/null || echo 0)"
  if [ "$LINE_COUNT" -gt "$LOG_MAX_LINES" ]; then
    TRIMMED="$(tail -n "$LOG_MAX_LINES" "$LOG")"
    printf '%s\n' "$TRIMMED" > "$LOG"
  fi
fi

logw() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG" 2>/dev/null || true; }

# ---------------------------------------------------------------------------
# Load secrets (same order as rescue-receiver-run.sh)
# ---------------------------------------------------------------------------
# `set -u` (line 26) would abort mid-source on any unquoted `$` in a secret
# value ("|| true" does NOT catch a -u abort) -- the same bug that crash-looped
# the receiver. Drop -u across the source calls so the watchdog itself survives.
set -a
set +u
[ -f "$HOME/clawd/secrets/.env" ]     && source "$HOME/clawd/secrets/.env"     2>/dev/null || true
[ -f "$HOME/.openclaw/secrets/.env" ] && source "$HOME/.openclaw/secrets/.env" 2>/dev/null || true
set -u
set +a

# Re-armed (was hard-disabled BOT_TOKEN=""). Pull the Rescue Rangers bot token
# from the sourced secret store -- never hardcoded, never printed. Stays empty
# until the secret store loads it, and the alarm path below degrades gracefully
# if unset. Posts ONLY to the operator Fixer/Rescue-Rangers topic, never a client.
BOT_TOKEN="${RESCUE_RANGERS_BOT_TOKEN:-}"

# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------
HTTP_STATUS="$(curl -sf --connect-timeout 5 --max-time 8 -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null)" || HTTP_STATUS=""

if [ "$HTTP_STATUS" = "200" ]; then
  # Healthy: clear flag AND reset restart counter (re-arms both for next episode)
  if [ -f "$FLAG_FILE" ]; then
    rm -f "$FLAG_FILE" 2>/dev/null || true
    logw "WATCHDOG receiver back UP — alarm flag cleared (re-armed)"
  fi
  rm -f "$RESTART_COUNT_FILE" 2>/dev/null || true
  if [ -f "$CRASHLOOP_FLAG" ]; then
    rm -f "$CRASHLOOP_FLAG" 2>/dev/null || true
    logw "WATCHDOG receiver back UP — crash-loop escalation flag cleared (re-armed)"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# FIX-RESCUE-02 helper: best-effort read of the launchd job's LAST exit code.
# Used only to enrich the crash-loop diagnostic (never a hard dependency: the
# restart-budget counter is the authoritative crash-loop signal). `launchctl
# print` output format varies by macOS version, so this parses defensively and
# returns "?" when it cannot determine the value.
# ---------------------------------------------------------------------------
last_exit_code() {
  local uidn="$1" label="$2" out code
  out="$(launchctl print "gui/${uidn}/${label}" 2>/dev/null)" || { echo "?"; return; }
  # Matches: "last exit code = 1" / "last exit status = 256". sed -E (ERE) so the
  # (code|status) alternation is portable on BSD/macOS sed (BRE \| is NOT).
  code="$(printf '%s\n' "$out" | sed -n -E 's/.*last exit (code|status) *= *([0-9]+).*/\2/p' | head -n1)"
  [ -n "$code" ] && echo "$code" || echo "?"
}

# ---------------------------------------------------------------------------
# Receiver is DOWN
# ---------------------------------------------------------------------------
# Bounded auto-restart guard: read consecutive-DOWN restart counter
RESTART_COUNT=0
if [ -f "$RESTART_COUNT_FILE" ]; then
  RESTART_COUNT="$(cat "$RESTART_COUNT_FILE" 2>/dev/null || echo 0)"
  case "$RESTART_COUNT" in ''|*[!0-9]*) RESTART_COUNT=0 ;; esac
fi

UID_NUM="$(id -u)"
# CRASH_LOOP=1 once the auto-restart budget is exhausted while still DOWN: N
# kickstarts fired and the receiver never came back => kickstart is NOT the
# remedy (the FIX-RESCUE-02 crash-loop signature).
CRASH_LOOP=0
if [ "$RESTART_COUNT" -lt "$MAX_RESTARTS" ]; then
  logw "WATCHDOG health check FAILED (http_status=${HTTP_STATUS:-no-response}) — restart attempt $((RESTART_COUNT + 1))/${MAX_RESTARTS}"
  launchctl kickstart -k "gui/${UID_NUM}/${LAUNCHD_LABEL}" >> "$LOG" 2>&1 || true
  printf '%s' "$((RESTART_COUNT + 1))" > "$RESTART_COUNT_FILE" 2>/dev/null || true
  logw "WATCHDOG launchctl kickstart fired for gui/${UID_NUM}/${LAUNCHD_LABEL}"
else
  # Auto-restart budget exhausted: STOP churning a broken receiver (no infinite
  # loop). Hold for manual intervention and escalate once via the crash-loop
  # flag dedup below. Counter clears automatically on the next healthy tick.
  CRASH_LOOP=1
  logw "WATCHDOG restart budget exhausted (${RESTART_COUNT}/${MAX_RESTARTS}) — NOT kickstarting; holding for manual intervention (crash-loop)"
fi

# ---------------------------------------------------------------------------
# Post alarms to the operator Fixer/Rescue-Rangers topic (never a client).
# Operator-verbose is correct here: the we-move-in-silence rule is client-facing
# only. Two independently-deduped alarms:
#   1. First-detection ("auto-restarting") — fires once per down-episode.
#   2. Crash-loop escalation ("kickstart will not help") — fires once when the
#      restart budget is exhausted while still DOWN. Distinct message + flag so
#      the operator is told to check run.sh/.env, not to wait on a self-heal.
# Both flags clear only on a 200 tick (down->up), re-arming for the next episode.
# ---------------------------------------------------------------------------
post_alarm() {
  # $1 = flag file (dedup), $2 = message text
  local flag="$1" msg="$2" msg_json payload result
  if [ -z "$BOT_TOKEN" ]; then
    logw "WATCHDOG WARNING: RESCUE_RANGERS_BOT_TOKEN not found — cannot post alarm"
    return 0
  fi
  if [ -f "$flag" ]; then
    logw "WATCHDOG alarm already sent (flag $(basename "$flag") present) — suppressing"
    return 0
  fi
  # Write flag BEFORE the curl call so a crash can't produce double-posts.
  printf '%s' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$flag"
  msg_json="${msg//\"/\\\"}"
  payload="{\"chat_id\":\"${FIXER_CHAT_ID}\",\"message_thread_id\":${FIXER_THREAD_ID},\"text\":\"${msg_json}\"}"
  result="$(curl -sf --connect-timeout 5 --max-time 10 \
      -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
      -H 'Content-Type: application/json' \
      -d "$payload" 2>/dev/null)" || result="curl-error"
  logw "WATCHDOG alarm posted to Fixer topic (chat ${FIXER_CHAT_ID} thread ${FIXER_THREAD_ID}) — result: ${result:0:120}"
}

ALARM_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ "$CRASH_LOOP" = "1" ]; then
  # Kickstart provably did not help: page the distinct crash-loop escalation.
  EXIT_CODE="$(last_exit_code "$UID_NUM" "$LAUNCHD_LABEL")"
  post_alarm "$CRASHLOOP_FLAG" \
    "[RR-WATCHDOG] rescue-receiver CRASH-LOOPING on operator Mac — ${MAX_RESTARTS} kickstarts fired and it never came back (launchd last exit code=${EXIT_CODE}). Auto-restart is HELD; kickstart will NOT help. Almost certainly a deterministic fault in rescue-receiver-run.sh / secrets .env (e.g. an unquoted \$ under set -u). Manual fix needed — check ~/.openclaw/logs/rescue-receiver.log"
else
  # First detection of this down-episode: normal auto-restart page.
  post_alarm "$FLAG_FILE" \
    "[RR-WATCHDOG] rescue-receiver DOWN on operator Mac — auto-restarting (attempt $((RESTART_COUNT + 1))/${MAX_RESTARTS}) at ${ALARM_TS}. If it does not recover the watchdog will escalate a crash-loop page. Check ~/.openclaw/logs/rescue-receiver.log"
fi

exit 0
