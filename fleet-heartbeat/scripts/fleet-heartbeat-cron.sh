#!/opt/homebrew/bin/bash
# fleet-heartbeat-cron.sh — deterministic launcher for the fleet heartbeat.
#
# FIX-RESCUE-12 (ii): the `fleet-heartbeat` OpenClaw cron used to fire a full
# LLM *agent turn* (sessionTarget=isolated, model=ollama/llama3.2:latest,
# toolsAllow=[exec]) once per fire just to shell the deterministic
# `heartbeat.sh` and, on a non-zero exit, forward the rc + log tail to the
# Rescue Rangers room. That is an Ollama-Cloud furnace: an LLM turn per fire
# for work that needs no model. This wrapper reproduces that behaviour with a
# plain shell command so the heartbeat can run as a direct-command cron
# (launchd or system crontab) exactly like the poller and the receiver
# watchdog already do — no agent turn, no model, no tokens.
#
# Behaviour parity with the retired agent-turn payload:
#   1. Run heartbeat.sh, capture rc + stdout.
#   2. If rc == 0 -> nothing to announce (heartbeat.sh already ships its own
#      Telegram report through the gateway when it has something to say).
#   3. If rc != 0 -> forward "heartbeat rc=<rc> + tail" (last 20 lines of
#      heartbeat.log) to the Rescue Rangers room through the OpenClaw gateway,
#      never a raw Telegram curl (standing rule: never bypass the gateway).
#
# Env (sourced from the same .env files the receiver uses; all optional):
#   FH_ROOT                     override the fleet-heartbeat root
#   OPENCLAW                    path to the openclaw CLI
#   RESCUE_RANGERS_CHAT_ID      Telegram chat/topic to receive failure tails
#                               (falls back to RESCUE_RANGERS_HELP_CHAT_ID).
#                               If neither is set, the failure tail is logged
#                               only — never hard-coded here (fleet-wide repo).
set -u

FH_ROOT="${FH_ROOT:-/Users/blackceomacmini/clawd/fleet-heartbeat}"
HEARTBEAT="${FH_ROOT}/scripts/heartbeat.sh"
LOG_DIR="${FH_ROOT}/logs"
HEARTBEAT_LOG="${LOG_DIR}/heartbeat.log"
OPENCLAW="${OPENCLAW:-/Users/blackceomacmini/.local/bin/openclaw}"
mkdir -p "$LOG_DIR"

# Load secrets the same additive way rescue-receiver-run.sh does, so a
# launchd/crontab invocation has the same environment an interactive shell
# (or the old agent-turn exec) would have. Never prints values.
set -a
# shellcheck disable=SC1090
[ -f "$HOME/clawd/secrets/.env" ]     && . "$HOME/clawd/secrets/.env"     2>/dev/null || true
# shellcheck disable=SC1090
[ -f "$HOME/.openclaw/secrets/.env" ] && . "$HOME/.openclaw/secrets/.env" 2>/dev/null || true
set +a

ts() { date "+%Y-%m-%dT%H:%M:%S%z"; }

if [ ! -x "$HEARTBEAT" ] && [ ! -f "$HEARTBEAT" ]; then
  echo "$(ts) fleet-heartbeat-cron: heartbeat.sh not found at $HEARTBEAT" >>"$HEARTBEAT_LOG"
  exit 127
fi

# Run the deterministic heartbeat. Its own stdout/stderr already append to
# heartbeat.log via the script's internal redirects; we also capture stdout
# here so the wrapper can log the one-line result.
out="$("$HEARTBEAT" 2>>"$HEARTBEAT_LOG")"
rc=$?
echo "$(ts) fleet-heartbeat-cron: rc=${rc} result=${out:-<none>}" >>"$HEARTBEAT_LOG"

if [ "$rc" -eq 0 ]; then
  # heartbeat.sh handles its own send when warranted; nothing more to do.
  exit 0
fi

# --- Non-zero exit: forward rc + tail to the Rescue Rangers room ------------
chat="${RESCUE_RANGERS_CHAT_ID:-${RESCUE_RANGERS_HELP_CHAT_ID:-}}"
tail_txt="$(tail -n 20 "$HEARTBEAT_LOG" 2>/dev/null)"

if [ -z "$chat" ]; then
  echo "$(ts) fleet-heartbeat-cron: rc=${rc} but no RESCUE_RANGERS_CHAT_ID set; tail logged only, not sent" >>"$HEARTBEAT_LOG"
  exit "$rc"
fi

"$OPENCLAW" message send \
  --channel telegram \
  --account "${HEARTBEAT_TG_ACCOUNT:-rescue-rangers}" \
  -t "$chat" \
  -m "fleet-heartbeat rc=${rc}
$tail_txt" \
  >>"$HEARTBEAT_LOG" 2>&1 || \
  echo "$(ts) fleet-heartbeat-cron: failure-tail send failed" >>"$HEARTBEAT_LOG"

exit "$rc"
