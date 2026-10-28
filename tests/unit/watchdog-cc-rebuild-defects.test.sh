#!/usr/bin/env bash
#
# watchdog-cc-rebuild-defects.test.sh
#
# Six defects that kept the watchdog and the stale-build rebuild from acting:
#
#   D1  cc-health-check.sh: `mktemp /tmp/pm2_raw_XXXXXX.json`. BSD/macOS mktemp only
#       randomizes a template that ENDS in the Xs, so a suffixed template is a literal
#       name: the first run creates it, every later run (or one killed before its
#       cleanup) gets "File exists", pm2 is unreadable and the verdict is UNKNOWN
#       (exit 3), which the watchdog never acts on.
#   D2  watchdog-cc.sh: rebuild_attempts was a LIFETIME cap, never reset. After three
#       rebuilds over a box's life every later stale build was left for a human.
#   D3  watchdog-cc.sh: the rebuild ran `bash scripts/atomic-deploy.sh` under cron's
#       PATH=/usr/bin:/bin (macOS bash 3.2, which atomic-deploy.sh refuses) and with
#       no --app-dir (it then targets $HOME/projects/command-center).
#   D4  atomic-deploy.sh: pm2 restart/reload kept the app's old registered definition,
#       so a box started before stop_exit_codes existed kept restart-looping on exit 78.
#   D5  ecosystem.config.cjs: the circuit-breaker comment said min_uptime/max_restarts
#       stop a loop. They do not; stop_exit_codes is the only breaker that holds.
#   D6  cc-health-check.sh: with exp_backoff_restart_delay pm2 reports an app it stopped
#       on a stop_exit_codes exit as "waiting restart", which never read as stopped, so
#       a refusal that wrote no receipt stayed UNKNOWN.
#
# Fixture-only: fake curl / pm2 / mktemp on PATH, copies of the scripts in a temp dir.
# Nothing on this machine is started, stopped or rebuilt.
#
# Run: bash tests/unit/watchdog-cc-rebuild-defects.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wd-rebuild-defects.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/bin-pm2" "$WORK/app/scripts" "$WORK/cc/scripts" "$WORK/state"

PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"

# ── fakes ────────────────────────────────────────────────────────────────────
# A healthy server, so cc-health-check.sh reaches its pm2 section.
cat > "$WORK/bin/curl" <<'FAKECURL'
#!/usr/bin/env bash
args=("$@"); url="${args[$((${#args[@]}-1))]}"; wval=""; head=0; out=0
for i in "${!args[@]}"; do
  case "${args[$i]}" in -w) wval="${args[$((i+1))]}" ;; -o) out=1 ;; -I) head=1 ;; esac
done
case "$url" in
  */api/health/deep) printf '%s\n{"_http_code":200}' '{"pass":true,"indeterminate":false,"timestamp":"x","checks":{"asset_manifest":{"pass":true,"detail":"ok"}},"advisory":{}}'; exit 0 ;;
  */_next/static/*) if [[ $head -eq 1 ]]; then printf 'HTTP/1.1 200 OK\r\nContent-Type: application/javascript\r\n\r\n'; else printf '200'; fi; exit 0 ;;
esac
if [[ $out -eq 1 ]]; then [[ "$wval" == *redirect_url* ]] && printf '200 ' || printf '200'
else printf '%s' '<html><script src="/_next/static/chunks/main-abc.js"></script></html>'; fi
FAKECURL
# pm2: `jlist` prints $FAKE_PM2_LIST; every call is logged.
cat > "$WORK/bin/pm2" <<'FAKEPM2'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${PM2_CALL_LOG:-/dev/null}"
case "${1:-}" in
  jlist)   printf '%s\n' "${FAKE_PM2_LIST:-[]}" ;;
  list)    printf '%s\n' "${FAKE_PM2_NAMES:-}" ;;
  restart) exit "${FAKE_RESTART_RC:-0}" ;;
  reload)  exit "${FAKE_RELOAD_RC:-0}" ;;
esac
exit 0
FAKEPM2
# mktemp with BSD semantics (a template that does not END in X characters is a literal
# name that already exists), or one that always fails.
cat > "$WORK/bin/mktemp" <<'FAKEMKTEMP'
#!/usr/bin/env bash
[[ "${FAKE_MKTEMP_FAIL:-0}" == "1" ]] && { echo "mktemp: cannot create" >&2; exit 1; }
t="${@: -1}"
case "$t" in
  *XXXXXX) exec /usr/bin/mktemp "$@" ;;
  *) echo "mktemp: mkstemp failed on $t: File exists" >&2; exit 1 ;;
esac
FAKEMKTEMP
chmod +x "$WORK/bin/"*
# The same pm2 alone, so curl stays real (nothing listens on $PORT: HTTP unreachable).
cp "$WORK/bin/pm2" "$WORK/bin-pm2/pm2"
# /usr/bin/mktemp is the real one the fake delegates to; fall back to PATH's on other OSes.
[[ -x /usr/bin/mktemp ]] || sed -i.bak "s#/usr/bin/mktemp#$(command -v mktemp)#" "$WORK/bin/mktemp"

cp "$REPO_ROOT/scripts/cc-health-check.sh" "$WORK/app/scripts/"
cp "$REPO_ROOT/scripts/pm2-analyze-cc.py" "$WORK/app/scripts/"
cp -R "$REPO_ROOT/scripts/lib" "$WORK/app/scripts/" 2>/dev/null || true

online_pm2() {
  printf '[{"name":"blackceo-command-center","pm_id":0,"pm2_env":{"name":"blackceo-command-center","status":"online","pm_uptime":1,"args":"--port %s","pm_cwd":"%s","env":{"DATABASE_PATH":"%s"}}}]' \
    "$PORT" "$WORK/app" "$WORK/app/db.sqlite"
}
hc_healthy() { env PATH="$WORK/bin:$PATH" FAKE_PM2_LIST="$(online_pm2)" "$@" timeout 60 bash "$WORK/app/scripts/cc-health-check.sh" --port "$PORT" --json-only --canonical-dir "$WORK/app" 2>/dev/null; }

# ── D1 ───────────────────────────────────────────────────────────────────────
echo "D1 mktemp templates"
if grep -vE '^\s*#' "$REPO_ROOT/scripts/cc-health-check.sh" | grep -E 'mktemp[^|]*XXXXXX[A-Za-z0-9._-]' >/dev/null; then
  bad "D1: a mktemp template in cc-health-check.sh still has a suffix after the Xs"
else
  ok "D1: no mktemp template in cc-health-check.sh has a suffix after the Xs"
fi
OUT="$(hc_healthy)"; RC=$?
[[ $RC -eq 0 && "$OUT" == *'"pass": true'* ]] \
  && ok "D1: a healthy app reads GREEN on a BSD-style mktemp (pm2 topology readable)" \
  || bad "D1: rc=$RC on BSD-style mktemp: $(printf '%s' "$OUT" | head -c 300)"
OUT="$(hc_healthy FAKE_MKTEMP_FAIL=1)"; RC=$?
[[ $RC -eq 3 && "$OUT" == *'mktemp failed'* ]] \
  && ok "D1: when mktemp fails the verdict is UNKNOWN (exit 3) and says mktemp failed, not 'no app'" \
  || bad "D1: mktemp failure: rc=$RC $(printf '%s' "$OUT" | head -c 300)"

# ── D6 ───────────────────────────────────────────────────────────────────────
echo "D6 waiting restart on a stop exit code"
waiting() {  # $1 exit_code  $2 stop_exit_codes JSON
  printf '[{"name":"blackceo-command-center","pm_id":0,"pm2_env":{"name":"blackceo-command-center","status":"waiting restart","exit_code":%s,"stop_exit_codes":%s,"args":"--port %s"}}]' "$1" "$2" "$PORT"
}
hc_down() { env PATH="$WORK/bin-pm2:$PATH" FAKE_PM2_LIST="$(waiting "$1" "$2")" timeout 60 bash "$WORK/app/scripts/cc-health-check.sh" --port "$PORT" --json-only --canonical-dir "$WORK/app" 2>/dev/null; }
for codes in '[78]' '78'; do
  OUT="$(hc_down 78 "$codes")"; RC=$?
  [[ $RC -eq 1 && "$OUT" == *'"service_status":"stopped"'* ]] \
    && ok "D6: waiting restart + exit 78 + stop_exit_codes=$codes is stopped (RED)" \
    || bad "D6: stop_exit_codes=$codes rc=$RC $(printf '%s' "$OUT" | head -c 200)"
done
OUT="$(hc_down 1 '[78]')"; RC=$?
[[ $RC -eq 3 ]] && ok "D6: waiting restart after a different exit code stays UNKNOWN" || bad "D6: exit 1 rc=$RC"
OUT="$(hc_down 78 '[]')"; RC=$?
[[ $RC -eq 3 ]] && ok "D6: waiting restart with no stop_exit_codes stays UNKNOWN" || bad "D6: no stop codes rc=$RC"

# ── watchdog fixtures ────────────────────────────────────────────────────────
cp "$REPO_ROOT/scripts/watchdog-cc.sh" "$WORK/cc/scripts/"
: > "$WORK/cc/ecosystem.config.cjs"
cat > "$WORK/cc/scripts/cc-health-check.sh" <<'FAKEHC'
#!/usr/bin/env bash
j="${FAKE_HC_JSON:-}"; [[ -n "$j" ]] || j='{}'
printf '%s\n' "$j"
exit "${FAKE_HC_EXIT:-0}"
FAKEHC
cat > "$WORK/cc/scripts/atomic-deploy.sh" <<'FAKEDEPLOY'
#!/usr/bin/env bash
{ printf 'ARGS=%s\n' "$*"; printf 'PWD=%s\n' "$PWD"; printf 'PATH=%s\n' "$PATH"; } >> "$DEPLOY_LOG"
FAKEDEPLOY
chmod +x "$WORK/cc/scripts/"*.sh
RED_JSON='{"pass":false,"indeterminate":false,"refusal":{"receipt_present":true,"receipt_current":true,"reason":"stale_build","exit":"78","age_seconds":"5"},"service_status":"stopped"}'
export DEPLOY_LOG="$WORK/deploy.log"

watchdog() {  # $1 = health exit, $2 = PATH for the run; extra env after
  local hcexit="$1" path="$2"; shift 2
  env -i HOME="$WORK" PATH="$path" TMPDIR="${TMPDIR:-/tmp}" DEPLOY_LOG="$DEPLOY_LOG" \
    WATCHDOG_STATE_DIR="$WORK/state" WATCHDOG_ALERT_LOG="$WORK/alerts.log" WATCHDOG_PORT="$PORT" \
    WATCHDOG_SELF_HEAL=1 WATCHDOG_MIN_FREE_MB=1 FAKE_HC_EXIT="$hcexit" FAKE_HC_JSON="$RED_JSON" "$@" \
    /bin/bash "$WORK/cc/scripts/watchdog-cc.sh" 2>&1
}
attempts() { python3 -c "import json;print(json.load(open('$WORK/state/rebuild-state.json')).get('rebuild_attempts','none'))" 2>/dev/null || echo none; }

# ── D3 ───────────────────────────────────────────────────────────────────────
echo "D3 rebuild command: bash 4+ PATH and --app-dir"
mkdir -p "$WORK/first"
: > "$DEPLOY_LOG"; rm -f "$WORK/state/rebuild-state.json" "$WORK/state/incidents.json"
watchdog 1 "$WORK/first:/usr/bin:/bin" >/dev/null
DEPLOY_ARGS="$(grep '^ARGS=' "$DEPLOY_LOG" 2>/dev/null | head -1)"
if [[ "$DEPLOY_ARGS" == "ARGS=--app-dir $(cd "$WORK/cc" && pwd)" ]]; then
  ok "D3: the default rebuild passes --app-dir <the install it is repairing>"
else
  bad "D3: rebuild args were [$DEPLOY_ARGS]"
fi
RUN_PATH="$(grep '^PATH=' "$DEPLOY_LOG" 2>/dev/null | head -1 | cut -d= -f2-)"
case "$RUN_PATH" in
  "$WORK/first:"*/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin*) ok "D3: Homebrew dirs go ahead of the system dirs, behind the caller's own first dir" ;;
  *) bad "D3: rebuild PATH was [$RUN_PATH]" ;;
esac
: > "$DEPLOY_LOG"; rm -f "$WORK/state/rebuild-state.json" "$WORK/state/incidents.json"
watchdog 1 "/usr/bin:/bin" WATCHDOG_REBUILD_CMD="printf 'OVERRIDE\\n' >> $DEPLOY_LOG" >/dev/null
grep -q '^OVERRIDE$' "$DEPLOY_LOG" && ! grep -q '^ARGS=' "$DEPLOY_LOG" \
  && ok "D3: WATCHDOG_REBUILD_CMD still overrides the default" || bad "D3: override ignored: $(head -3 "$DEPLOY_LOG")"

# ── D2 ───────────────────────────────────────────────────────────────────────
echo "D2 rebuild budget resets on a verified recovery"
rm -f "$WORK/state/"*.json; : > "$DEPLOY_LOG"
printf '{"rebuild_attempts":3,"last_rebuild_at":"2020-01-01T00:00:00Z"}' > "$WORK/state/rebuild-state.json"
printf '{"open_incident":"refusal-receipt"}' > "$WORK/state/incidents.json"
OUT="$(watchdog 1 "/usr/bin:/bin")"
if [[ "$OUT" == *'attempt cap'* ]] && ! grep -q '^ARGS=' "$DEPLOY_LOG"; then
  ok "D2: control: at the cap the watchdog does not rebuild"
else
  bad "D2: control: $(printf '%s' "$OUT" | head -c 300)"
fi
watchdog 0 "/usr/bin:/bin" >/dev/null
[[ "$(attempts)" == "0" ]] && ok "D2: a verified GREEN after the incident resets rebuild_attempts to 0" || bad "D2: rebuild_attempts is $(attempts) after recovery"
: > "$DEPLOY_LOG"
watchdog 1 "/usr/bin:/bin" >/dev/null
grep -q '^ARGS=' "$DEPLOY_LOG" && ok "D2: the next stale build gets its own rebuild" || bad "D2: no rebuild after recovery"

# ── D4 ───────────────────────────────────────────────────────────────────────
echo "D4 pm2 switch refreshes stop_exit_codes"
awk '/^_ccbi_pm2_switch\(\) \{/{p=1} p{print} p&&/^}/{exit}' "$REPO_ROOT/scripts/atomic-deploy.sh" > "$WORK/switch.sh"
[[ -s "$WORK/switch.sh" ]] && ok "D4: extracted _ccbi_pm2_switch from atomic-deploy.sh" || bad "D4: could not extract _ccbi_pm2_switch"
mkdir -p "$WORK/noeco"
switch() {  # extra env as args
  : > "$WORK/pm2.log"
  env PATH="$WORK/bin:$PATH" PM2_CALL_LOG="$WORK/pm2.log" "$@" bash -c '
    _warn() { :; }; _err() { :; }
    PM2_APP_NAME=blackceo-command-center; APP_DIR="'"$WORK"'/noeco"; PORT=4000; DB_PATH_OVERRIDE=""
    source "'"$WORK"'/switch.sh"; _ccbi_pm2_switch' >/dev/null 2>&1
}
switch FAKE_PM2_NAMES=blackceo-command-center
grep -qx 'restart blackceo-command-center --update-env --stop-exit-codes 78' "$WORK/pm2.log" \
  && ok "D4: pm2 restart carries --stop-exit-codes 78" || bad "D4: restart call was [$(head -1 "$WORK/pm2.log")]"
switch FAKE_PM2_NAMES=blackceo-command-center FAKE_RESTART_RC=1
grep -qx 'reload blackceo-command-center --update-env --stop-exit-codes 78' "$WORK/pm2.log" \
  && ok "D4: the pm2 reload fallback carries --stop-exit-codes 78" || bad "D4: calls were [$(tr '\n' ';' < "$WORK/pm2.log")]"
switch FAKE_PM2_NAMES=
grep -qE '^start npm --name blackceo-command-center --update-env --stop-exit-codes 78 -- start$' "$WORK/pm2.log" \
  && ok "D4: the last-resort pm2 start npm carries --stop-exit-codes 78" || bad "D4: calls were [$(tr '\n' ';' < "$WORK/pm2.log")]"

# ── D5 ───────────────────────────────────────────────────────────────────────
echo "D5 ecosystem circuit-breaker comment"
ECO="$REPO_ROOT/ecosystem.config.cjs"
if grep -q 'the app moves to `errored` state' "$ECO" || grep -q 'max_restarts never trips' "$ECO"; then
  bad "D5: the comment still claims min_uptime/max_restarts stop a restart loop"
else
  ok "D5: the comment no longer claims min_uptime/max_restarts stop a restart loop"
fi
grep -q 'stop_exit_codes (below) is the ONLY breaker that holds' "$ECO" \
  && ok "D5: the comment names stop_exit_codes as the only breaker that holds" || bad "D5: comment does not name stop_exit_codes"
CODES="$(cd "$REPO_ROOT" && node -e "console.log(JSON.stringify(require('./ecosystem.config.cjs').apps[0].stop_exit_codes))" 2>/dev/null)"
[[ "$CODES" == "[78]" ]] && ok "D5: the config still stops on exit 78" || bad "D5: stop_exit_codes is [$CODES]"

printf '\n[watchdog-cc-rebuild-defects] %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
