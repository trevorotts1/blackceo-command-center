#!/usr/bin/env bash
#
# issue04-scheduler-liveness-watchdog.test.sh
#
# THE DEFECT (ISSUE-04): every sweep in the Command Center is a node-cron job
# registered in-process. The board jobs watchdog is itself one of those
# jobs, so when the scheduler loop dies the watchdog dies with it, and its only
# side effect (a Telegram notify) never fires. checkBoardJobsWatchdog() was
# exposed on /api/health/deep as advisory.board_jobs_watchdog, which nothing gates on, and
# scripts/cc-health-check.sh reads only checks.*. A live client box therefore
# reported "healthy" for 41 hours with no card moving until a human ran
# `pm2 restart`.
#
# THE INVARIANTS UNDER TEST (the out-of-process half of the fix):
#   W1  classify_red() returns `scheduler-stalled` when the health JSON carries
#       checks.scheduler_liveness.pass == false.
#   W2  an INDETERMINATE scheduler_liveness is NOT classified as a stall. The
#       check reports UNKNOWN when job_liveness itself is unreadable, which is
#       a broken instrument rather than a broken scheduler, and restarting the
#       app would repair neither.
#   W3  with WATCHDOG_SELF_HEAL=1, a scheduler-stalled RED performs exactly ONE
#       `pm2 restart <allowlisted name> --update-env` and never a rebuild.
#   W4  a second pass inside the backoff window does NOT restart again.
#   W5  the attempt cap is honoured; past it, no restart and a human-review line.
#   W6  only an allowlisted CC app name is ever restarted. With pm2 knowing a
#       foreign app only, nothing is restarted at all.
#   W7  the GREEN recovery pass resets the restart budget (per incident, not a
#       lifetime cap).
#   W8  WATCHDOG_SELF_HEAL=0 classifies the stall but takes NO action.
#
# KNOWN-GOOD CONTROL (W0): the same fixture harness, with a health JSON whose
# scheduler_liveness passes and whose service is stopped, must classify as
# `service-stopped`. Without it, a harness that silently produced an
# unparseable verdict would make every assertion above pass for the wrong
# reason. A negative result from this file is only meaningful while W0 is green.
#
# FAIL-FIRST: against the pre-fix tree, W1 and W3 through W7 fail (classify_red
# has no scheduler branch, so the class is the generic `red` and no restart path
# exists). W0, W2 and W8 pass on both trees by design, which is what makes them
# a control rather than a proof.
#
# Fixture-only: a temp scripts/ dir holding a COPY of watchdog-cc.sh next to a
# fake cc-health-check.sh, plus a fake pm2 on PATH that only records what it was
# asked to do. No live pm2 daemon is contacted and nothing on this box is
# started, stopped, restarted or deleted.
#
# Run: bash tests/unit/issue04-scheduler-liveness-watchdog.test.sh

set -uo pipefail  # deliberately NOT -e: several invocations exit non-zero

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WATCHDOG_SRC="$REPO_ROOT/scripts/watchdog-cc.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

if [[ ! -f "$WATCHDOG_SRC" ]]; then
  echo "FATAL: $WATCHDOG_SRC does not exist"; exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/issue04-wd.XXXXXX")"
cleanup() { [[ -n "${ISSUE04_KEEP_WORK:-}" ]] || rm -rf "$WORK"; }
trap cleanup EXIT

mkdir -p "$WORK/cc/scripts" "$WORK/bin" "$WORK/state"
cp "$WATCHDOG_SRC" "$WORK/cc/scripts/watchdog-cc.sh"
WATCHDOG="$WORK/cc/scripts/watchdog-cc.sh"

# ── fake cc-health-check.sh: prints $FAKE_HEALTH_JSON, exits $FAKE_HEALTH_EXIT ─
cat > "$WORK/cc/scripts/cc-health-check.sh" <<'FAKEHC'
#!/usr/bin/env bash
printf '%s\n' "${FAKE_HEALTH_JSON:-{\}}"
exit "${FAKE_HEALTH_EXIT:-0}"
FAKEHC
chmod +x "$WORK/cc/scripts/cc-health-check.sh"

# ── fake pm2: `describe` succeeds only for names in FAKE_PM2_KNOWN; every
#    invocation is appended verbatim to $PM2_CALL_LOG so the test can prove
#    exactly what was (and was not) asked of pm2. ─────────────────────────────
cat > "$WORK/bin/pm2" <<'FAKEPM2'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${PM2_CALL_LOG:-/dev/null}"
if [[ "${1:-}" == "describe" ]]; then
  for known in ${FAKE_PM2_KNOWN:-}; do
    [[ "$known" == "${2:-}" ]] && exit 0
  done
  exit 1
fi
exit 0
FAKEPM2
chmod +x "$WORK/bin/pm2"

export PATH="$WORK/bin:$PATH"
export PM2_CALL_LOG="$WORK/pm2-calls.log"
export WATCHDOG_STATE_DIR="$WORK/state"
export WATCHDOG_ALERT_LOG="$WORK/alerts.log"
export WATCHDOG_PORT=4000
export WATCHDOG_CANONICAL_DIR="$WORK/cc"
export FAKE_PM2_KNOWN="blackceo-command-center"

# A health JSON whose scheduler_liveness is the ONLY failing gating check.
json_stalled() {
  cat <<'JSON'
{"pass":false,"indeterminate":false,"service_status":"online","pm2_topology":{"app_count":1},
 "checks":{"disk_headroom":{"pass":true,"detail":"ok"},
 "scheduler_liveness":{"pass":false,"detail":"scheduler_liveness: in-app scheduler appears STALLED, 4 watched job(s) silent"}}}
JSON
}
# Same shape, but UNKNOWN: the check reports this when job_liveness cannot be
# read, so silence is not evidence of anything. A restart repairs neither.
json_warmup() {
  cat <<'JSON'
{"pass":false,"indeterminate":true,"service_status":"online","pm2_topology":{"app_count":1},
 "checks":{"disk_headroom":{"pass":true,"detail":"ok"},
 "scheduler_liveness":{"pass":false,"indeterminate":true,"detail":"scheduler_liveness: job_liveness is unreadable"}}}
JSON
}
# Control: scheduler is fine, the service is stopped.
json_stopped() {
  cat <<'JSON'
{"pass":false,"indeterminate":false,"service_status":"stopped","pm2_topology":{"app_count":1},
 "checks":{"disk_headroom":{"pass":true,"detail":"ok"},
 "scheduler_liveness":{"pass":true,"detail":"scheduler_liveness: OK"}}}
JSON
}
json_green() {
  cat <<'JSON'
{"pass":true,"indeterminate":false,"service_status":"online","pm2_topology":{"app_count":1},
 "checks":{"disk_headroom":{"pass":true,"detail":"ok"},
 "scheduler_liveness":{"pass":true,"detail":"scheduler_liveness: OK"}}}
JSON
}

run_watchdog() {  # run_watchdog <json-fn> <exit-code> <stderr-file>
  FAKE_HEALTH_JSON="$($1)" FAKE_HEALTH_EXIT="$2" bash "$WATCHDOG" >/dev/null 2>"$3"
  return $?
}

reset_state() { rm -rf "$WORK/state"; mkdir -p "$WORK/state"; : > "$PM2_CALL_LOG"; : > "$WORK/alerts.log"; }

# ── W0: KNOWN-GOOD CONTROL on the instrument ─────────────────────────────────
echo "[W0] control: a non-scheduler RED still classifies correctly through this harness"
reset_state
export WATCHDOG_SELF_HEAL=0
run_watchdog json_stopped 1 "$WORK/w0.err"; W0_CODE=$?
if [[ "$W0_CODE" == "1" ]]; then ok "W0: harness produces a definitive RED (exit 1)"; else bad "W0: expected exit 1, got $W0_CODE"; fi
if grep -q 'incident: service-stopped' "$WORK/w0.err"; then
  ok "W0: control classifies as service-stopped (the harness really reaches classify_red)"
else
  bad "W0: control did not classify as service-stopped; every other assertion in this file is now meaningless"
  echo "       stderr was:"; sed 's/^/       /' "$WORK/w0.err"
fi

# ── W1: the stall class ──────────────────────────────────────────────────────
echo "[W1] scheduler_liveness.pass=false classifies as scheduler-stalled"
reset_state
run_watchdog json_stalled 1 "$WORK/w1.err"; W1_CODE=$?
if [[ "$W1_CODE" == "1" ]]; then ok "W1: definitive RED (exit 1)"; else bad "W1: expected exit 1, got $W1_CODE"; fi
grep -q 'incident: scheduler-stalled' "$WORK/w1.err" \
  && ok "W1: classified scheduler-stalled" \
  || bad "W1: not classified scheduler-stalled"
grep -q '"incident":"scheduler-stalled"' "$WORK/alerts.log" \
  && ok "W1: incident key reaches the alert log" \
  || bad "W1: alert log missing the scheduler-stalled incident key"

# ── W2: an INDETERMINATE scheduler_liveness is not a stall ───────────────────
echo "[W2] an indeterminate scheduler_liveness is never classified as a stall"
reset_state
run_watchdog json_warmup 1 "$WORK/w2.err"
grep -q 'incident: scheduler-stalled' "$WORK/w2.err" \
  && bad "W2: an UNKNOWN scheduler_liveness was misclassified as a stall" \
  || ok "W2: an UNKNOWN scheduler_liveness is not a stall"

# ── W3: one bounded restart, no rebuild ──────────────────────────────────────
echo "[W3] self-heal performs exactly one bounded pm2 restart and never a rebuild"
reset_state
export WATCHDOG_SELF_HEAL=1
export WATCHDOG_SCHEDULER_MAX_ATTEMPTS=3
export WATCHDOG_SCHEDULER_BACKOFF_BASE=900
run_watchdog json_stalled 1 "$WORK/w3.err"
RESTARTS=$(grep -c -- 'restart blackceo-command-center --update-env' "$PM2_CALL_LOG" 2>/dev/null || echo 0)
RESTARTS=$(printf '%s' "$RESTARTS" | tail -1)
if [[ "$RESTARTS" == "1" ]]; then ok "W3: exactly one pm2 restart --update-env"; else bad "W3: expected 1 restart, got $RESTARTS"; fi
grep -q 'delete' "$PM2_CALL_LOG" && bad "W3: pm2 delete was called (forbidden for this class)" || ok "W3: no pm2 delete"
grep -q 'restart all' "$PM2_CALL_LOG" && bad "W3: pm2 restart all was called (forbidden)" || ok "W3: no pm2 restart all"
grep -q 'REBUILD' "$WORK/w3.err" && bad "W3: the rebuild path ran for a scheduler stall" || ok "W3: no rebuild for a scheduler stall"
grep -q 'no zombie/orphan/EADDRINUSE' "$WORK/w3.err" \
  && bad "W3: the legacy zombie heal also ran for this class" \
  || ok "W3: the legacy zombie heal is excluded for this class"

# ── W4: backoff blocks a second restart ──────────────────────────────────────
echo "[W4] a second pass inside the backoff window does not restart again"
: > "$PM2_CALL_LOG"
run_watchdog json_stalled 1 "$WORK/w4.err"
RESTARTS4=$(grep -c -- 'restart blackceo-command-center' "$PM2_CALL_LOG" 2>/dev/null || echo 0)
RESTARTS4=$(printf '%s' "$RESTARTS4" | tail -1)
if [[ "$RESTARTS4" == "0" ]]; then ok "W4: no restart inside the backoff window"; else bad "W4: expected 0 restarts, got $RESTARTS4"; fi
grep -q 'backoff window not yet elapsed' "$WORK/w4.err" \
  && ok "W4: backoff refusal is stated on stderr" \
  || bad "W4: backoff refusal not reported"

# ── W5: attempt cap ──────────────────────────────────────────────────────────
echo "[W5] the attempt cap stops automatic restarts and names human review"
reset_state
python3 -c "
import json,sys
json.dump({'scheduler_restart_attempts': 3, 'last_scheduler_restart_at': '2000-01-01T00:00:00Z'}, open(sys.argv[1],'w'))
" "$WORK/state/scheduler-restart-state.json"
: > "$PM2_CALL_LOG"
run_watchdog json_stalled 1 "$WORK/w5.err"
RESTARTS5=$(grep -c -- 'restart blackceo-command-center' "$PM2_CALL_LOG" 2>/dev/null || echo 0)
RESTARTS5=$(printf '%s' "$RESTARTS5" | tail -1)
if [[ "$RESTARTS5" == "0" ]]; then ok "W5: no restart past the cap"; else bad "W5: expected 0 restarts past the cap, got $RESTARTS5"; fi
grep -q 'human review required' "$WORK/w5.err" \
  && ok "W5: cap message names human review" \
  || bad "W5: cap message missing"

# ── W6: allowlist ────────────────────────────────────────────────────────────
echo "[W6] a non-allowlisted pm2 app is never restarted"
reset_state
export FAKE_PM2_KNOWN="openclaw-gateway"
: > "$PM2_CALL_LOG"
run_watchdog json_stalled 1 "$WORK/w6.err"
grep -q 'restart openclaw-gateway' "$PM2_CALL_LOG" \
  && bad "W6: restarted a foreign pm2 app" \
  || ok "W6: foreign pm2 app untouched"
RESTARTS6=$(grep -c -- 'restart ' "$PM2_CALL_LOG" 2>/dev/null || echo 0)
RESTARTS6=$(printf '%s' "$RESTARTS6" | tail -1)
if [[ "$RESTARTS6" == "0" ]]; then ok "W6: nothing was restarted at all"; else bad "W6: expected 0 restarts, got $RESTARTS6"; fi
grep -q 'no allowlisted CC app found' "$WORK/w6.err" \
  && ok "W6: refusal names the allowlist it searched" \
  || bad "W6: allowlist refusal not reported"
export FAKE_PM2_KNOWN="blackceo-command-center"

# ── W7: the GREEN recovery pass resets the budget ────────────────────────────
echo "[W7] recovery resets the restart budget (per incident, not a lifetime cap)"
reset_state
run_watchdog json_stalled 1 "$WORK/w7a.err"
ATTEMPTS_AFTER=$(python3 -c "
import json,sys
try: print(json.load(open(sys.argv[1])).get('scheduler_restart_attempts', 0))
except Exception: print(0)" "$WORK/state/scheduler-restart-state.json")
if [[ "$ATTEMPTS_AFTER" == "1" ]]; then ok "W7: one attempt recorded durably"; else bad "W7: expected 1 recorded attempt, got $ATTEMPTS_AFTER"; fi
run_watchdog json_green 0 "$WORK/w7b.err"; W7_CODE=$?
if [[ "$W7_CODE" == "0" ]]; then ok "W7: GREEN pass exits 0"; else bad "W7: expected exit 0, got $W7_CODE"; fi
ATTEMPTS_RESET=$(python3 -c "
import json,sys
try: print(json.load(open(sys.argv[1])).get('scheduler_restart_attempts', 0))
except Exception: print(0)" "$WORK/state/scheduler-restart-state.json")
if [[ "$ATTEMPTS_RESET" == "0" ]]; then ok "W7: budget reset on recovery"; else bad "W7: budget not reset, got $ATTEMPTS_RESET"; fi
grep -q 'restart budget reset' "$WORK/w7b.err" \
  && ok "W7: the reset is stated on stderr" \
  || bad "W7: reset not reported"

# ── W8: self-heal off means classify only ────────────────────────────────────
echo "[W8] WATCHDOG_SELF_HEAL=0 classifies the stall but takes no action"
reset_state
export WATCHDOG_SELF_HEAL=0
run_watchdog json_stalled 1 "$WORK/w8.err"
grep -q 'incident: scheduler-stalled' "$WORK/w8.err" \
  && ok "W8: still classified" \
  || bad "W8: classification lost when self-heal is off"
RESTARTS8=$(grep -c -- 'restart ' "$PM2_CALL_LOG" 2>/dev/null || echo 0)
RESTARTS8=$(printf '%s' "$RESTARTS8" | tail -1)
if [[ "$RESTARTS8" == "0" ]]; then ok "W8: no pm2 action with self-heal off"; else bad "W8: expected 0 restarts, got $RESTARTS8"; fi

echo ""
printf '[issue04-scheduler-liveness-watchdog] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
