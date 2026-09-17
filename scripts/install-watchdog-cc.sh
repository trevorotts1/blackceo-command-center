#!/usr/bin/env bash
# scripts/install-watchdog-cc.sh — put the box watchdog on a schedule.
#
# WHY THIS EXISTS
# ---------------
# scripts/watchdog-cc.sh is the OUT-OF-PROCESS half of "the system checks
# itself": it runs cc-health-check.sh and, with WATCHDOG_SELF_HEAL=1, performs
# the bounded repairs it already implements (a stale-build rebuild, and a
# scheduler-stall `pm2 restart` capped by attempts + backoff). Its own header
# documented "Schedule (crontab): */5 * * * *" — but NOTHING in this repo ever
# installed that schedule. Measured on the operator Mac: no crontab entry, no
# launchd job, and its log had not been written since 2026-09-09. The only
# thing that could restart a dead command center was never running.
#
# This script installs that schedule, and the deploy calls it (atomic-deploy.sh
# Phase 5), so every box that takes an update gets the watchdog wired up
# without anyone remembering to do it.
#
# WHAT IT INSTALLS
#   macOS   ~/Library/LaunchAgents/com.blackceo.watchdog-cc.plist
#           StartInterval 300, logs to ~/Library/Logs/openclaw/watchdog-cc.log
#   Linux   a crontab block, */5, guarded by BEGIN/END marker comments, logging
#           to ~/.openclaw/logs/watchdog-cc.log
#
# Both carry WATCHDOG_SELF_HEAL=1 so the repairs watchdog-cc.sh already bounds
# are switched on. This script NEVER changes watchdog-cc.sh's repair logic; it
# only decides when it runs and with which environment.
#
# USAGE
#   bash scripts/install-watchdog-cc.sh [--port 4000] [--pm2-app NAME]
#   bash scripts/install-watchdog-cc.sh --check      # report, write nothing
#   bash scripts/install-watchdog-cc.sh --uninstall  # remove ONLY what this wrote
#
# EXIT CODES
#   0  installed / already installed correctly / --check found it / uninstalled
#   1  --check found nothing installed, or an install step failed
#   2  usage error
#
# IDEMPOTENT: a second run replaces the artifact in place. It never appends a
# second crontab line, and it preserves every foreign crontab line byte for byte.
#
# TEST HOOKS (never used in production): WATCHDOG_INSTALL_PLATFORM forces the
# darwin/linux branch, so both paths can be proved on one machine.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCHDOG_SCRIPT="${SCRIPT_DIR}/watchdog-cc.sh"

LABEL="com.blackceo.watchdog-cc"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
MAC_LOG_DIR="${HOME}/Library/Logs/openclaw"
MAC_LOG="${MAC_LOG_DIR}/watchdog-cc.log"
LINUX_LOG_DIR="${HOME}/.openclaw/logs"
LINUX_LOG="${LINUX_LOG_DIR}/watchdog-cc.log"
INTERVAL_SECONDS=300

# The crontab block is delimited so a re-run replaces exactly these lines and
# nothing else. Anything outside the markers is copied through untouched.
MARKER_BEGIN="# BEGIN blackceo watchdog-cc (managed by scripts/install-watchdog-cc.sh — do not edit)"
MARKER_END="# END blackceo watchdog-cc"

PORT="4000"
PM2_APP=""
MODE="install"

_log()  { printf '[install-watchdog-cc] %s\n' "$*" >&2; }
_ok()   { printf '[install-watchdog-cc OK] %s\n' "$*" >&2; }
_warn() { printf '[install-watchdog-cc WARN] %s\n' "$*" >&2; }
_err()  { printf '[install-watchdog-cc ERROR] %s\n' "$*" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)      PORT="${2:?--port requires a value}"; shift 2 ;;
    --pm2-app)   PM2_APP="${2:?--pm2-app requires a value}"; shift 2 ;;
    --check)     MODE="check"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    -h|--help)   sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)           _err "unknown argument: $1"; exit 2 ;;
  esac
done

PLATFORM="${WATCHDOG_INSTALL_PLATFORM:-$(uname -s)}"
case "$PLATFORM" in
  [Dd]arwin) PLATFORM="darwin" ;;
  [Ll]inux)  PLATFORM="linux" ;;
  *) _err "unsupported platform '${PLATFORM}' — install a */5 schedule for ${WATCHDOG_SCRIPT} by hand."; exit 2 ;;
esac

if [[ "$MODE" != "uninstall" && ! -f "$WATCHDOG_SCRIPT" ]]; then
  _err "watchdog-cc.sh not found at ${WATCHDOG_SCRIPT} — nothing to schedule."
  exit 1
fi

###############################################################################
# macOS — launchd user agent
###############################################################################
_mac_write_plist() {
  mkdir -p "${HOME}/Library/LaunchAgents" "$MAC_LOG_DIR" 2>/dev/null || true
  # WATCHDOG_CC_APP_NAMES is only pinned when a name was passed. Left unset,
  # watchdog-cc.sh applies its own allowlist, which is the safer default: this
  # script must never narrow the set of names the watchdog may repair by guessing.
  local app_names_entry=""
  if [[ -n "$PM2_APP" ]]; then
    app_names_entry="        <key>WATCHDOG_CC_APP_NAMES</key>
        <string>${PM2_APP}</string>
"
  fi
  cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${WATCHDOG_SCRIPT}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>WATCHDOG_SELF_HEAL</key>
        <string>1</string>
        <key>WATCHDOG_PORT</key>
        <string>${PORT}</string>
${app_names_entry}    </dict>
    <key>StartInterval</key>
    <integer>${INTERVAL_SECONDS}</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${MAC_LOG}</string>
    <key>StandardErrorPath</key>
    <string>${MAC_LOG}</string>
</dict>
</plist>
PLIST
}

_mac_reload() {
  local uid; uid="$(id -u)"
  # bootout first so a re-run REPLACES the running agent instead of leaving the
  # previous definition loaded. A missing agent makes bootout fail; that is the
  # expected first-install case and is not an error.
  launchctl bootout "gui/${uid}/${LABEL}" >/dev/null 2>&1 || true
  if launchctl bootstrap "gui/${uid}" "$PLIST_PATH" >/dev/null 2>&1; then
    _ok "loaded ${LABEL} (launchctl bootstrap gui/${uid})"
    return 0
  fi
  # Older macOS, or a session without a bootstrap domain: the legacy verbs.
  launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
  if launchctl load -w "$PLIST_PATH" >/dev/null 2>&1; then
    _ok "loaded ${LABEL} (launchctl load -w)"
    return 0
  fi
  _warn "the plist is written at ${PLIST_PATH} but launchctl would not load it (this is normal over a headless ssh session). Load it from a desktop session with: launchctl load -w ${PLIST_PATH}"
  return 1
}

_mac_install() {
  _mac_write_plist || { _err "could not write ${PLIST_PATH}"; return 1; }
  _ok "wrote ${PLIST_PATH} — runs ${WATCHDOG_SCRIPT} every ${INTERVAL_SECONDS}s with WATCHDOG_SELF_HEAL=1, WATCHDOG_PORT=${PORT}${PM2_APP:+, WATCHDOG_CC_APP_NAMES=${PM2_APP}}"
  _log "log: ${MAC_LOG}"
  _mac_reload
}

_mac_check() {
  if [[ ! -f "$PLIST_PATH" ]]; then
    _log "NOT INSTALLED: no ${PLIST_PATH}"
    return 1
  fi
  _ok "INSTALLED: ${PLIST_PATH}"
  _log "  runs:     $(grep -A1 'watchdog-cc.sh' "$PLIST_PATH" | head -1 | sed 's/.*<string>\(.*\)<\/string>.*/\1/')"
  _log "  interval: $(grep -A1 'StartInterval' "$PLIST_PATH" | grep integer | sed 's/.*<integer>\(.*\)<\/integer>.*/\1/')s"
  _log "  self-heal: $(grep -A1 'WATCHDOG_SELF_HEAL' "$PLIST_PATH" | grep string | sed 's/.*<string>\(.*\)<\/string>.*/\1/')"
  _log "  port:      $(grep -A1 'WATCHDOG_PORT' "$PLIST_PATH" | grep string | sed 's/.*<string>\(.*\)<\/string>.*/\1/')"
  if grep -q 'WATCHDOG_CC_APP_NAMES' "$PLIST_PATH"; then
    _log "  pm2 apps:  $(grep -A1 'WATCHDOG_CC_APP_NAMES' "$PLIST_PATH" | grep string | sed 's/.*<string>\(.*\)<\/string>.*/\1/')"
  else
    _log "  pm2 apps:  (watchdog-cc.sh default allowlist)"
  fi
  _log "  log:       ${MAC_LOG}"
  if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || launchctl list 2>/dev/null | grep -q "${LABEL}"; then
    _log "  launchd:   loaded"
  else
    _log "  launchd:   NOT loaded (the plist exists; load it with launchctl load -w ${PLIST_PATH})"
  fi
  return 0
}

_mac_uninstall() {
  launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
  launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
  if [[ -f "$PLIST_PATH" ]]; then
    rm -f "$PLIST_PATH" && _ok "removed ${PLIST_PATH}"
  else
    _log "nothing to remove: no ${PLIST_PATH}"
  fi
  return 0
}

###############################################################################
# Linux — crontab block
###############################################################################
_cron_line() {
  local envs="WATCHDOG_SELF_HEAL=1 WATCHDOG_PORT=${PORT}"
  [[ -n "$PM2_APP" ]] && envs="${envs} WATCHDOG_CC_APP_NAMES=${PM2_APP}"
  printf '*/5 * * * * %s bash %s >> %s 2>&1' "$envs" "$WATCHDOG_SCRIPT" "$LINUX_LOG"
}

_read_crontab() { crontab -l 2>/dev/null || true; }

# Everything EXCEPT this script's block, byte for byte.
_strip_block() {
  awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    skip != 1 { print }
  '
}

_write_crontab() {  # reads the full desired crontab on stdin
  local body; body="$(cat)"
  if [[ -z "${body//[[:space:]]/}" ]]; then
    crontab -r >/dev/null 2>&1 || true
    return 0
  fi
  printf '%s\n' "$body" | crontab -
}

_linux_install() {
  mkdir -p "$LINUX_LOG_DIR" 2>/dev/null || true
  local kept; kept="$(_read_crontab | _strip_block)"
  local desired
  desired="$(printf '%s\n%s\n%s\n%s' "$kept" "$MARKER_BEGIN" "$(_cron_line)" "$MARKER_END")"
  # Drop the leading blank line a previously-empty crontab would introduce.
  desired="$(printf '%s\n' "$desired" | awk 'NR==1 && $0=="" {next} {print}')"
  if printf '%s' "$desired" | _write_crontab; then
    _ok "installed the crontab block: */5 * * * * ${WATCHDOG_SCRIPT} (WATCHDOG_SELF_HEAL=1, WATCHDOG_PORT=${PORT}${PM2_APP:+, WATCHDOG_CC_APP_NAMES=${PM2_APP}})"
    _log "log: ${LINUX_LOG}"
    return 0
  fi
  _err "crontab write failed — install the schedule by hand: $(_cron_line)"
  return 1
}

_linux_check() {
  local current; current="$(_read_crontab)"
  if ! printf '%s\n' "$current" | grep -qF "$MARKER_BEGIN"; then
    _log "NOT INSTALLED: no watchdog-cc block in this user's crontab"
    return 1
  fi
  _ok "INSTALLED: crontab block for ${LABEL}"
  printf '%s\n' "$current" | awk -v b="$MARKER_BEGIN" -v e="$MARKER_END" '
    $0 == b { inside = 1; next }
    $0 == e { inside = 0; next }
    inside == 1 { print "[install-watchdog-cc]   " $0 }
  ' >&2
  _log "  log: ${LINUX_LOG}"
  return 0
}

_linux_uninstall() {
  local current; current="$(_read_crontab)"
  if ! printf '%s\n' "$current" | grep -qF "$MARKER_BEGIN"; then
    _log "nothing to remove: no watchdog-cc block in this user's crontab"
    return 0
  fi
  if printf '%s' "$(printf '%s\n' "$current" | _strip_block)" | _write_crontab; then
    _ok "removed the watchdog-cc crontab block; every other crontab line is untouched"
    return 0
  fi
  _err "crontab write failed — the block is still installed"
  return 1
}

###############################################################################
# Dispatch
###############################################################################
case "${PLATFORM}:${MODE}" in
  darwin:install)   _mac_install ;;
  darwin:check)     _mac_check ;;
  darwin:uninstall) _mac_uninstall ;;
  linux:install)    _linux_install ;;
  linux:check)      _linux_check ;;
  linux:uninstall)  _linux_uninstall ;;
esac
exit $?
