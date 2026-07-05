#!/usr/bin/env bash
# install-heartbeat-direct-cron.sh  (FIX-RESCUE-12 part ii)
#
# Convert the fleet heartbeat from an OpenClaw AGENT cron (a full LLM turn every
# hour, billed on Ollama Cloud) to a DIRECT launchd command cron -- the same way
# the rescue poller and watchdog already run. heartbeat.sh is fully deterministic
# and needs no model turn to launch.
#
# SAFE BY DEFAULT: dry-run. It renders the plist and prints the exact commands it
# WOULD run (load the direct cron, and the operator-confirmed command to remove
# the old agent cron). Pass --apply to install the launchd job. Removing the old
# agent cron is left as an explicit printed command so nothing the receiver is
# mid-using is torn down without the operator's eyes on it.
#
#   ./install-heartbeat-direct-cron.sh            # dry-run (default)
#   ./install-heartbeat-direct-cron.sh --apply    # install the launchd job
set -uo pipefail

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPTS_DIR/.." && pwd)"
TEMPLATE="$ROOT/launchd/ai.openclaw.fleet-heartbeat.plist.template"
HEARTBEAT_SH="$SCRIPTS_DIR/heartbeat.sh"
LOG_DIR="$ROOT/logs"
LABEL="ai.openclaw.fleet-heartbeat"
DEST="$HOME/Library/LaunchAgents/${LABEL}.plist"

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

BASH_BIN="/opt/homebrew/bin/bash"
[ -x "$BASH_BIN" ] || BASH_BIN="$(command -v bash)"

say() { printf '%s\n' "$*"; }

[ -f "$TEMPLATE" ]     || { say "FATAL: template not found: $TEMPLATE"; exit 1; }
[ -f "$HEARTBEAT_SH" ] || { say "FATAL: heartbeat.sh not found: $HEARTBEAT_SH"; exit 1; }

say "== fleet-heartbeat -> direct launchd cron =="
say "label       : $LABEL"
say "heartbeat.sh: $HEARTBEAT_SH"
say "bash        : $BASH_BIN"
say "dest plist  : $DEST"
[ "$APPLY" = "1" ] && say "mode        : APPLY" || say "mode        : DRY-RUN (pass --apply)"
say ""

RENDERED="$(sed \
  -e "s#__HEARTBEAT_SH__#${HEARTBEAT_SH}#g" \
  -e "s#__LOG_DIR__#${LOG_DIR}#g" \
  -e "s#__BASH__#${BASH_BIN}#g" \
  "$TEMPLATE")"

UID_NUM="$(id -u)"
if [ "$APPLY" = "1" ]; then
  mkdir -p "$(dirname "$DEST")" "$LOG_DIR"
  printf '%s\n' "$RENDERED" > "$DEST"
  say "wrote $DEST"
  # Reload idempotently.
  launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/${UID_NUM}" "$DEST" 2>/dev/null || launchctl load -w "$DEST" 2>/dev/null || true
  launchctl enable "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
  say "loaded launchd job $LABEL (fires minute 0 of hours 06-21)"
else
  say "--- rendered plist (dry-run; not written) ---"
  printf '%s\n' "$RENDERED"
  say "--- end plist ---"
fi

say ""
say "NEXT (operator, confirm then run): remove the old OpenClaw AGENT cron so the"
say "heartbeat no longer spins an hourly LLM turn. Identify it, then delete it:"
say ""
say "    openclaw cron list | grep -i heartbeat"
say "    openclaw cron delete <the-fleet-heartbeat-agent-cron-id>"
say ""
say "Verify the direct job:  launchctl print gui/${UID_NUM}/${LABEL} | grep -E 'state|last exit'"
