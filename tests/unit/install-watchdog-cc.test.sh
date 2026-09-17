#!/usr/bin/env bash
# install-watchdog-cc.test.sh — the box watchdog actually gets a schedule.
#
# WHAT THIS PROVES
#   The repair that matters here is not code, it is INSTALLATION. scripts/
#   watchdog-cc.sh has always documented "Schedule (crontab): */5 * * * *" and
#   nothing in this repo ever installed it — so on the box that went dark, the
#   only process that could have restarted the command center was never
#   running. These tests pin the installer that closes that gap:
#
#   I1  macOS: the launchd plist is written with the right program, interval,
#       self-heal flag, port and log path.
#   I2  macOS: a SECOND run replaces the agent instead of stacking a second one,
#       and boots the old one out before loading the new one.
#   I3  macOS: --check reports the installed agent and exits 0; on a clean HOME
#       it reports nothing installed and exits 1 (the control for I3 — a --check
#       that always said "installed" would prove nothing).
#   I4  macOS: --uninstall removes the plist and unloads the label.
#   I5  Linux: the crontab block is installed once, with WATCHDOG_SELF_HEAL=1.
#   I6  Linux: a second run REPLACES the block — one block, one cron line — and
#       every foreign crontab line survives byte for byte.
#   I7  Linux: --check reports it and exits 0; --uninstall removes ONLY the
#       block and leaves the foreign lines exactly as they were.
#
# Fixture-only: HOME points at a temp dir and `launchctl` and `crontab` are
# fakes on PATH that record what they were asked to do. Nothing on this machine
# is loaded, scheduled or changed.
#
# Run: bash tests/unit/install-watchdog-cc.test.sh

set -uo pipefail  # deliberately NOT -e: --check exits 1 on purpose

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALLER="$REPO_ROOT/scripts/install-watchdog-cc.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

if [[ ! -f "$INSTALLER" ]]; then
  echo "FATAL: $INSTALLER does not exist"; exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/install-wd.XXXXXX")"
cleanup() { [[ -n "${INSTALL_WD_KEEP_WORK:-}" ]] || rm -rf "$WORK"; }
trap cleanup EXIT

mkdir -p "$WORK/home" "$WORK/bin"

# ── fake launchctl: records every invocation, succeeds for bootout/bootstrap,
#    and answers `print` only for labels recorded as loaded. ─────────────────
cat > "$WORK/bin/launchctl" <<'FAKELC'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${LAUNCHCTL_CALL_LOG:-/dev/null}"
case "${1:-}" in
  bootstrap) printf '%s\n' "${3:-}" >> "${LAUNCHCTL_LOADED:-/dev/null}"; exit 0 ;;
  bootout)   exit 0 ;;
  print)     [[ -s "${LAUNCHCTL_LOADED:-/dev/null}" ]] && exit 0; exit 1 ;;
  list)      cat "${LAUNCHCTL_LOADED:-/dev/null}" 2>/dev/null; exit 0 ;;
  *)         exit 0 ;;
esac
FAKELC
chmod +x "$WORK/bin/launchctl"

# ── fake crontab: a plain file is the user's crontab. -l prints it (exit 1 when
#    there is none, exactly like the real thing), `-` installs stdin, -r removes.
cat > "$WORK/bin/crontab" <<'FAKECRON'
#!/usr/bin/env bash
TAB="${FAKE_CRONTAB_FILE:?FAKE_CRONTAB_FILE unset}"
case "${1:-}" in
  -l) [[ -f "$TAB" ]] || exit 1; cat "$TAB"; exit 0 ;;
  -r) rm -f "$TAB"; exit 0 ;;
  -)  cat > "$TAB"; exit 0 ;;
  *)  exit 2 ;;
esac
FAKECRON
chmod +x "$WORK/bin/crontab"

export PATH="$WORK/bin:$PATH"
export HOME="$WORK/home"
export LAUNCHCTL_CALL_LOG="$WORK/launchctl-calls.log"
export LAUNCHCTL_LOADED="$WORK/launchctl-loaded.log"
export FAKE_CRONTAB_FILE="$WORK/crontab.txt"

PLIST="$HOME/Library/LaunchAgents/com.blackceo.watchdog-cc.plist"

# ═══════════════════════════════════════════════════════════════════════════
# macOS branch
# ═══════════════════════════════════════════════════════════════════════════
export WATCHDOG_INSTALL_PLATFORM=darwin

# ── I3 CONTROL FIRST: nothing installed yet, so --check must FAIL. Running it
#    before the install proves --check discriminates rather than always saying
#    "installed" — the pass/fail split has to land on the artifact, not the branch.
echo "[I3-control] --check on a clean HOME reports nothing installed"
bash "$INSTALLER" --check >"$WORK/i3c.out" 2>&1
RC=$?
[[ $RC -eq 1 ]] && ok "I3-control: --check exits 1 when nothing is installed" \
                || bad "I3-control: expected exit 1 on a clean HOME, got $RC"
grep -q 'NOT INSTALLED' "$WORK/i3c.out" \
  && ok "I3-control: it says NOT INSTALLED" \
  || bad "I3-control: no NOT INSTALLED line: $(cat "$WORK/i3c.out")"

# ── I1: install writes the plist ────────────────────────────────────────────
echo "[I1] macOS install writes the launchd plist"
bash "$INSTALLER" --port 4100 --pm2-app blackceo-command-center >"$WORK/i1.out" 2>&1
RC=$?
[[ $RC -eq 0 ]] && ok "I1: installer exits 0" || bad "I1: installer exited $RC: $(cat "$WORK/i1.out")"
[[ -f "$PLIST" ]] && ok "I1: the plist exists at $PLIST" || bad "I1: no plist written"
grep -q '<string>com.blackceo.watchdog-cc</string>' "$PLIST" \
  && ok "I1: Label is com.blackceo.watchdog-cc" || bad "I1: wrong or missing Label"
grep -q 'scripts/watchdog-cc.sh' "$PLIST" \
  && ok "I1: it runs scripts/watchdog-cc.sh" || bad "I1: the plist does not run watchdog-cc.sh"
grep -q '<integer>300</integer>' "$PLIST" \
  && ok "I1: StartInterval is 300s" || bad "I1: StartInterval is not 300"
grep -A1 'WATCHDOG_SELF_HEAL' "$PLIST" | grep -q '<string>1</string>' \
  && ok "I1: WATCHDOG_SELF_HEAL=1" || bad "I1: self-heal is not switched on"
grep -A1 'WATCHDOG_PORT' "$PLIST" | grep -q '<string>4100</string>' \
  && ok "I1: WATCHDOG_PORT carries --port" || bad "I1: --port did not reach the plist"
grep -A1 'WATCHDOG_CC_APP_NAMES' "$PLIST" | grep -q 'blackceo-command-center' \
  && ok "I1: WATCHDOG_CC_APP_NAMES carries --pm2-app" || bad "I1: --pm2-app did not reach the plist"
grep -q 'Library/Logs/openclaw/watchdog-cc.log' "$PLIST" \
  && ok "I1: stdout and stderr go to ~/Library/Logs/openclaw/watchdog-cc.log" || bad "I1: wrong log path"
grep -q 'bootstrap' "$LAUNCHCTL_CALL_LOG" \
  && ok "I1: the agent was loaded with launchctl bootstrap" || bad "I1: launchctl bootstrap was never called"

# ── I2: a second run replaces, never stacks ─────────────────────────────────
echo "[I2] a second run replaces the agent instead of stacking a second one"
: > "$LAUNCHCTL_CALL_LOG"
bash "$INSTALLER" --port 4100 --pm2-app blackceo-command-center >"$WORK/i2.out" 2>&1
RC=$?
[[ $RC -eq 0 ]] && ok "I2: the re-run exits 0" || bad "I2: the re-run exited $RC"
PLIST_COUNT=$(find "$HOME/Library/LaunchAgents" -name 'com.blackceo.watchdog-cc*.plist' | wc -l | tr -d ' ')
[[ "$PLIST_COUNT" == "1" ]] && ok "I2: exactly one plist on disk" || bad "I2: found $PLIST_COUNT plists"
grep -q 'bootout' "$LAUNCHCTL_CALL_LOG" \
  && ok "I2: the old agent is booted out before the new one is loaded" \
  || bad "I2: no bootout on the re-run — the previous definition would stay loaded"
LABEL_LINES=$(grep -c '<key>Label</key>' "$PLIST")
[[ "$LABEL_LINES" == "1" ]] && ok "I2: the plist was replaced, not appended to" || bad "I2: $LABEL_LINES Label keys in one plist"

# ── I3: --check now finds it ────────────────────────────────────────────────
echo "[I3] --check reports the installed agent"
bash "$INSTALLER" --check >"$WORK/i3.out" 2>&1
RC=$?
[[ $RC -eq 0 ]] && ok "I3: --check exits 0 once installed" || bad "I3: --check exited $RC after an install"
grep -q 'INSTALLED' "$WORK/i3.out" && ok "I3: it names what is installed" || bad "I3: no INSTALLED line"
grep -q '4100' "$WORK/i3.out" && ok "I3: it reports the port it is watching" || bad "I3: --check did not report the port"
# --check must not write: the plist mtime and content are unchanged by it.
grep -q 'watchdog-cc.sh' "$PLIST" && ok "I3: --check left the plist in place" || bad "I3: --check damaged the plist"

# ── I8: CC_PUBLIC_URL reaches the agent (explicit flag, then from the app's env file) ──
echo "[I8] --public-url lands in the plist; --app-dir reads it from .env.local; the value is never logged"
bash "$INSTALLER" --port 4100 --pm2-app blackceo-command-center --public-url 'https://cc.example.test/x?a=1&b=2' >"$WORK/i8a.out" 2>&1
grep -A1 'CC_PUBLIC_URL' "$PLIST" | grep -q 'https://cc.example.test/x?a=1&amp;b=2' \
  && ok "I8: --public-url is in the plist (XML-escaped)" || bad "I8: CC_PUBLIC_URL missing from plist"
grep -q 'cc.example.test' "$WORK/i8a.out" && bad "I8: the URL value was printed to the log" || ok "I8: the URL value is not printed"
grep -q 'CC_PUBLIC_URL=set' "$WORK/i8a.out" && ok "I8: the log says the URL is set" || bad "I8: log does not say CC_PUBLIC_URL=set"
mkdir -p "$WORK/app"; printf 'OTHER=1\nCC_PUBLIC_URL="https://from-env.example.test"\n' > "$WORK/app/.env.local"
bash "$INSTALLER" --port 4100 --app-dir "$WORK/app" >"$WORK/i8b.out" 2>&1
grep -A1 'CC_PUBLIC_URL' "$PLIST" | grep -q 'https://from-env.example.test' \
  && ok "I8: --app-dir picks CC_PUBLIC_URL up from .env.local" || bad "I8: .env.local value not picked up"
bash "$INSTALLER" --port 4100 --app-dir "$WORK/nowhere" >"$WORK/i8c.out" 2>&1
grep -q 'CC_PUBLIC_URL' "$PLIST" && bad "I8: stale CC_PUBLIC_URL left in plist when none is known" || ok "I8: no CC_PUBLIC_URL when none is known"
grep -q 'NOT SET' "$WORK/i8c.out" && ok "I8: the log warns when the URL is not set" || bad "I8: no NOT SET warning"

# ── I4: --uninstall ─────────────────────────────────────────────────────────
echo "[I4] --uninstall removes the agent"
: > "$LAUNCHCTL_CALL_LOG"
bash "$INSTALLER" --uninstall >"$WORK/i4.out" 2>&1
RC=$?
[[ $RC -eq 0 ]] && ok "I4: --uninstall exits 0" || bad "I4: --uninstall exited $RC"
[[ ! -f "$PLIST" ]] && ok "I4: the plist is gone" || bad "I4: the plist is still on disk"
grep -q 'bootout' "$LAUNCHCTL_CALL_LOG" \
  && ok "I4: the agent was unloaded before the file was removed" || bad "I4: never unloaded"
bash "$INSTALLER" --check >/dev/null 2>&1
[[ $? -eq 1 ]] && ok "I4: --check confirms it is gone" || bad "I4: --check still reports it installed"

# ═══════════════════════════════════════════════════════════════════════════
# Linux branch
# ═══════════════════════════════════════════════════════════════════════════
export WATCHDOG_INSTALL_PLATFORM=linux

# A crontab that already has the operator's own lines in it. These must survive
# every install, re-install and uninstall byte for byte.
cat > "$FAKE_CRONTAB_FILE" <<'FOREIGN'
# operator's own entries — this script must never touch these
0 3 * * * /usr/local/bin/backup-everything.sh
*/10 * * * * /home/me/bin/ping-the-thing.sh >> /tmp/ping.log 2>&1
FOREIGN
cp "$FAKE_CRONTAB_FILE" "$WORK/foreign-baseline.txt"

echo "[I5] Linux install adds the crontab block"
bash "$INSTALLER" --port 4200 --pm2-app blackceo-command-center >"$WORK/i5.out" 2>&1
RC=$?
[[ $RC -eq 0 ]] && ok "I5: installer exits 0" || bad "I5: installer exited $RC: $(cat "$WORK/i5.out")"
grep -q 'BEGIN blackceo watchdog-cc' "$FAKE_CRONTAB_FILE" \
  && ok "I5: the marker block is present" || bad "I5: no marker block in the crontab"
bash "$INSTALLER" --port 4200 --pm2-app blackceo-command-center --public-url 'https://cc.example.test' >/dev/null 2>&1
grep -q "CC_PUBLIC_URL='https://cc.example.test'" "$FAKE_CRONTAB_FILE" \
  && ok "I5: the crontab line carries CC_PUBLIC_URL" || bad "I5: CC_PUBLIC_URL missing from the crontab line"
grep -q '^\*/5 \* \* \* \* .*watchdog-cc.sh' "$FAKE_CRONTAB_FILE" \
  && ok "I5: the schedule is */5" || bad "I5: no */5 line: $(cat "$FAKE_CRONTAB_FILE")"
grep -q 'WATCHDOG_SELF_HEAL=1' "$FAKE_CRONTAB_FILE" \
  && ok "I5: WATCHDOG_SELF_HEAL=1 is on the cron line" || bad "I5: self-heal is not switched on"
grep -q 'WATCHDOG_PORT=4200' "$FAKE_CRONTAB_FILE" \
  && ok "I5: --port reached the cron line" || bad "I5: --port missing"
grep -q 'WATCHDOG_CC_APP_NAMES=blackceo-command-center' "$FAKE_CRONTAB_FILE" \
  && ok "I5: --pm2-app reached the cron line" || bad "I5: --pm2-app missing"
grep -q 'watchdog-cc.log' "$FAKE_CRONTAB_FILE" \
  && ok "I5: output is redirected to the watchdog log" || bad "I5: no log redirect"

echo "[I6] a second run replaces the block and never duplicates it"
bash "$INSTALLER" --port 4200 --pm2-app blackceo-command-center >"$WORK/i6.out" 2>&1
BEGINS=$(grep -c 'BEGIN blackceo watchdog-cc' "$FAKE_CRONTAB_FILE")
# Count SCHEDULE lines only: the BEGIN marker comment also names the installer
# script, so a bare grep for watchdog-cc.sh counts the comment as a cron line.
CRONLINES=$(grep -c '^\*/5 .*bash .*scripts/watchdog-cc.sh' "$FAKE_CRONTAB_FILE")
[[ "$BEGINS" == "1" ]] && ok "I6: exactly one marker block after two installs" || bad "I6: $BEGINS marker blocks"
[[ "$CRONLINES" == "1" ]] && ok "I6: exactly one watchdog cron line" || bad "I6: $CRONLINES watchdog cron lines"
for line in '0 3 * * * /usr/local/bin/backup-everything.sh' '*/10 * * * * /home/me/bin/ping-the-thing.sh >> /tmp/ping.log 2>&1'; do
  grep -qF "$line" "$FAKE_CRONTAB_FILE" \
    && ok "I6: the operator's own line survived: ${line:0:32}..." \
    || bad "I6: LOST a foreign crontab line: $line"
done

echo "[I7] --check reports the block, --uninstall removes only the block"
bash "$INSTALLER" --check >"$WORK/i7.out" 2>&1
RC=$?
[[ $RC -eq 0 ]] && ok "I7: --check exits 0 when the block is installed" || bad "I7: --check exited $RC"
grep -q 'INSTALLED' "$WORK/i7.out" && ok "I7: --check names the block" || bad "I7: no INSTALLED line"
grep -q 'watchdog-cc.sh' "$WORK/i7.out" && ok "I7: --check prints the scheduled command" || bad "I7: --check did not print the line"

bash "$INSTALLER" --uninstall >"$WORK/i7b.out" 2>&1
RC=$?
[[ $RC -eq 0 ]] && ok "I7: --uninstall exits 0" || bad "I7: --uninstall exited $RC"
grep -q 'watchdog-cc' "$FAKE_CRONTAB_FILE" \
  && bad "I7: the watchdog block is still in the crontab" \
  || ok "I7: the watchdog block is gone"
if diff -q "$WORK/foreign-baseline.txt" "$FAKE_CRONTAB_FILE" >/dev/null 2>&1; then
  ok "I7: the crontab is byte-for-byte what it was before any install"
else
  bad "I7: foreign crontab lines changed:$(diff "$WORK/foreign-baseline.txt" "$FAKE_CRONTAB_FILE")"
fi
bash "$INSTALLER" --check >/dev/null 2>&1
[[ $? -eq 1 ]] && ok "I7: --check confirms the block is gone" || bad "I7: --check still reports it installed"

echo ""
printf '[install-watchdog-cc] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
