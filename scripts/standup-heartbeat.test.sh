#!/usr/bin/env bash
# Tests for standup-heartbeat.sh's health-check exit-code handling (U51 fix).
#
# REGRESSION GUARD: standup-heartbeat.sh used to run cc-health-check.sh as a
# bare simple command under `set -e`. Any non-zero exit (RED=1, UNKNOWN=3)
# killed the WHOLE script on that line, before HEALTH_EXIT=$? was ever
# assigned — so both the "ALERT: RED" branch and the "WARN: UNKNOWN" branch
# were dead code, and the INBOX/TESTING/IN_PROGRESS/ASSIGNED task-checking
# body never ran on any box whose health check returned non-zero. This test
# proves, with a stub cc-health-check.sh and no network calls, that both
# branches are now reachable and behave as documented.
#
# Run:  bash scripts/standup-heartbeat.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/standup-heartbeat-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

cp "$SCRIPT_DIR/standup-heartbeat.sh" "$WORK/standup-heartbeat.sh"
chmod +x "$WORK/standup-heartbeat.sh"

stub_health() {
  # $1 = exit code the stub cc-health-check.sh should return
  cat > "$WORK/cc-health-check.sh" <<STUB
#!/bin/bash
echo '{"pass":false,"indeterminate":$([[ "$1" -eq 3 ]] && echo true || echo false),"detail":"stub"}'
exit $1
STUB
  chmod +x "$WORK/cc-health-check.sh"
}

run_it() {
  local logfile="$1"
  (cd "$WORK" && timeout 15 env LOG_FILE="$logfile" MISSION_CONTROL_URL="http://127.0.0.1:1" bash ./standup-heartbeat.sh) > /dev/null 2>&1
  echo "$?"
}

# ── scenario 1: UNKNOWN (exit 3) — must WARN, then run task body, then exit 0
stub_health 3
LOG3="$WORK/log-unknown.txt"
EXIT3=$(run_it "$LOG3")
BODY3="$(cat "$LOG3" 2>/dev/null || true)"

[[ "$EXIT3" == "0" ]] && ok "UNKNOWN stub: script exits 0" || bad "UNKNOWN stub: expected exit 0, got $EXIT3"
if printf '%s' "$BODY3" | python3 -c "import sys; sys.exit(0 if 'WARN: cc-health-check reports UNKNOWN' in sys.stdin.read() else 1)"; then
  ok "UNKNOWN stub: WARN branch reached (was dead code pre-fix)"
else
  bad "UNKNOWN stub: WARN branch NOT reached"
fi
if printf '%s' "$BODY3" | python3 -c "import sys; sys.exit(0 if 'Standup Heartbeat Summary' in sys.stdin.read() else 1)"; then
  ok "UNKNOWN stub: task-checking body ran after transient health check"
else
  bad "UNKNOWN stub: task-checking body did NOT run"
fi

# ── scenario 2: RED (exit 1) — must ALERT, then exit 1, and SKIP task body
stub_health 1
LOG1="$WORK/log-red.txt"
EXIT1=$(run_it "$LOG1")
BODY1="$(cat "$LOG1" 2>/dev/null || true)"

[[ "$EXIT1" == "1" ]] && ok "RED stub: script exits 1" || bad "RED stub: expected exit 1, got $EXIT1"
if printf '%s' "$BODY1" | python3 -c "import sys; sys.exit(0 if 'ALERT: cc-health-check reports RED' in sys.stdin.read() else 1)"; then
  ok "RED stub: ALERT branch reached (was dead code pre-fix)"
else
  bad "RED stub: ALERT branch NOT reached"
fi
if printf '%s' "$BODY1" | python3 -c "import sys; sys.exit(1 if 'Standup Heartbeat Summary' in sys.stdin.read() else 0)"; then
  ok "RED stub: task-checking body correctly SKIPPED"
else
  bad "RED stub: task-checking body ran despite RED (should skip)"
fi

# ── scenario 3: GREEN (exit 0) — must log GREEN, then run task body, exit 0
stub_health 0
# exit-0 stub still needs indeterminate:false pass:true for realism, but this
# test only exercises the exit-code branch, not JSON parsing.
cat > "$WORK/cc-health-check.sh" <<'STUB'
#!/bin/bash
echo '{"pass":true,"indeterminate":false,"detail":"stub GREEN"}'
exit 0
STUB
chmod +x "$WORK/cc-health-check.sh"
LOG0="$WORK/log-green.txt"
EXIT0=$(run_it "$LOG0")
BODY0="$(cat "$LOG0" 2>/dev/null || true)"

[[ "$EXIT0" == "0" ]] && ok "GREEN stub: script exits 0" || bad "GREEN stub: expected exit 0, got $EXIT0"
if printf '%s' "$BODY0" | python3 -c "import sys; sys.exit(0 if 'cc-health-check: GREEN' in sys.stdin.read() else 1)"; then
  ok "GREEN stub: GREEN branch reached"
else
  bad "GREEN stub: GREEN branch NOT reached"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
