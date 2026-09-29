#!/usr/bin/env bash
#
# watchdog-cc-down-is-red.test.sh
#
# THE DEFECT: a Hostinger container was recreated without `pm2 resurrect`, so
# pm2 came back with no Command Center app. cc-health-check.sh saw HTTP
# unreachable and no pm2 app, called it a bounded UNKNOWN (exit 3), and the
# watchdog treats UNKNOWN as "not alerting" and exits 0. Nothing ever passed
# --unknown-since, so the UNKNOWN never escalated: the watchdog reported ok
# every 5 minutes while the Command Center was down.
#
# PROVES:
#   H1  cc-health-check.sh: pm2 answers with apps but none is the Command
#       Center, HTTP unreachable -> definitive RED (exit 1), service "absent".
#   H0  control: the same fixture with the Command Center app present and
#       stopped is RED as "stopped" (the harness reads pm2 at all).
#   U1  the watchdog records the first UNKNOWN and passes it back as
#       --unknown-since on the next pass; a GREEN pass clears it.
#   S1  RED "absent" + WATCHDOG_SELF_HEAL=1, pm2 empty: resurrect, then start
#       the Command Center from its ecosystem, then save.
#   S2  an open atomic-deploy transaction: nothing is started.
#   S3  WATCHDOG_SELF_HEAL=0: classified, nothing started.
#
# Fixture-only: fake pm2 and a fake health check on PATH / beside a copy of
# watchdog-cc.sh. Nothing on this machine is started or stopped.
#
# Run: bash tests/unit/watchdog-cc-down-is-red.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wd-down.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/cc/scripts" "$WORK/state" "$WORK/real/scripts"

# fake pm2: `jlist` prints $FAKE_PM2_LIST; `ls -m` prints $FAKE_PM2_LS;
# `describe` succeeds for names in $FAKE_PM2_KNOWN; every call is logged.
cat > "$WORK/bin/pm2" <<'FAKEPM2'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${PM2_CALL_LOG:-/dev/null}"
case "${1:-}" in
  jlist)    printf '%s\n' "${FAKE_PM2_LIST:-[]}" ;;
  ls)       printf '%s' "${FAKE_PM2_LS:-}" ;;
  describe) for k in ${FAKE_PM2_KNOWN:-}; do [[ "$k" == "${2:-}" ]] && exit 0; done; exit 1 ;;
esac
exit 0
FAKEPM2
chmod +x "$WORK/bin/pm2"
export PATH="$WORK/bin:$PATH"
export PM2_CALL_LOG="$WORK/pm2.log"

# ── H0/H1: the real cc-health-check.sh, against a port nothing listens on ────
cp "$REPO_ROOT/scripts/cc-health-check.sh" "$WORK/real/scripts/"
cp -R "$REPO_ROOT/scripts/lib" "$WORK/real/scripts/" 2>/dev/null || true
PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
hc() { bash "$WORK/real/scripts/cc-health-check.sh" --port "$PORT" --json-only --canonical-dir "$WORK/real" 2>/dev/null; }

export FAKE_PM2_LIST="[{\"name\":\"blackceo-command-center\",\"pm_id\":0,\"pm2_env\":{\"name\":\"blackceo-command-center\",\"status\":\"stopped\",\"args\":\"--port $PORT\"}}]"
OUT="$(hc)"; RC=$?
[[ $RC -eq 1 && "$OUT" == *'"service_status":"stopped"'* ]] \
  && ok "H0 control: a stopped Command Center app is RED as stopped" || bad "H0 control: rc=$RC $OUT"

export FAKE_PM2_LIST='[{"name":"ghl-community-mcp","pm_id":1,"pm2_env":{"name":"ghl-community-mcp","status":"online","args":"--port 8123"}}]'
OUT="$(hc)"; RC=$?
[[ $RC -eq 1 ]] && ok "H1: no Command Center app in pm2 is RED (exit 1)" || bad "H1: rc=$RC (UNKNOWN keeps the watchdog silent) $OUT"
[[ "$OUT" == *'"service_status":"absent"'* && "$OUT" == *'no Command Center app in pm2'* ]] \
  && ok "H1: it says why" || bad "H1: detail: $OUT"

# ── watchdog, with a fake health check that records its arguments ────────────
cp "$REPO_ROOT/scripts/watchdog-cc.sh" "$WORK/cc/scripts/"
: > "$WORK/cc/ecosystem.config.cjs"
cat > "$WORK/cc/scripts/cc-health-check.sh" <<'FAKEHC'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${HC_ARGS_LOG:-/dev/null}"
printf '%s\n' "${FAKE_HEALTH_JSON:-{\}}"
exit "${FAKE_HEALTH_EXIT:-0}"
FAKEHC
chmod +x "$WORK/cc/scripts/cc-health-check.sh"
export HC_ARGS_LOG="$WORK/hc-args.log" WATCHDOG_STATE_DIR="$WORK/state" WATCHDOG_ALERT_LOG="$WORK/alerts.log"
export WATCHDOG_PORT=4000 WATCHDOG_CANONICAL_DIR="$WORK/cc"
wd() { bash "$WORK/cc/scripts/watchdog-cc.sh" >"$WORK/wd.out" 2>&1; }

FAKE_HEALTH_JSON='{"pass":false,"indeterminate":true,"detail":"server unreachable"}' FAKE_HEALTH_EXIT=3 wd
[[ -s "$WORK/state/unknown-since" ]] && ok "U1: the first UNKNOWN is recorded" || bad "U1: no unknown-since recorded"
FAKE_HEALTH_JSON='{"pass":false,"indeterminate":true,"detail":"server unreachable"}' FAKE_HEALTH_EXIT=3 wd
tail -1 "$HC_ARGS_LOG" | grep -q -- "--unknown-since $(cat "$WORK/state/unknown-since" 2>/dev/null)" \
  && ok "U1: the next pass passes it as --unknown-since" || bad "U1: args: $(tail -1 "$HC_ARGS_LOG")"
FAKE_HEALTH_JSON='{"pass":true}' FAKE_HEALTH_EXIT=0 wd
[[ ! -e "$WORK/state/unknown-since" ]] && ok "U1: GREEN clears it" || bad "U1: still recorded after GREEN"

ABSENT='{"pass":false,"indeterminate":false,"detail":"server unreachable: no Command Center app in pm2","service_status":"absent"}'
: > "$PM2_CALL_LOG"
FAKE_HEALTH_JSON="$ABSENT" FAKE_HEALTH_EXIT=1 WATCHDOG_SELF_HEAL=1 FAKE_PM2_LS="" FAKE_PM2_KNOWN="" wd
grep -q '"incident":"no-pm2-app"' "$WATCHDOG_ALERT_LOG" && ok "S1: classified no-pm2-app" || bad "S1: class: $(tail -1 "$WATCHDOG_ALERT_LOG")"
grep -qx 'resurrect' "$PM2_CALL_LOG" && ok "S1: empty pm2 is resurrected first" || bad "S1: no resurrect: $(tr '\n' ';' < "$PM2_CALL_LOG")"
grep -q "^start $WORK/cc/ecosystem.config.cjs" "$PM2_CALL_LOG" && ok "S1: the Command Center is started from its ecosystem" || bad "S1: no start"
grep -qx 'save' "$PM2_CALL_LOG" && ok "S1: the pm2 list is saved" || bad "S1: no save"

rm -f "$WORK/state/incidents.json"; : > "$PM2_CALL_LOG"; : > "$WORK/cc/.atomic-deploy-transaction.json"
FAKE_HEALTH_JSON="$ABSENT" FAKE_HEALTH_EXIT=1 WATCHDOG_SELF_HEAL=1 FAKE_PM2_LS="" FAKE_PM2_KNOWN="" wd
grep -q '^start' "$PM2_CALL_LOG" && bad "S2: started during an open deploy transaction" || ok "S2: nothing started while a deploy transaction is open"
rm -f "$WORK/cc/.atomic-deploy-transaction.json"

rm -f "$WORK/state/incidents.json"; : > "$PM2_CALL_LOG"
FAKE_HEALTH_JSON="$ABSENT" FAKE_HEALTH_EXIT=1 WATCHDOG_SELF_HEAL=0 wd
grep -qE '^(start|resurrect)' "$PM2_CALL_LOG" && bad "S3: acted with self-heal off" || ok "S3: self-heal off takes no action"

echo ""
printf '[watchdog-cc-down-is-red] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
