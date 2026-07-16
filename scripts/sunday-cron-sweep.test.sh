#!/usr/bin/env bash
# Tests for sunday-cron-sweep.sh's U51 build items:
#   1. --public-url is ALWAYS passed to cc-health-check.sh (fleet-file 5th
#      field, or CC_PUBLIC_URL in the no-fleet-file local-box fallback) —
#      REGRESSION GUARD: previously NEITHER call site ever passed
#      --public-url, which pinned cc-health-check.sh's CF probe to
#      indeterminate for every box, a second and independent path to a
#      permanent exit 3 (see cc-health-check-exit3.test.sh for the first).
#   2. A per-box ledger is written to $SWEEP_NAME/<label>.json carrying
#      cc_port, override_ack_set, and the public_probe verdict.
#   3. A read-only ASSERT PASS/DRIFT line is logged per box, observational
#      only (never flips the sweep's own exit code).
#
# Uses a stub cc-health-check.sh (records the args it received; returns a
# canned JSON body) so this runs with no network and no real box.
#
# Run:  bash scripts/sunday-cron-sweep.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/sunday-cron-sweep-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
# NOTE: the per-box ledger path is hard-pinned by spec to /tmp/${SWEEP_NAME}/
# (not $TMPDIR-relative), so this test uses distinctive SWEEP_NAME values
# and removes /tmp/<that-name> itself after each scenario — see cleanup below.

cp "$SCRIPT_DIR/sunday-cron-sweep.sh" "$WORK/sunday-cron-sweep.sh"
chmod +x "$WORK/sunday-cron-sweep.sh"

cat > "$WORK/cc-health-check.sh" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "${STUB_ARGS_LOG:-/dev/null}"
port_arg=""; prev=""
for a in "$@"; do [[ "$prev" == "--port" ]] && port_arg="$a"; prev="$a"; done
if [[ "$port_arg" == "4091" ]]; then
  echo '{"pass":true,"indeterminate":false,"cc_port":4091,"override_ack_set":true,"cf_probe":{"pass":true,"indeterminate":false,"detail":"ok"}}'
else
  echo '{"pass":true,"indeterminate":false,"cc_port":4000,"override_ack_set":false,"cf_probe":{"pass":true,"indeterminate":false,"detail":"ok"}}'
fi
exit 0
STUB
chmod +x "$WORK/cc-health-check.sh"

# ── scenario 1: no fleet file, local-box fallback — CC_PUBLIC_URL must reach
#    cc-health-check.sh as --public-url, and a ledger + ASSERT PASS emitted.
ARGS1="$WORK/args1.log"; : > "$ARGS1"
(cd "$WORK" && timeout 15 env STUB_ARGS_LOG="$ARGS1" CC_PUBLIC_URL="http://fake-public.test" \
  SWEEP_NAME="test-sweep-1" \
  FLEET_BOXES_FILE="$WORK/no-such-file" \
  bash ./sunday-cron-sweep.sh) > "$WORK/stdout1.log" 2> "$WORK/stderr1.log"
EXIT1=$?
[[ "$EXIT1" == "0" ]] && ok "local-box fallback: sweep exits 0 (stub health check reports GREEN)" \
  || bad "local-box fallback: expected exit 0, got $EXIT1"

if [[ -f "$ARGS1" ]] && python3 -c "import sys; sys.exit(0 if '--public-url http://fake-public.test' in open('$ARGS1').read() else 1)"; then
  ok "local-box fallback: --public-url reaches cc-health-check.sh from CC_PUBLIC_URL"
else
  bad "local-box fallback: --public-url NOT passed (second independent exit-3 path still open)"
fi

LEDGER1="/tmp/test-sweep-1/local.json"
if [[ -f "$LEDGER1" ]]; then
  ok "ledger file written at /tmp/test-sweep-1/local.json"
  if python3 -c "
import json,sys
d=json.load(open('$LEDGER1'))
sys.exit(0 if d.get('cc_port')==4000 and d.get('override_ack_set')==False and 'public_probe' in d else 1)
"; then
    ok "ledger carries cc_port=4000, override_ack_set=false, public_probe"
  else
    bad "ledger missing/incorrect required fields"
  fi
else
  bad "ledger file NOT written"
fi

if python3 -c "import sys; sys.exit(0 if 'ASSERT PASS: local' in open('$WORK/stderr1.log').read() else 1)"; then
  ok "ASSERT PASS logged for agreeing box"
else
  bad "ASSERT PASS not logged"
fi
rm -rf /tmp/test-sweep-1

# ── scenario 2: fleet file with 2 boxes, one drifted — 5th field (PUBLIC_URL)
#    must parse per-box, and ASSERT DRIFT must fire for the drifted box
#    WITHOUT flipping the sweep's own exit code (observational only).
cat > "$WORK/fleet-boxes" <<'EOF'
4000 /app1 /db1 boxA http://boxa.public.test
4091 /app2 /db2 boxB http://boxb.public.test
EOF
ARGS2="$WORK/args2.log"; : > "$ARGS2"
(cd "$WORK" && timeout 15 env STUB_ARGS_LOG="$ARGS2" SWEEP_NAME="test-sweep-2" \
  FLEET_BOXES_FILE="$WORK/fleet-boxes" \
  bash ./sunday-cron-sweep.sh) > "$WORK/stdout2.log" 2> "$WORK/stderr2.log"
EXIT2=$?

if python3 -c "
t=open('$ARGS2').read()
ok=('--public-url http://boxa.public.test' in t) and ('--public-url http://boxb.public.test' in t)
import sys; sys.exit(0 if ok else 1)
"; then
  ok "fleet-file: per-box 5th-field PUBLIC_URL parsed and passed for both boxes"
else
  bad "fleet-file: per-box PUBLIC_URL not parsed/passed correctly"
fi

if python3 -c "import sys; sys.exit(0 if 'ASSERT DRIFT: boxB' in open('$WORK/stderr2.log').read() else 1)"; then
  ok "ASSERT DRIFT logged for the port-drifted box (cc_port=4091, override_ack_set=true)"
else
  bad "ASSERT DRIFT not logged for the drifted box"
fi

[[ "$EXIT2" == "0" ]] && ok "sweep exit code unaffected by the ASSERT (observational only, per scope)" \
  || bad "sweep exit code changed by the assertion — should be observational only, got $EXIT2"

if [[ -f "/tmp/test-sweep-2/boxB.json" ]] && python3 -c "
import json,sys
d=json.load(open('/tmp/test-sweep-2/boxB.json'))
sys.exit(0 if d.get('cc_port')==4091 and d.get('override_ack_set')==True else 1)
"; then
  ok "drifted box's ledger correctly records cc_port=4091, override_ack_set=true"
else
  bad "drifted box's ledger missing or incorrect"
fi
rm -rf /tmp/test-sweep-2

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
