#!/bin/bash
# pm2-restart-tripwire.sh — detect AND KILL pm2 crash loops, fast, with evidence.
#
# WHY THIS EXISTS (2026-08-17): blackceo-cc-demo-{interview,dashboard} crash-looped
# SILENTLY to 17,595 restarts over 3 days. pm2's own breaker (max_restarts=16) never
# tripped because each death took >1s (min_uptime default 1000ms), so every crash
# looked like a "stable run that happened to end". This tripwire watches the raw
# restart counter instead. Per operator orders 2026-08-17 ("do more than just tell
# me"; no 30-min thrash window) it runs EVERY MINUTE and STOPS the loop itself.
#
# DETECTION (two tiers, checked every minute):
#   FAST loop:  >= 3 restarts within one 1-minute window        -> killed in ~60-90s
#   SLOW burn:  >= 15 restarts accumulated without the process  -> killed in ~10-15 min
#               ever staying up 10 continuous minutes
#   (A healthy run of >= 10 min re-anchors the slow counter, so a service that
#    restarts occasionally over days/weeks NEVER trips it.)
#
# ACTION on trip:
#   1. EVIDENCE: tail of the process's pm2 error log into the alert file.
#   2. `pm2 stop <name>` — halts the churn. Reversible (`pm2 restart <name>`), keeps
#      the pm2 entry + logs. A process dying every few seconds serves nothing anyway.
#      EXCEPTION: names in pm2-tripwire-protect.txt (one per line) are NEVER
#      auto-stopped — loud alert only. Seeded with blackceo-command-center (live
#      client-facing service; automated kill-switches don't get to touch it).
#   3. TELL: alert + evidence + undo/next commands in PM2-RESTART-ALERT.txt, log
#      line, best-effort macOS notification. Alerts per process are throttled to one
#      per 30 min (the ACTION is never throttled — stop retries every minute if the
#      first stop failed; only the notification spam is suppressed).
# A process newly parked "errored" (pm2 gave up) gets evidence + alert; no stop needed.
# NOTE: the stop is NOT `pm2 save`d — a reboot restores the old state. The alert tells
# you the save command; baking state into dump.pm2 stays a human decision.
#
# COMPANION DOCTRINE (prevention, not detection — see TOOLS.md "PM2 SAFE-START"):
#   demos/one-offs:    pm2 start ... --no-autorestart      (dead demos stay dead)
#   demo teardown:     pm2 delete <names> && pm2 save      (save = no reboot resurrection)
#   real services:     pm2 start ... --min-uptime 30000 --max-restarts 10
#
# Zero-token pure shell + one python3 JSON parse (~100ms). Cron runs it every minute;
# silent on a clean pass, so the log only grows when something happens. First run
# records baselines silently. pm2/parse failure exits 2 and logs ERROR — an
# instrument failure is NEVER reported as "no problems" (negative-result contract).
#
# USAGE:
#   pm2-restart-tripwire.sh              # normal check (what cron runs)
#   pm2-restart-tripwire.sh --selftest   # prove fast-kill, slow-burn, protect-list and
#                                        # alert-throttle still discriminate; 0 PASS / 2 FAIL
#   PM2_TRIPWIRE_DIR=<dir>               # override state/alert dir (selftest uses this)
#   PM2_TRIPWIRE_FAKE_JSON=<file>        # feed fake jlist JSON; stops become dry-run

set -u
PM2="/Users/blackceomacmini/.npm-global/bin/pm2"
ALERT_DIR="${PM2_TRIPWIRE_DIR:-/Users/blackceomacmini/.claude/alerts}"
STATE="$ALERT_DIR/pm2-tripwire-state.txt"     # lines: name|count|status|anchor|lastalert_epoch
FLAG="$ALERT_DIR/PM2-RESTART-ALERT.txt"
PROTECT="$ALERT_DIR/pm2-tripwire-protect.txt" # names never auto-stopped, one per line
FAST_THRESH=3        # restarts within one 1-minute window = fast crash loop
SLOW_THRESH=15       # restarts since last 10-min-stable run = slow-burn loop
STABLE_SECS=600      # surviving this long online re-anchors the slow counter
ALERT_COOLDOWN=1800  # min seconds between alerts for the same process
NOW="$(date '+%Y-%m-%d %H:%M:%S')"
NOW_EPOCH="$(date +%s)"
ALERT_FIRED=0

mkdir -p "$ALERT_DIR"

fetch_lines() {
  # Emits "name|status|restart_count|err_log_path|uptime_epoch_s" per process. Slices
  # from the first '[' so a pm2-daemon-spawn banner can't corrupt the JSON.
  # rc 3 = instrument failure.
  local src
  if [ -n "${PM2_TRIPWIRE_FAKE_JSON:-}" ]; then
    src="$(cat "$PM2_TRIPWIRE_FAKE_JSON" 2>/dev/null)" || return 3
  else
    src="$("$PM2" jlist 2>/dev/null)" || return 3
  fi
  printf '%s' "$src" | /usr/bin/python3 -c '
import json, sys
raw = sys.stdin.read()
i = raw.find("[")
if i < 0:
    sys.exit(3)
try:
    procs = json.loads(raw[i:])
except Exception:
    sys.exit(3)
for p in procs:
    e = p.get("pm2_env", {})
    try:
        up = int(int(e.get("pm_uptime", 0) or 0) / 1000)
    except Exception:
        up = 0
    print("%s|%s|%s|%s|%s" % (p.get("name", "?"), e.get("status", "?"),
                              e.get("restart_time", 0), e.get("pm_err_log_path", "-"), up))
'
}

alert() {
  local msg="$1"
  echo "[$NOW] ALERT: $msg" >> "$FLAG"
  echo "[$NOW] ALERT: $msg"
  /usr/bin/osascript -e "display notification \"$msg\" with title \"PM2 TRIPWIRE\"" >/dev/null 2>&1 || true
}

capture_evidence() {
  local name="$1" errlog="$2"
  if [ -f "$errlog" ]; then
    {
      echo "  --- last 20 error-log lines for $name ($errlog) ---"
      tail -n 20 "$errlog" | sed 's/^/  | /'
      echo "  --- end evidence ---"
    } >> "$FLAG"
  else
    echo "  (no error log found at $errlog — run: pm2 logs $name --err)" >> "$FLAG"
  fi
}

is_protected() {
  [ -f "$PROTECT" ] && grep -qxF "$1" "$PROTECT"
}

stop_process() {
  # Dry-run under fake JSON (selftest) so we never pm2-stop a phantom name for real.
  local name="$1"
  if [ -n "${PM2_TRIPWIRE_FAKE_JSON:-}" ]; then
    echo "$name" >> "$ALERT_DIR/stopped.txt"
    return 0
  fi
  "$PM2" stop "$name" >/dev/null 2>&1
}

handle_crash_loop() {
  # Sets ALERT_FIRED=1 only when a notification actually went out (throttle bookkeeping).
  local name="$1" delta="$2" growth="$3" count="$4" errlog="$5" p_last="$6"
  local can_alert=1 why="+${delta} this minute, ${growth} since last stable run, total ${count}"
  [ $(( NOW_EPOCH - p_last )) -lt "$ALERT_COOLDOWN" ] && can_alert=0
  ALERT_FIRED=0
  if is_protected "$name"; then
    if [ "$can_alert" = 1 ]; then
      alert "$name crash-looping ($why) — PROTECTED name, NOT auto-stopped. Investigate NOW: pm2 logs $name --err"
      capture_evidence "$name" "$errlog"
      ALERT_FIRED=1
    fi
    return
  fi
  if stop_process "$name"; then
    if [ "$can_alert" = 1 ]; then
      alert "$name crash-looping ($why) — loop KILLED: pm2 stop $name executed."
      capture_evidence "$name" "$errlog"
      {
        echo "  undo (bring it back):      pm2 restart $name"
        echo "  make stop survive reboot:  pm2 save"
        echo "  remove it for good:        pm2 delete $name && pm2 save"
      } >> "$FLAG"
      ALERT_FIRED=1
    fi
  else
    if [ "$can_alert" = 1 ]; then
      alert "$name crash-looping ($why) — AUTO-STOP FAILED (pm2 stop $name errored); retrying every minute. Manual action needed."
      capture_evidence "$name" "$errlog"
      ALERT_FIRED=1
    fi
  fi
}

run_check() {
  local lines
  lines="$(fetch_lines)"
  local rc=$?
  if [ $rc -ne 0 ]; then
    echo "[$NOW] ERROR: pm2 jlist unreachable or unparseable (rc=$rc) — check is BROKEN, not clean" | tee -a "$FLAG"
    return 2
  fi

  date '+%Y-%m-%d %H:%M:%S' > "$ALERT_DIR/pm2-tripwire-lastrun.txt"

  if [ ! -f "$STATE" ]; then
    # Bootstrap: record baselines silently; alerting starts from the next run.
    printf '%s\n' "$lines" | awk -F'|' '{print $1"|"$3"|"$2"|"$3"|0"}' > "$STATE"
    echo "[$NOW] bootstrap: baseline recorded for $(printf '%s\n' "$lines" | grep -c .) process(es)"
    return 0
  fi

  local newstate="" name status count errlog up prev p_count p_status p_anchor p_last delta growth anchor
  while IFS='|' read -r name status count errlog up; do
    [ -z "$name" ] && continue
    case "$count" in ''|*[!0-9]*) count=0 ;; esac
    case "$up" in ''|*[!0-9]*) up=0 ;; esac
    prev="$(grep -m1 "^${name}|" "$STATE" 2>/dev/null)" || prev=""
    if [ -z "$prev" ]; then
      # Process appeared since last check: adopt its current count silently as
      # baseline+anchor (a pm2 resurrect can carry a historical count; that history
      # is not a live loop). Tracking starts next minute.
      newstate="${newstate}${name}|${count}|${status}|${count}|0
"
      continue
    fi
    p_count="$(printf '%s' "$prev" | awk -F'|' '{print $2}')"
    p_status="$(printf '%s' "$prev" | awk -F'|' '{print $3}')"
    p_anchor="$(printf '%s' "$prev" | awk -F'|' '{print $4}')"
    p_last="$(printf '%s' "$prev" | awk -F'|' '{print $5}')"
    # Malformed/legacy state lines must degrade safely, never crash under set -u.
    case "$p_count" in ''|*[!0-9]*) p_count=0 ;; esac
    case "$p_anchor" in ''|*[!0-9]*) p_anchor=$p_count ;; esac
    case "$p_last" in ''|*[!0-9]*) p_last=0 ;; esac

    delta=$(( count - p_count )); [ "$delta" -lt 0 ] && delta=0
    anchor=$p_anchor
    [ "$anchor" -gt "$count" ] && anchor=$count   # counter reset (pm2 delete/recreate)
    if [ "$status" = "online" ] && [ "$up" -gt 0 ] && [ $(( NOW_EPOCH - up )) -ge "$STABLE_SECS" ]; then
      anchor=$count   # survived >= 10 min: healthy run, forgive restart history
    fi
    growth=$(( count - anchor ))

    if [ "$delta" -ge "$FAST_THRESH" ] || [ "$growth" -ge "$SLOW_THRESH" ]; then
      handle_crash_loop "$name" "$delta" "$growth" "$count" "$errlog" "$p_last"
      anchor=$count
      [ "$ALERT_FIRED" = 1 ] && p_last=$NOW_EPOCH
      [ -z "${PM2_TRIPWIRE_FAKE_JSON:-}" ] && ! is_protected "$name" && status="stopped"
    elif [ "$status" = "errored" ] && [ "$p_status" != "errored" ]; then
      alert "$name is parked ERRORED (pm2 gave up after repeated crashes) — pm2 logs $name --err"
      capture_evidence "$name" "$errlog"
    fi
    newstate="${newstate}${name}|${count}|${status}|${anchor}|${p_last}
"
  done <<EOF_LINES
$lines
EOF_LINES
  printf '%s' "$newstate" > "$STATE"
  return 0
}

selftest() {
  # Control per negative-result contract: prove the instrument still discriminates.
  local tmp fresh_ms rc=0
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/pm2-tripwire-selftest.XXXXXX")"
  fresh_ms="${NOW_EPOCH}000"   # "just restarted" — must NOT count as a stable run

  if ! fetch_lines > "$tmp/live.txt"; then
    echo "SELFTEST FAIL: cannot read live pm2 jlist — the real cron checks are blind"
    rm -rf "$tmp"; return 2
  fi
  echo "control ok: live pm2 readable ($(grep -c . "$tmp/live.txt") process(es))"

  printf '[{"name":"selftest-loop","pm2_env":{"status":"online","restart_time":100,"pm_uptime":%s}},
{"name":"selftest-protected","pm2_env":{"status":"online","restart_time":100,"pm_uptime":%s}},
{"name":"selftest-slow","pm2_env":{"status":"online","restart_time":17,"pm_uptime":%s}}]' \
    "$fresh_ms" "$fresh_ms" "$fresh_ms" > "$tmp/fake1.json"
  printf 'selftest-loop|0|online|0|0\nselftest-protected|0|online|0|0\nselftest-slow|16|online|2|0\n' > "$tmp/pm2-tripwire-state.txt"
  printf 'selftest-protected\n' > "$tmp/pm2-tripwire-protect.txt"
  PM2_TRIPWIRE_DIR="$tmp" PM2_TRIPWIRE_FAKE_JSON="$tmp/fake1.json" "$0" >/dev/null 2>&1

  if grep -q "selftest-loop crash-looping.*KILLED" "$tmp/PM2-RESTART-ALERT.txt" 2>/dev/null \
     && grep -qxF "selftest-loop" "$tmp/stopped.txt" 2>/dev/null; then
    echo "SELFTEST PASS 1/5: fast loop (+100 in one window) alerted AND auto-stopped"
  else
    echo "SELFTEST FAIL 1/5: fast loop was not alerted+stopped"; rc=2
  fi
  if grep -q "selftest-protected crash-looping.*PROTECTED" "$tmp/PM2-RESTART-ALERT.txt" 2>/dev/null \
     && ! grep -qxF "selftest-protected" "$tmp/stopped.txt" 2>/dev/null; then
    echo "SELFTEST PASS 2/5: protected name alerted but NOT stopped"
  else
    echo "SELFTEST FAIL 2/5: protect-list broken"; rc=2
  fi
  if grep -q "selftest-slow crash-looping.*KILLED" "$tmp/PM2-RESTART-ALERT.txt" 2>/dev/null \
     && grep -qxF "selftest-slow" "$tmp/stopped.txt" 2>/dev/null; then
    echo "SELFTEST PASS 3/5: slow burn (+1/min, 15 without a stable run) killed"
  else
    echo "SELFTEST FAIL 3/5: slow-burn loop not caught"; rc=2
  fi

  # Second minute: loops keep growing — actions may repeat, alerts must throttle.
  printf '[{"name":"selftest-loop","pm2_env":{"status":"online","restart_time":200,"pm_uptime":%s}},
{"name":"selftest-protected","pm2_env":{"status":"online","restart_time":200,"pm_uptime":%s}},
{"name":"selftest-slow","pm2_env":{"status":"online","restart_time":18,"pm_uptime":%s}}]' \
    "$fresh_ms" "$fresh_ms" "$fresh_ms" > "$tmp/fake2.json"
  PM2_TRIPWIRE_DIR="$tmp" PM2_TRIPWIRE_FAKE_JSON="$tmp/fake2.json" "$0" >/dev/null 2>&1

  if [ "$(grep -c 'selftest-protected crash-looping.*PROTECTED' "$tmp/PM2-RESTART-ALERT.txt" 2>/dev/null)" = 1 ]; then
    echo "SELFTEST PASS 4/5: protected alert throttled (1 alert across 2 trip minutes)"
  else
    echo "SELFTEST FAIL 4/5: protected alert not throttled"; rc=2
  fi
  if [ "$(grep -c 'selftest-loop crash-looping.*KILLED' "$tmp/PM2-RESTART-ALERT.txt" 2>/dev/null)" = 1 ]; then
    echo "SELFTEST PASS 5/5: kill alert throttled (stop still retried; 1 alert)"
  else
    echo "SELFTEST FAIL 5/5: kill alert not throttled"; rc=2
  fi
  rm -rf "$tmp"
  return $rc
}

case "${1:-}" in
  --selftest) selftest ;;
  *) run_check ;;
esac
