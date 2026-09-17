#!/usr/bin/env bash
# pm2-logrotate.test.sh — the deploy pins pm2 log rotation, and does not churn.
#
# WHAT THIS PROVES
#   L1  On a box with no pm2-logrotate, the helper installs it and sets all
#       five values.
#   L2  On a box that is ALREADY correct, it makes ZERO `pm2 set` calls. This
#       is the whole point of the idempotence requirement: a deploy that
#       rewrote five module settings every run would churn pm2's module config
#       and print five lines of noise on every box, every deploy, forever.
#   L3  A value that DIFFERS is corrected, and only that one.
#   L4  A box where `pm2 install` fails (offline npm) gets a warning and a
#       SUCCESSFUL return — log rotation is hygiene and must never fail a deploy.
#   L5  A box with no pm2 at all returns 0 with a warning.
#
#   L2 is also the control for L1 and L3: the same helper, the same fixture
#   shape, a different pm2 state. A helper that always set five values would
#   pass L1 and L3 and fail L2, so the split lands on the state, not the test.
#
# Fixture-only: a fake `pm2` on PATH that records every invocation and answers
# from files the test controls. No pm2 daemon is contacted; nothing on this
# machine is installed, started or configured.
#
# Run: bash tests/unit/pm2-logrotate.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HELPER="$REPO_ROOT/scripts/lib/pm2-logrotate.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

if [[ ! -f "$HELPER" ]]; then
  echo "FATAL: $HELPER does not exist"; exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pm2-lr.XXXXXX")"
cleanup() { [[ -n "${PM2_LR_KEEP_WORK:-}" ]] || rm -rf "$WORK"; }
trap cleanup EXIT
mkdir -p "$WORK/bin"

# ── fake pm2 ────────────────────────────────────────────────────────────────
#   ls    prints $FAKE_PM2_LS
#   conf  prints $FAKE_PM2_CONF_FILE
#   install exits $FAKE_PM2_INSTALL_EXIT
#   every invocation is appended verbatim to $PM2_CALL_LOG
cat > "$WORK/bin/pm2" <<'FAKEPM2'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${PM2_CALL_LOG:-/dev/null}"
case "${1:-}" in
  ls)      printf '%s\n' "${FAKE_PM2_LS:-}" ; exit 0 ;;
  conf)    [[ -f "${FAKE_PM2_CONF_FILE:-}" ]] && cat "${FAKE_PM2_CONF_FILE}"; exit 0 ;;
  install) exit "${FAKE_PM2_INSTALL_EXIT:-0}" ;;
  set)     exit "${FAKE_PM2_SET_EXIT:-0}" ;;
  *)       exit 0 ;;
esac
FAKEPM2
chmod +x "$WORK/bin/pm2"

export PATH="$WORK/bin:$PATH"
export PM2_CALL_LOG="$WORK/pm2-calls.log"
export FAKE_PM2_CONF_FILE="$WORK/conf.txt"

# A pm2 conf dump in which every value already matches what the helper wants.
write_correct_conf() {
  cat > "$FAKE_PM2_CONF_FILE" <<'CONF'
Module: pm2-logrotate
$ pm2 set pm2-logrotate:max_size 20M
$ pm2 set pm2-logrotate:retain 14
$ pm2 set pm2-logrotate:compress true
$ pm2 set pm2-logrotate:rotateInterval 0 0 * * *
$ pm2 set pm2-logrotate:workerInterval 300
CONF
}

set_calls() { grep -c '^set pm2-logrotate:' "$PM2_CALL_LOG" 2>/dev/null | tail -1 | tr -d ' '; }

run_helper() {
  : > "$PM2_CALL_LOG"
  # shellcheck source=../../scripts/lib/pm2-logrotate.sh
  ( source "$HELPER"; oc_ensure_pm2_logrotate ) >"$WORK/out.txt" 2>&1
  printf '%s' "$?"
}

# ── L1: a box without the module ────────────────────────────────────────────
echo "[L1] a box with no pm2-logrotate installs it and sets all five values"
export FAKE_PM2_LS="┌─────┬──────────────────────────┐
│ id  │ name                     │
│ 0   │ blackceo-command-center  │"
: > "$FAKE_PM2_CONF_FILE"
export FAKE_PM2_INSTALL_EXIT=0
RC=$(run_helper)
[[ "$RC" == "0" ]] && ok "L1: the helper returns 0" || bad "L1: returned $RC"
grep -q '^install pm2-logrotate$' "$PM2_CALL_LOG" \
  && ok "L1: pm2 install pm2-logrotate was called" || bad "L1: the module was never installed"
for kv in 'max_size 20M' 'retain 14' 'compress true' 'rotateInterval 0 0 \* \* \*' 'workerInterval 300'; do
  grep -q "^set pm2-logrotate:${kv}$" "$PM2_CALL_LOG" \
    && ok "L1: set ${kv}" || bad "L1: never set ${kv} — calls were: $(cat "$PM2_CALL_LOG")"
done
N=$(set_calls)
[[ "$N" == "5" ]] && ok "L1: exactly five settings written" || bad "L1: expected 5 set calls, got $N"

# ── L2: an already-correct box writes nothing (the control) ─────────────────
echo "[L2] an already-correct box makes ZERO pm2 set calls"
export FAKE_PM2_LS="┌─────┬──────────────────────────┐
│ 0   │ blackceo-command-center  │
│ 1   │ pm2-logrotate            │"
write_correct_conf
RC=$(run_helper)
[[ "$RC" == "0" ]] && ok "L2: the helper returns 0" || bad "L2: returned $RC"
grep -q '^install' "$PM2_CALL_LOG" \
  && bad "L2: reinstalled a module that pm2 ls already lists" \
  || ok "L2: the module was not reinstalled"
N=$(set_calls)
[[ "$N" == "0" ]] && ok "L2: zero settings rewritten — no churn on a correct box" \
                  || bad "L2: expected 0 set calls, got $N: $(cat "$PM2_CALL_LOG")"
[[ ! -s "$WORK/out.txt" ]] && ok "L2: and it logged nothing" || ok "L2: output was: $(cat "$WORK/out.txt")"

# ── L3: one wrong value is corrected, and only that one ─────────────────────
echo "[L3] one differing value is corrected, the other four are left alone"
write_correct_conf
# The box is at pm2-logrotate's own default of 10M.
sed -i.bak 's/max_size 20M/max_size 10M/' "$FAKE_PM2_CONF_FILE" && rm -f "${FAKE_PM2_CONF_FILE}.bak"
RC=$(run_helper)
[[ "$RC" == "0" ]] && ok "L3: the helper returns 0" || bad "L3: returned $RC"
grep -q '^set pm2-logrotate:max_size 20M$' "$PM2_CALL_LOG" \
  && ok "L3: max_size was corrected to 20M" || bad "L3: max_size was not corrected"
N=$(set_calls)
[[ "$N" == "1" ]] && ok "L3: exactly one setting written" || bad "L3: expected 1 set call, got $N: $(cat "$PM2_CALL_LOG")"
grep -q 'was 10M' "$WORK/out.txt" \
  && ok "L3: the log names the value it replaced" || bad "L3: the change was not reported: $(cat "$WORK/out.txt")"

# ── L4: pm2 install fails (offline npm) — warn, never fail the deploy ───────
echo "[L4] a failed module install warns and still returns 0"
export FAKE_PM2_LS="│ 0 │ blackceo-command-center │"
: > "$FAKE_PM2_CONF_FILE"
export FAKE_PM2_INSTALL_EXIT=1
RC=$(run_helper)
[[ "$RC" == "0" ]] && ok "L4: returns 0 — log rotation never fails a deploy" || bad "L4: returned $RC"
grep -q 'WARN' "$WORK/out.txt" && ok "L4: it warns loudly" || bad "L4: silent failure"
N=$(set_calls)
[[ "$N" == "0" ]] && ok "L4: it does not configure a module it could not install" || bad "L4: $N set calls after a failed install"
export FAKE_PM2_INSTALL_EXIT=0

# ── L5: no pm2 at all ───────────────────────────────────────────────────────
echo "[L5] a box with no pm2 returns 0 with a warning"
# shellcheck source=../../scripts/lib/pm2-logrotate.sh
RC=$( PATH="/usr/bin:/bin" ; export PATH; : > "$PM2_CALL_LOG"; ( source "$HELPER"; oc_ensure_pm2_logrotate ) >"$WORK/out5.txt" 2>&1; printf '%s' "$?" )
[[ "$RC" == "0" ]] && ok "L5: returns 0 without pm2" || bad "L5: returned $RC"
grep -q 'pm2 is not on PATH' "$WORK/out5.txt" \
  && ok "L5: it names what is missing" || bad "L5: no useful warning: $(cat "$WORK/out5.txt")"

echo ""
printf '[pm2-logrotate] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
