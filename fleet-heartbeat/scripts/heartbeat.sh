#!/opt/homebrew/bin/bash
# Fleet heartbeat orchestrator (Remote Rescue posture).
#
# What this does:
#   1. Runs the parallel probe across all 8 client VPSes.
#   2. For each DOWN client, fires the remediation chain BEFORE alerting
#      (unless HEARTBEAT_MODE=smoke-test, in which case the chain is logged
#      as "would-run" only).
#   3. Decides whether this fire is a "summary" fire (always sends) or a
#      "watch" fire (sends only on failure or in smoke-test mode), based on
#      the hour-of-day.
#   4. Formats a Telegram-friendly message and ships it through OpenClaw's
#      gateway to Trevor's chat (chat_id 5252140759).
#
# Smoke-test mode:
#   HEARTBEAT_MODE=smoke-test forces a labeled smoke-test send. To simulate
#   a DOWN row, set SIMULATE_DOWN=ClientName (probe-fleet.sh honors this).
#   In smoke-test mode the remediation chain is DETECTED AND SKIPPED for
#   the simulated row; instead the message shows "would have run: <cmds>".
#
# Schedule contract (matches the registered cron):
#   - Cron fires at minute 0 of hours 6..21 inclusive, America/New_York.
#   - At hours 6 and 21, a full per-client status summary is ALWAYS sent.
#   - At hours 7..20, a message is sent ONLY IF one or more clients are
#     down (gateway DOWN, ssh DOWN, or version UNKNOWN).
#   - Smoke-test mode always sends, regardless of hour.

set -u

ROOT="/Users/blackceomacmini/clawd/fleet-heartbeat"
PROBE="${ROOT}/scripts/probe-fleet.sh"
REMEDIATE="${ROOT}/scripts/remediate.sh"
SESSION_HEALTH="${ROOT}/scripts/session-health.sh"
CHANGE_LOG="${ROOT}/change-log.md"
OPENCLAW="/Users/blackceomacmini/.local/bin/openclaw"
LOG_DIR="${ROOT}/logs"
mkdir -p "$LOG_DIR"

CHAT_ID="${TREVOR_TELEGRAM_CHAT_ID:-5252140759}"

now_local=$(date "+%Y-%m-%d %H:%M %Z")
hour=$(date "+%H")
hour=${hour#0}
[ -z "$hour" ] && hour=0

# Mode: summary at 6 and 21, watch otherwise.
mode="watch"
if [ "$hour" = "6" ] || [ "$hour" = "21" ]; then
  mode="summary"
fi
# Manual override: HEARTBEAT_MODE=summary | watch | smoke-test
mode="${HEARTBEAT_MODE:-$mode}"

# Probe.
probe_out=$("$PROBE")
echo "$probe_out" > "${LOG_DIR}/last-probe.txt"

# Session-health guard DISABLED 2026-06-03 (Trevor): it was spamming Telegram
# hourly with unreadable lock-JSON, falsely "clearing" SSH login banners as
# locks, and nuking LIVE locks. Off until rewritten read-only + de-duped.
# (session-health.sh itself also early-exits 0 as a second safety.)
# HEARTBEAT_MODE="$mode" "$SESSION_HEALTH" >>"${LOG_DIR}/heartbeat.log" 2>&1 &
true & _SH_PID=$!

# Count failures.
fail_count=0
total=0
while IFS='|' read -r client persona ip container version gateway ssh notes; do
  [ -z "$client" ] && continue
  total=$((total+1))
  if [ "$ssh" != "OK" ] || [ "$gateway" != "OK" ] || [ "$version" = "unknown" ]; then
    fail_count=$((fail_count+1))
  fi
done <<<"$probe_out"

# ---- Remediation pass (Remote Rescue) ---------------------------------------
#
# For each DOWN client, fire remediate.sh and capture a result block. In
# smoke-test mode, skip the actual remediation and emit a synthetic
# "would-have-run" result instead. Results are stored in a tmpdir keyed by
# client so we can splice them into the per-client lines below.

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

remediate_one() {
  local row="$1"
  IFS='|' read -r client persona ip container version gateway ssh notes <<<"$row"
  [ -z "$client" ] && return
  local is_down="no"
  if [ "$ssh" != "OK" ] || [ "$gateway" != "OK" ] || [ "$version" = "unknown" ]; then
    is_down="yes"
  fi
  [ "$is_down" = "no" ] && return
  local key
  key=$(echo "$client" | tr -c '[:alnum:]' '_')
  local out="${tmpdir}/rem_${key}.txt"

  if [ "$mode" = "smoke-test" ]; then
    # In smoke-test mode the remediation chain is SKIPPED for every DOWN
    # row (simulated or real) so we never silently mutate a real box during
    # a test. Real DOWN rows are flagged as REAL_DOWN_DURING_SMOKE so the
    # message clearly distinguishes them from the simulated row.
    local would klass
    if [ "$notes" = "simulated_failure" ]; then
      klass="smoke-test-simulated"
      would="(smoke-test) would have run: docker exec -u node ${container} openclaw doctor --fix; docker restart ${container}; wait 90s for gateway"
    else
      klass="smoke-test-real-down"
      would="(smoke-test) REAL DOWN detected during smoke test, remediation SKIPPED. To fix for real, re-run without HEARTBEAT_MODE=smoke-test."
    fi
    cat >"$out" <<EOF
===REMEDIATE-RESULT===
client=${client}
class=${klass}
outcome=SKIPPED
ttr_seconds=0
tried=${would}
diag=smoke-test (no SSH issued; no change-log entry written)
pattern=NONE
root_cause=smoke-test
===END===
EOF
    return
  fi

  # Real fire.
  "$REMEDIATE" "$client" "$persona" "$ip" "$container" "$version" "$gateway" "$ssh" "$notes" >"$out" 2>&1
}

# Fan out remediations in parallel (capped to background jobs).
if [ "$fail_count" -gt 0 ]; then
  while IFS= read -r row; do
    [ -z "$row" ] && continue
    remediate_one "$row" &
  done <<<"$probe_out"
  wait
fi

# Helper: extract a field from a result file.
get_field() {
  local file="$1" key="$2"
  [ -f "$file" ] || { echo ""; return; }
  awk -F'=' -v k="$key" '$1==k { sub(/^[^=]*=/, "", $0); print; exit }' "$file"
}

# After remediation, re-probe ONLY the previously-down clients to capture
# updated status for the message. Skip re-probe in smoke-test (the probe
# would still report DOWN by design via SIMULATE_DOWN).
post_probe_out="$probe_out"
if [ "$fail_count" -gt 0 ] && [ "$mode" != "smoke-test" ]; then
  # Re-run full probe; cheap enough at 8 boxes in parallel.
  post_probe_out=$("$PROBE")
  echo "$post_probe_out" > "${LOG_DIR}/last-probe.txt"
fi

# ---- Build message ----------------------------------------------------------

# Header. In smoke-test mode, prepend a high-visibility banner so Trevor
# cannot mistake the message for a real outage.
smoke_banner=""
if [ "$mode" = "smoke-test" ]; then
  # Count real-vs-simulated down rows for accurate banner copy.
  real_down=0
  sim_down=0
  while IFS='|' read -r c p i ct v g s n; do
    [ -z "$c" ] && continue
    if [ "$s" != "OK" ] || [ "$g" != "OK" ] || [ "$v" = "unknown" ]; then
      if [ "$n" = "simulated_failure" ]; then
        sim_down=$((sim_down+1))
      else
        real_down=$((real_down+1))
      fi
    fi
  done <<<"$probe_out"
  smoke_banner="[SMOKE TEST] Fleet heartbeat pipeline verification
This is a deliberately triggered test of the heartbeat pipeline.
Simulated DOWN rows: ${sim_down}. Real DOWN rows surfaced during test: ${real_down}.
Remediation chain was DETECTED and SKIPPED for every row (no SSH issued, no docker actions, no change-log writes).
"
  if [ "$real_down" -gt 0 ]; then
    smoke_banner="${smoke_banner}To actually remediate the real DOWN rows, re-run the heartbeat WITHOUT HEARTBEAT_MODE=smoke-test.
"
  fi
  smoke_banner="${smoke_banner}
"
fi

if [ "$mode" = "summary" ]; then
  if [ "$fail_count" -gt 0 ]; then
    header="🔴 Fleet status, ${now_local}, ${fail_count}/${total} client(s) need attention"
  else
    header="✅ Fleet status, ${now_local}, all ${total} clients healthy"
  fi
elif [ "$mode" = "smoke-test" ]; then
  header="🧪 Simulated event below, ${now_local}"
elif [ "$fail_count" -gt 0 ]; then
  header="🚨 Fleet ALERT, ${now_local}, ${fail_count}/${total} client(s) initially down"
else
  header="✅ Fleet status, ${now_local}, all ${total} clients OK"
fi

# Per-client lines. For initially-DOWN rows, splice in the remediation
# outcome so the message tells the full story (down + fix attempt + result).
# We store each client's display line in an associative array (keyed by an
# ordered index) so that, AFTER the chronic-down ledger is computed below, we
# can assemble the final message excluding chronically-down clients (they roll
# into a single weekly "still down" summary line instead of nagging daily).
fixed_count=0
unfixed_count=0
pattern_flags=""
declare -a line_clients=()       # ordered list of clients with a display line
declare -A line_text=()          # client -> display line
declare -A line_is_down=()       # client -> yes/no (initially down at this fire)

while IFS='|' read -r client persona ip container version gateway ssh notes; do
  [ -z "$client" ] && continue

  # Initial status from probe_out.
  init_down="no"
  if [ "$ssh" != "OK" ] || [ "$gateway" != "OK" ] || [ "$version" = "unknown" ]; then
    init_down="yes"
  fi

  # Skip OK rows on watch-mode and smoke-test alerts to keep the message tight.
  if [ "$init_down" = "no" ] && [ "$mode" != "summary" ]; then
    continue
  fi

  # Minimal Telegram format per Trevor 2026-05-25: emoji + client name only.
  # Detail (version, gateway, remediation tried, root cause, pattern) lives in
  # change-log.md (via remediate.sh) and the local heartbeat.log audit, NOT
  # in the Telegram message body. Keep the message scannable at a glance.
  if [ "$init_down" = "no" ]; then
    line="✅ ${client}"
  else
    # Still capture remediation outcome for log + counters, just don't dump it
    # into the Telegram body.
    key=$(echo "$client" | tr -c '[:alnum:]' '_')
    rfile="${tmpdir}/rem_${key}.txt"
    rclass=$(get_field "$rfile" class)
    routcome=$(get_field "$rfile" outcome)
    rpattern=$(get_field "$rfile" pattern)

    case "$routcome" in
      FIXED)
        fixed_count=$((fixed_count+1))
        line="🟢 ${client} (fixed)"
        ;;
      SKIPPED)
        line="⏭️ ${client} (skipped)"
        ;;
      *)
        unfixed_count=$((unfixed_count+1))
        line="❌ ${client}"
        ;;
    esac

    if [ -n "$rpattern" ] && [ "$rpattern" != "NONE" ]; then
      if [ -z "$pattern_flags" ]; then pattern_flags="$rpattern (${client})"
      else pattern_flags="${pattern_flags}; ${rpattern} (${client})"; fi
    fi
  fi

  line_clients+=("$client")
  line_text["$client"]="$line"
  line_is_down["$client"]="$init_down"
done <<<"$probe_out"

# ---- Deduplication (state memory) ------------------------------------------
#
# In watch mode we only send an alert when status CHANGES per client:
#   - Client newly goes DOWN (was up/unknown → down)  => alert once.
#   - Client still DOWN, no change                    => SILENT (no re-send).
#   - Client recovers (down → up)                     => send a 'recovered' notice once.
# Summary mode (6am, 9pm) and smoke-test always bypass dedupe.
#
# State file: ${ROOT}/.last-alert-state.json
# Format:    {"ClientName": "down|up", ...}
# Written atomically; missing/corrupt → treated as first run (alert current problems).

STATE_FILE="${ROOT}/.last-alert-state.json"

# Read existing state into associative array.
declare -A last_state
if [ -f "$STATE_FILE" ]; then
  # Parse simple key-value JSON with awk (no jq dependency).
  while IFS= read -r kv; do
    k=$(echo "$kv" | awk -F': ' '{gsub(/[",]/, "", $0); print $1}' | tr -d ' ')
    v=$(echo "$kv" | awk -F': ' '{gsub(/[",]/, "", $0); print $2}' | tr -d ' ')
    [ -n "$k" ] && last_state["$k"]="$v"
  done < <(grep -E '^\s+"[^"]+"\s*:\s*"(down|up)"' "$STATE_FILE" 2>/dev/null || true)
fi

# Build current state map from post-remediation probe.
declare -A cur_state
while IFS='|' read -r client persona ip container version gateway ssh notes; do
  [ -z "$client" ] && continue
  if [ "$ssh" != "OK" ] || [ "$gateway" != "OK" ] || [ "$version" = "unknown" ]; then
    cur_state["$client"]="down"
  else
    cur_state["$client"]="up"
  fi
done <<<"$post_probe_out"

# ---- Chronic-down ledger (5+ day same-issue de-duplication) -----------------
#
# A client that has been DOWN for the SAME issue for 5+ days should NOT generate
# a fresh nudge on every fire (the "1 thing I couldn't fix, pinged for 20 days"
# problem). Instead it rolls into a single weekly "still down: X, Y, Z" summary
# line that re-fires at most once per 7 days. Genuinely NEW failures still alert
# normally; only chronic, already-acknowledged ones are throttled.
#
# Ledger: ${ROOT}/state/down-since.tsv  (one line per currently-down client)
#   <client>\t<first_down_epoch>\t<last_chronic_alert_epoch>
# A client absent from the ledger that is down NOW = newly down (gets recorded).
# A client present that recovers = removed from the ledger.
LEDGER_DIR="${ROOT}/state"
mkdir -p "$LEDGER_DIR"
DOWN_LEDGER="${LEDGER_DIR}/down-since.tsv"
now_epoch=$(date +%s)
CHRONIC_AFTER_SECS=$((5*86400))   # 5 days
CHRONIC_REMIND_SECS=$((7*86400))  # re-summarize at most once per 7 days

declare -A ledger_first ledger_lastalert
if [ -f "$DOWN_LEDGER" ]; then
  while IFS=$'\t' read -r lc lf la; do
    [ -z "$lc" ] && continue
    ledger_first["$lc"]="$lf"
    ledger_lastalert["$lc"]="${la:-0}"
  done < "$DOWN_LEDGER"
fi

# Update the ledger against current state; classify each down client as either
# "fresh" (down < 5 days, or newly down) or "chronic" (down >= 5 days).
declare -A is_chronic            # client -> "yes" if down 5+ days
chronic_clients=""               # space-list of chronic client keys (for summary)
new_ledger=""
chronic_due="no"                 # at least one chronic client is due for its weekly reminder
for client in "${!cur_state[@]}"; do
  if [ "${cur_state[$client]}" = "down" ]; then
    first="${ledger_first[$client]:-$now_epoch}"   # first time we saw it down
    lastalert="${ledger_lastalert[$client]:-0}"
    down_age=$(( now_epoch - first ))
    if [ "$down_age" -ge "$CHRONIC_AFTER_SECS" ]; then
      is_chronic["$client"]="yes"
      chronic_clients="${chronic_clients}${client}|"
      # Due for a weekly reminder?
      if [ "$(( now_epoch - lastalert ))" -ge "$CHRONIC_REMIND_SECS" ]; then
        chronic_due="yes"
        lastalert="$now_epoch"   # stamp it; we will surface it this fire
      fi
    fi
    new_ledger="${new_ledger}${client}\t${first}\t${lastalert}\n"
  fi
  # up clients are simply dropped from the ledger (recovered).
done
# Persist the refreshed ledger atomically.
ledger_tmp=$(mktemp "${LEDGER_DIR}/.down-since.XXXXXX")
printf '%b' "$new_ledger" > "$ledger_tmp"
mv -f "$ledger_tmp" "$DOWN_LEDGER"

# Build a single rolled-up chronic line, e.g.
#   "⏳ Still down 5+ days (no change): Jill Bulluck, Aurelia Gardner"
chronic_line=""
if [ -n "$chronic_clients" ]; then
  _names=$(printf '%s' "$chronic_clients" | sed 's/|$//; s/|/, /g')
  chronic_line="⏳ Still down 5+ days (no change, already logged): ${_names}"
fi

# Determine if any state CHANGED (watch mode dedupe logic).
has_new_down="no"
has_recovered="no"
recovery_lines=""

if [ "$mode" = "watch" ]; then
  for client in "${!cur_state[@]}"; do
    prev="${last_state[$client]:-unknown}"
    curr="${cur_state[$client]}"
    if [ "$curr" = "down" ] && [ "$prev" != "down" ]; then
      has_new_down="yes"
    fi
    if [ "$curr" = "up" ] && [ "$prev" = "down" ]; then
      has_recovered="yes"
      if [ -z "$recovery_lines" ]; then
        recovery_lines="✅ ${client} RECOVERED"
      else
        recovery_lines="${recovery_lines}
✅ ${client} RECOVERED"
      fi
    fi
  done
fi

# Persist new state atomically.
new_state_json="{"
first_entry=1
for client in "${!cur_state[@]}"; do
  [ "$first_entry" = "1" ] || new_state_json="${new_state_json},"
  new_state_json="${new_state_json}
  \"${client}\": \"${cur_state[$client]}\""
  first_entry=0
done
new_state_json="${new_state_json}
}"
state_tmp=$(mktemp "${ROOT}/.last-alert-state.XXXXXX")
printf '%s\n' "$new_state_json" > "$state_tmp"
mv -f "$state_tmp" "$STATE_FILE"

# Decide whether to send.
should_send="no"
if [ "$mode" = "summary" ]; then
  should_send="yes"
elif [ "$mode" = "smoke-test" ]; then
  should_send="yes"
elif [ "$has_new_down" = "yes" ] || [ "$has_recovered" = "yes" ]; then
  # Watch mode: only alert on state change, not on repeated same-down condition.
  should_send="yes"
elif [ "$chronic_due" = "yes" ]; then
  # Watch mode: a chronically-down client (5+ days, no change) is due for its
  # once-weekly "still down" reminder. This fires AT MOST once per 7 days per
  # the chronic ledger, replacing the old daily nudge for the same issue.
  should_send="yes"
fi

# ---- Assemble the final per-client display lines ----------------------------
# Now that the chronic ledger is known, build the message body excluding any
# chronically-down client (5+ days, no change) from the verbose per-client
# lines — those roll into the single chronic_line summary instead of nagging
# every fire. Fresh failures and healthy clients still appear normally.
lines=""
for client in "${line_clients[@]}"; do
  # Drop chronic-down clients from the verbose list (they appear in chronic_line).
  if [ "${is_chronic[$client]:-}" = "yes" ] && [ "${line_is_down[$client]}" = "yes" ]; then
    continue
  fi
  if [ -z "$lines" ]; then
    lines="${line_text[$client]}"
  else
    lines="${lines}
${line_text[$client]}"
  fi
done

# Compose body (after dedupe so recovery_lines + chronic_line are available).
body="${smoke_banner}${header}
${lines}"
# Roll chronically-down clients into one throttled summary line.
if [ -n "$chronic_line" ]; then
  body="${body}
${chronic_line}"
fi
# Append recovery notices if any clients came back up.
if [ -n "$recovery_lines" ]; then
  body="${body}
${recovery_lines}"
fi

# Persist a copy of every fire for audit.
ts=$(date -u "+%Y%m%dT%H%M%SZ")
{
  echo "=== ${ts} mode=${mode} should_send=${should_send} fails=${fail_count}/${total} fixed=${fixed_count} unfixed=${unfixed_count} ==="
  echo "$body"
  echo ""
} >> "${LOG_DIR}/heartbeat.log"

if [ "$should_send" != "yes" ]; then
  wait "${_SH_PID:-}" 2>/dev/null || true
  echo "no-send (mode=${mode}, fails=${fail_count}/${total})"
  exit 0
fi

# Decide WHICH chat the message goes to.
#   - summary mode (6am, 9pm) → Trevor's personal chat (the "ok everyone is up" daily check-ins he asked to keep)
#   - watch mode alerts (down events during the day) → Rescue Rangers room
#   - smoke-test → Trevor's chat (he's the one initiating it)
#
# RESCUE_RANGERS_HELP_CHAT_ID is set in env (or /Users/blackceomacmini/.openclaw/secrets/.env)
# once Trevor manually creates the Rescue Rangers group on Telegram. Until it's
# set, we fall back to Trevor's chat so we never silently drop alerts.

if [ -z "${RESCUE_RANGERS_HELP_CHAT_ID:-}" ] && [ -f /Users/blackceomacmini/.openclaw/secrets/.env ]; then
  RESCUE_RANGERS_HELP_CHAT_ID=$(grep -E "^RESCUE_RANGERS_HELP_CHAT_ID=" /Users/blackceomacmini/.openclaw/secrets/.env 2>/dev/null | cut -d= -f2-)
fi

target_chat="${RESCUE_RANGERS_HELP_CHAT_ID:-$CHAT_ID}"
if [ "$mode" = "watch" ] && [ "$fail_count" -gt 0 ]; then
  if [ -n "${RESCUE_RANGERS_HELP_CHAT_ID:-}" ]; then
    target_chat="$RESCUE_RANGERS_HELP_CHAT_ID"
    echo "alert routed to Rescue Rangers room ($target_chat)" >> "${LOG_DIR}/heartbeat.log"
  else
    echo "warn: RESCUE_RANGERS_HELP_CHAT_ID unset, alert falling back to Trevor's chat" >> "${LOG_DIR}/heartbeat.log"
  fi
fi

# Ship through OpenClaw gateway (never bypass).
"$OPENCLAW" message send \
  --channel telegram \
  --account "${HEARTBEAT_TG_ACCOUNT:-rescue-rangers}" \
  -t "$target_chat" \
  -m "$body" \
  >>"${LOG_DIR}/heartbeat.log" 2>&1

rc=$?
if [ $rc -ne 0 ]; then
  echo "send failed rc=${rc}" >>"${LOG_DIR}/heartbeat.log"
  exit $rc
fi

# ---- Rescue Rangers dispatch ------------------------------------------------
#
# On DOWN events (real or remaining-down after remediation), the alert is
# already delivered to the Rescue Rangers room (and routed to the
# rescue-rangers agent) by the `openclaw message send --account rescue-rangers`
# call above. As of OpenClaw 2026.6.x the gateway natively polls multiple
# Telegram bot accounts (channels.telegram.accounts.rescue-rangers) and a
# binding routes that account to the rescue-rangers agent, so a separate
# delivery is no longer needed.
#
# REMOVED 2026-06-22: the previous raw `curl POST api.telegram.org/.../sendMessage`
# block here was (a) a duplicate of the gateway send above, (b) a violation of
# the standing rule "never bypass OpenClaw's gateway for Telegram", and (c) the
# source of the {"ok":false,"error_code":404,"description":"Not Found"} Trevor
# saw: it read RESCUE_RANGERS_TELEGRAM_BOT_TOKEN from .env with `cut -d= -f2-`,
# which kept the surrounding single quotes from the .env value, producing the
# malformed URL https://api.telegram.org/bot'TOKEN'/sendMessage -> Telegram 404.
# The gateway send above handles RR-room delivery correctly. Do NOT reinstate a
# raw curl here. (backup: heartbeat.sh.bak-rr-404fix-*)

# Ensure session-health background job has finished before we exit
# so its change-log writes and TG sends are not orphaned mid-cron.
wait "${_SH_PID:-}" 2>/dev/null || true

echo "sent (mode=${mode}, fails=${fail_count}/${total}, fixed=${fixed_count}, unfixed=${unfixed_count})"
