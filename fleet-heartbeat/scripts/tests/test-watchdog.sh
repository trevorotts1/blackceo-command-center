#!/usr/bin/env bash
# Offline test for FIX-RESCUE-02 (rescue-receiver-watchdog crash-loop escalation).
# Stubs curl + launchctl on PATH, points HOME at a temp dir, and drives the DOWN
# path in both phases: normal auto-restart vs. budget-exhausted crash-loop. No
# network, no launchd, no secrets printed.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WATCHDOG="$HERE/../rescue-receiver-watchdog.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0
check() { if [ "$2" = "$3" ]; then echo "  ok   - $1"; else echo "  FAIL - $1 (expected '$2' got '$3')"; fail=1; fi; }

# --- stubs on PATH ---------------------------------------------------------
STUB="$TMP/bin"; mkdir -p "$STUB"
cat > "$STUB/curl" <<'EOF'
#!/usr/bin/env bash
# Health check (URL has :8799/health) -> fail (receiver DOWN). Telegram send -> ok.
# Record the full arg list (incl. the -d payload) so the test can assert message text.
printf '%s\n' "$*" >> "$HOME/curl-calls.log"
for a in "$@"; do case "$a" in *api.telegram.org*) echo '{"ok":true}'; exit 0;; esac; done
exit 7
EOF
cat > "$STUB/launchctl" <<'EOF'
#!/usr/bin/env bash
# print -> emit a crashy last exit code so the diagnostic can read it; else no-op.
case "${1:-}" in print) echo "last exit code = 1";; esac
exit 0
EOF
chmod +x "$STUB/curl" "$STUB/launchctl"

run_watchdog() {
  HOME="$TMP" PATH="$STUB:$PATH" RESCUE_RANGERS_BOT_TOKEN="test-token-not-real" \
    bash "$WATCHDOG" >/dev/null 2>&1 || true
}

LOGDIR="$TMP/.openclaw/logs"
FLAG="$LOGDIR/rescue-receiver-watchdog-alarm.flag"
CRASHFLAG="$LOGDIR/rescue-receiver-watchdog-crashloop.flag"
COUNT="$LOGDIR/rescue-receiver-watchdog-restart.count"
WLOG="$LOGDIR/rescue-receiver-watchdog.log"

echo "FIX-RESCUE-02: first DOWN tick -> normal auto-restart page"
run_watchdog
[ -f "$FLAG" ] && a=yes || a=no
check "first-detection alarm flag written" "yes" "$a"
[ -f "$CRASHFLAG" ] && c=yes || c=no
check "crash-loop flag NOT yet written" "no" "$c"
grep -q "auto-restarting" "$TMP/curl-calls.log" 2>/dev/null && m=yes || m=no
check "log shows normal auto-restart alarm" "yes" "$m"

echo "FIX-RESCUE-02: budget exhausted -> distinct crash-loop escalation"
printf '5' > "$COUNT"        # restart budget already spent
run_watchdog
[ -f "$CRASHFLAG" ] && c2=yes || c2=no
check "crash-loop escalation flag written" "yes" "$c2"
grep -q "CRASH-LOOPING" "$TMP/curl-calls.log" 2>/dev/null && m2=yes || m2=no
check "log shows distinct crash-loop page" "yes" "$m2"
grep -q "kickstart will NOT help" "$TMP/curl-calls.log" 2>/dev/null && m3=yes || m3=no
check "crash-loop page says kickstart will not help" "yes" "$m3"
grep -q "last exit code=1" "$TMP/curl-calls.log" 2>/dev/null && m4=yes || m4=no
check "crash-loop page includes launchd last exit code" "yes" "$m4"

if [ "$fail" -ne 0 ]; then echo ""; echo "watchdog tests FAILED"; exit 1; fi
echo ""; echo "All watchdog tests passed."
