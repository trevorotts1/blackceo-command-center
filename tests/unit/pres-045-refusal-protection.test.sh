#!/usr/bin/env bash
#
# pres-045-refusal-protection.test.sh — PRES-045 / CC-H1 Wave 1 (WF17-B).
#
# THE INVARIANTS UNDER TEST (health + watchdog + install templates):
#
#   A. cc-health-check.sh, when HTTP is unreachable, no longer reports a blind
#      UNKNOWN:
#      A1. stopped/errored pm2 service            → exit 1 RED
#      A2. current matching refusal receipt       → exit 1 RED
#      A3. documented startup grace (fresh app, no receipt) → exit 3 UNKNOWN
#          with "startup_grace":true
#      A4. persistent unknown past the deadline   → exit 1 RED with
#          "persistent_unknown":true (actionable incident)
#      A5. read-only/unwritable receipt path      → still reports the verdict
#          (stderr visible, exit still correct), never crashes
#      A6. recovery: receipt resolves (→ .resolved) only for verified recovery
#          (online service + matching build digest); a receipt whose digest no
#          longer matches is archived as stale; a mismatching-digest receipt
#          with service online does NOT keep the box RED
#      A7. quoted/space-containing paths give a valid classification
#      A8. fractional-second (millis) refused_at parses (node toISOString)
#   B. watchdog-cc.sh:
#      B1. RED alert is emitted ONCE per incident key (dedupe across passes)
#      B2. first GREEN after RED emits exactly one RECOVERY line and archives
#      B3. refusal-receipt RED with self-heal on triggers AT MOST ONE locked
#          authorized rebuild (second pass within backoff does not re-run it),
#          never `pm2 delete all`, respects disk preflight (refuses on a full
#          disk) and respects the attempt cap
#      B4. exit 3 (UNKNOWN) never alerts and never acts
#   C. Install bootstrap templates (fresh + upgrade):
#      C1. fresh template carries the exact exit policy stop_exit_codes: [78]
#      C2. upgrade reconciliation detects an existing ecosystem WITHOUT the
#          policy and rewrites it (with backup), preserving unrelated settings
#      C3. an already-canonical file is left alone (no churn)
#
# Fixture-only: isolated PM2_HOME, fake pm2 shim, fake receipt paths — no live
# pm2 daemon is contacted, nothing on this box is started, stopped or deleted.
#
# Run: bash tests/unit/pres-045-refusal-protection.test.sh

set -uo pipefail  # deliberately NOT -e: several invocations exit non-zero

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pres045-test.XXXXXX")"
KEEP_WORK="${PRES045_KEEP_WORK:-}"
cleanup() { [[ -n "$KEEP_WORK" ]] || rm -rf "$WORK"; }
trap cleanup EXIT

mkdir -p "$WORK/bin" "$WORK/state"

# ── fake pm2 shim: reads PM2_JLIST_FIXTURE, returns its content as `pm2 jlist` ─
cat > "$WORK/bin/pm2" <<'FAKEPM2'
#!/usr/bin/env bash
if [[ "$1" == "jlist" ]]; then
  if [[ -n "${PM2_JLIST_FIXTURE:-}" && -f "$PM2_JLIST_FIXTURE" ]]; then
    cat "$PM2_JLIST_FIXTURE"; exit 0
  fi
  echo "[]"; exit 0
fi
# Any other pm2 subcommand (stop/start/delete/restart) is FORBIDDEN in tests.
echo "FAKE-PM2-FORBIDDEN-COMMAND: $*" >&2
exit 99
FAKEPM2
chmod +x "$WORK/bin/pm2"

# Fake curl: always fails to connect (HTTP unreachable scenarios) unless the
# scenario sets FAKE_CURL_MODE=ok — a fully GREEN deep-health box: 200 pass on
# /api/health/deep, a root page carrying a /_next/static ref, the asset fetch
# 200 with a JS content type, no CF redirect. Mode read at INVOCATION time from
# the env so one shim serves both fail/ok scenarios (quoted heredoc).
make_fake_curl() {  # kept for scenario readability; mode passed via env below
  cat > "$WORK/bin/curl" <<'FAKECURL'
#!/usr/bin/env bash
if [[ "${FAKE_CURL_MODE:-fail}" == "ok" ]]; then
  args=("$@")
  has_flag() { local f; for f in "${args[@]}"; do [[ "$f" == "$1" ]] && return 0; done; return 1; }
  wval=""
  for i in "${!args[@]}"; do
    [[ "${args[$i]}" == "-w" ]] && wval="${args[$((i+1))]}"
  done
  if has_flag "--write-out"; then
    printf '%s' '{"pass":true,"indeterminate":false,"checks":{}}'
    printf '\n{"_http_code":200}'
  elif has_flag "-I"; then
    printf 'HTTP/1.1 200 OK\r\nContent-Type: application/javascript\r\n\r\n'
  elif has_flag "-o" && [[ -n "$wval" ]]; then
    if [[ "$wval" == *redirect_url* ]]; then printf '200 '; else printf '200'; fi
  elif has_flag "-o"; then
    printf 'ROOTHTML'
  else
    printf '<html><script src="/_next/static/chunk.main.js"></script></html>'
  fi
else
  printf '\n{"_http_code":0}'
fi
FAKECURL
  chmod +x "$WORK/bin/curl"
}

# Fixture: stopped target app (old uptime — well past startup grace), on :4000,
# named mission-control (the health check default target name).
cat > "$WORK/pm2-stopped.json" <<'EOF'
[{"pm_id":7,"name":"mission-control","pm2_env":{"name":"mission-control","status":"stopped","pm_uptime":1,"pm_cwd":"/data/projects/command-center","args":"scripts/cc-start.sh --port 4000","env_data":{"CC_PORT":"4000"}}}]
EOF

# Fixture: errored target app.
cat > "$WORK/pm2-errored.json" <<'EOF'
[{"pm_id":7,"name":"mission-control","pm2_env":{"name":"mission-control","status":"errored","pm_uptime":1,"pm_cwd":"/data/projects/command-center","args":"scripts/cc-start.sh --port 4000","env_data":{"CC_PORT":"4000"}}}]
EOF

# Fixture: online target app freshly launched (uptime ≈ now).
python3 - "$WORK/pm2-online-fresh.json" <<'PYEOF'
import json, sys, time
now_ms = int(time.time() * 1000)
app = {"pm_id": 7, "name": "mission-control", "pm2_env": {"name": "mission-control", "status": "online", "pm_uptime": now_ms - 5000, "pm_cwd": "/data/projects/command-center", "args": "scripts/cc-start.sh --port 4000", "env_data": {"CC_PORT": "4000"}}}
with open(sys.argv[1], "w") as fh: json.dump([app], fh)
PYEOF

# Fixture: online target app, OLD uptime (hours) — the post-grace steady state.
python3 - "$WORK/pm2-online-old.json" <<'PYEOF'
import json, sys, time
now_ms = int(time.time() * 1000)
app = {"pm_id": 7, "name": "mission-control", "pm2_env": {"name": "mission-control", "status": "online", "pm_uptime": now_ms - 55 * 3600 * 1000, "pm_cwd": "/data/projects/command-center", "args": "scripts/cc-start.sh --port 4000", "env_data": {"CC_PORT": "4000"}}}
with open(sys.argv[1], "w") as fh: json.dump([app], fh)
PYEOF

run_health() {  # run_health <label> — env already set by caller
  local label="$1"; shift
  ( export PATH="$WORK/bin:$PATH"; bash "$REPO_ROOT/scripts/cc-health-check.sh" --skip-pm2 "$@" 2>"$WORK/health-stderr.txt" )
}

# ── A1: stopped service + HTTP unreachable → RED ─────────────────────────────
echo "[A1] stopped service, HTTP unreachable → exit 1 RED"
make_fake_curl; export FAKE_CURL_MODE=fail
export PM2_JLIST_FIXTURE="$WORK/pm2-stopped.json"
OUT=$(run_health A1 --receipt-path "$WORK/none/receipt.json" --json-only); CODE=$?
if [[ "$CODE" == "1" ]]; then ok "A1: exit 1 (RED)"; else bad "A1: expected exit 1, got $CODE"; fi
printf '%s' "$OUT" | grep -q '"indeterminate":false' && ok "A1: verdict definitive (indeterminate:false)" || bad "A1: indeterminate not false"
printf '%s' "$OUT" | grep -q '"service_status":"stopped"' && ok "A1: service_status=stopped in JSON" || bad "A1: service_status missing"

# ── A2: current refusal receipt → RED ────────────────────────────────────────
echo "[A2] current refusal receipt → exit 1 RED"
# Receipt without build_digest (matches the cc-start.sh printf shape): present
# receipt + non-online service classifies as current refusal.
export PM2_JLIST_FIXTURE="$WORK/pm2-stopped.json"
mkdir -p "$WORK/receipts"
printf '{"refused_at":"%s","reason":"stale-build","newer":"src/app/page.tsx","exit":78,"remedy":"bash scripts/atomic-deploy.sh"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$WORK/receipts/cc-start-refused.json"
OUT=$(run_health A2 --receipt-path "$WORK/receipts/cc-start-refused.json" --json-only); CODE=$?
if [[ "$CODE" == "1" ]]; then ok "A2: exit 1 (RED)"; else bad "A2: expected exit 1, got $CODE"; fi
printf '%s' "$OUT" | grep -q '"receipt_current":true' && ok "A2: receipt_current=true" || bad "A2: receipt_current not true"
printf '%s' "$OUT" | grep -q '"reason":"stale-build"' && ok "A2: receipt reason carried through" || bad "A2: reason missing"

# ── A3: startup grace — fresh app, no receipt → bounded UNKNOWN ─────────────
echo "[A3] startup grace → exit 3 with startup_grace:true"
export PM2_JLIST_FIXTURE="$WORK/pm2-online-fresh.json"
OUT=$(run_health A3 --receipt-path "$WORK/none/receipt.json" --json-only); CODE=$?
if [[ "$CODE" == "3" ]]; then ok "A3: exit 3 (bounded UNKNOWN)"; else bad "A3: expected exit 3, got $CODE"; fi
printf '%s' "$OUT" | grep -q '"startup_grace":true' && ok "A3: startup_grace documented in JSON" || bad "A3: startup_grace flag missing"

# After the grace window the same online app falls to persistent-unknown ladder
# (still exit 3 while under the deadline — but past-deadline must escalate).
export PM2_JLIST_FIXTURE="$WORK/pm2-online-old.json"
OUT=$(run_health A3 --receipt-path "$WORK/none/receipt.json" --json-only); CODE=$?
if [[ "$CODE" == "3" ]]; then ok "A3: old-uptime online app stays exit 3 within deadline"; else bad "A3: expected exit 3 within deadline, got $CODE"; fi

# ── A4: persistent unknown → actionable RED after deadline ───────────────────
echo "[A4] persistent unknown → exit 1 with persistent_unknown:true"
SINCE=$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=400)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
OUT=$(run_health A4 --receipt-path "$WORK/none/receipt.json" --json-only --unknown-since "$SINCE" --unknown-deadline 300); CODE=$?
if [[ "$CODE" == "1" ]]; then ok "A4: exit 1 (actionable incident)"; else bad "A4: expected exit 1, got $CODE"; fi
printf '%s' "$OUT" | grep -q '"persistent_unknown":true' && ok "A4: persistent_unknown:true" || bad "A4: persistent_unknown flag missing"
# Within the deadline it must still be bounded UNKNOWN.
SINCE2=$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=10)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
OUT=$(run_health A4 --receipt-path "$WORK/none/receipt.json" --json-only --unknown-since "$SINCE2" --unknown-deadline 300); CODE=$?
if [[ "$CODE" == "3" ]]; then ok "A4: within deadline still exit 3"; else bad "A4: expected exit 3 within deadline, got $CODE"; fi

# ── A5: read-only receipt directory must not crash the classification ────────
echo "[A5] read-only receipt path → classification still correct, stderr present"
export PM2_JLIST_FIXTURE="$WORK/pm2-stopped.json"
mkdir -p "$WORK/ro-state"
chmod 555 "$WORK/ro-state"
OUT=$(run_health A5 --receipt-path "$WORK/ro-state/sub/dir/cc-start-refused.json" --json-only); CODE=$?
if [[ "$CODE" == "1" ]]; then ok "A5: stopped service still RED with unwritable receipt path"; else bad "A5: expected exit 1, got $CODE"; fi
chmod 755 "$WORK/ro-state"

# ── A6: recovery clearing — receipt resolved only on verified recovery ──────
echo "[A6] recovery clearing semantics"
mkdir -p "$WORK/fakecc/.next" "$WORK/fakecc/.cc-state"
export PM2_JLIST_FIXTURE="$WORK/pm2-stopped.json"
DIGEST="buildid-abcdef123456"
printf '%s' "$DIGEST" > "$WORK/fakecc/.next/BUILD_ID"
RECEIPT="$WORK/fakecc/.cc-state/cc-start-refused.json"
# Digest field is `build_id` (matches cc-start.sh's JSON receipt writer).
printf '{"refused_at":"%s","reason":"stale-build","build_id":"%s","exit":78,"remedy":"rebuild"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$DIGEST" > "$RECEIPT"
# 6d. legacy `build_digest` field name is still accepted.
printf '{"refused_at":"%s","reason":"stale-build","build_digest":"%s","exit":78}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$DIGEST" > "$WORK/fakecc/.cc-state/legacy.json"
OUT=$(run_health A6 --receipt-path "$WORK/fakecc/.cc-state/legacy.json" --canonical-dir "$WORK/fakecc" --json-only); CODE=$?
[[ "$CODE" == "1" ]] && ok "A6d: legacy build_digest receipt still classifies RED" || bad "A6d: legacy receipt field lost, got $CODE"
rm -f "$WORK/fakecc/.cc-state/legacy.json" "$WORK/fakecc/.cc-state/legacy.json.resolved"
# 6a. receipt digest MATCHES live build + service STOPPED → RED, receipt NOT archived
OUT=$(run_health A6 --receipt-path "$RECEIPT" --canonical-dir "$WORK/fakecc" --json-only); CODE=$?
[[ "$CODE" == "1" ]] && ok "A6a: matching-digest receipt + stopped service = RED" || bad "A6a: expected exit 1, got $CODE"
[[ -f "$RECEIPT" ]] && ok "A6a: receipt NOT archived while unresolved" || bad "A6a: receipt was wrongly archived"
# 6b. service ONLINE + matching digest → verified recovery → receipt archived
export PM2_JLIST_FIXTURE="$WORK/pm2-online-old.json"
OUT=$(run_health A6 --receipt-path "$RECEIPT" --canonical-dir "$WORK/fakecc" --json-only); CODE=$?
[[ -f "$RECEIPT" ]] && bad "A6b: receipt not archived after verified recovery" || ok "A6b: receipt archived (→ .resolved) after verified recovery"
[[ -f "$RECEIPT.resolved" ]] && ok "A6b: .resolved sidecar exists" || bad "A6b: .resolved sidecar missing"
# 6c. receipt with STALE digest (build replaced) → archived as stale, box NOT pinned red
printf '{"refused_at":"%s","reason":"stale-build","build_id":"OLD-BUILD","exit":78}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RECEIPT"
export PM2_JLIST_FIXTURE="$WORK/pm2-stopped.json"
OUT=$(run_health A6 --receipt-path "$RECEIPT" --canonical-dir "$WORK/fakecc" --json-only); CODE=$?
[[ -f "$RECEIPT" ]] && bad "A6c: stale-digest receipt not archived" || ok "A6c: stale-digest receipt archived"
[[ "$CODE" != "1" ]] || printf '%s' "$OUT" | grep -q 'receipt_current":true' && bad "A6c: stale receipt classified current" || ok "A6c: stale receipt not classified current"

# ── A7: quoted / space-containing paths ──────────────────────────────────────
echo "[A7] space-containing receipt path"
mkdir -p "$WORK/path with spaces"
printf '{"refused_at":"%s","reason":"stale-build","exit":78}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$WORK/path with spaces/cc-start-refused.json"
export PM2_JLIST_FIXTURE="$WORK/pm2-stopped.json"
OUT=$(run_health A7 --receipt-path "$WORK/path with spaces/cc-start-refused.json" --json-only); CODE=$?
[[ "$CODE" == "1" ]] && ok "A7: space-path receipt still classifies RED" || bad "A7: expected exit 1, got $CODE"
printf '%s' "$OUT" | grep -q '"reason":"stale-build"' && ok "A7: quoted path fields parsed cleanly" || bad "A7: reason field lost on space path"

# ── A8: fractional-second (millis) refused_at — cc-start.sh writes node's
# toISOString, which carries ".mmmZ". A strict %Y-%m-%dT%H:%M:%SZ parser rejects
# it and the receipt age comes back empty (the exact WF17-B repair bug).
echo "[A8] millis refused_at still parses (fromisoformat tolerance)"
python3 - "$WORK/receipts/millis.json" <<'PYEOF'
import datetime, json, sys
ts = (datetime.datetime.now(datetime.timezone.utc)
      - datetime.timedelta(seconds=31)).isoformat().replace('+00:00', 'Z')
json.dump({"refused_at": ts, "reason": "stale-build", "build_id": "B-MILLIS", "exit": 78},
          open(sys.argv[1], 'w'))
PYEOF
mkdir -p "$WORK/milliscc/.next"
printf 'B-MILLIS' > "$WORK/milliscc/.next/BUILD_ID"
export PM2_JLIST_FIXTURE="$WORK/pm2-stopped.json"
OUT=$(run_health A8 --receipt-path "$WORK/receipts/millis.json" --canonical-dir "$WORK/milliscc" --json-only); CODE=$?
[[ "$CODE" == "1" ]] && ok "A8: millis refused_at receipt classifies RED" || bad "A8: expected exit 1, got $CODE"
printf '%s' "$OUT" | grep -q '"age_seconds":"[0-9]' && ok "A8: receipt age numeric (millis parsed, not empty)" || bad "A8: age empty — millis timestamp rejected"
printf '%s' "$OUT" | grep -q '"receipt_current":true' && ok "A8: matching millis receipt classified current" || bad "A8: millis receipt not classified current"

# ── B: watchdog dedupe / recovery / locked rebuild ────────────────────────────
echo "[B1] watchdog RED dedupe — one alert per incident key"
W_STATE="$WORK/state"
export WATCHDOG_STATE_DIR="$W_STATE"
export WATCHDOG_ALERT_LOG="$WORK/watchdog-alerts.log"
export WATCHDOG_SELF_HEAL=0
export WATCHDOG_PORT=4000
export PM2_JLIST_FIXTURE="$WORK/pm2-stopped.json"
# receipt → refusal-receipt class
export CC_REFUSAL_RECEIPT="$WORK/receipts/cc-start-refused.json"
export PATH="$WORK/bin:$PATH"
: > "$WORK/watchdog-alerts.log"
bash "$REPO_ROOT/scripts/watchdog-cc.sh" >/dev/null 2>"$WORK/wd1.err"; CODE1=$?
bash "$REPO_ROOT/scripts/watchdog-cc.sh" >/dev/null 2>"$WORK/wd2.err"; CODE2=$?
ALERTS=$(grep -c '"watchdog_alert":true' "$WORK/watchdog-alerts.log" 2>/dev/null); ALERTS=${ALERTS:-0}; ALERTS=$(echo "$ALERTS" | tail -1)
if [[ "$CODE1" == "1" && "$CODE2" == "1" ]]; then ok "B1: both passes RED (exit 1)"; else bad "B1: expected exit 1 both passes, got $CODE1/$CODE2"; fi
if [[ "$ALERTS" == "1" ]]; then ok "B1: exactly one alert for repeated identical incident (dedupe)"; else bad "B1: expected 1 alert, got $ALERTS"; fi
grep -q 'already alerted (deduped' "$WORK/wd2.err" && ok "B1: second pass explicitly deduped" || bad "B1: dedupe message missing"

echo "[B2] watchdog recovery — first GREEN archives incident, one RECOVERY line"
make_fake_curl; export FAKE_CURL_MODE=ok
export PM2_JLIST_FIXTURE="$WORK/pm2-online-old.json"
unset CC_REFUSAL_RECEIPT
# A GREEN verdict requires every probe resolvable: CC_PUBLIC_URL unset keeps the
# CF probe at row-27 UNKNOWN forever (exit 3), so give the probe a URL the fake
# curl answers 200.
export CC_PUBLIC_URL="https://fake.example.test/"
bash "$REPO_ROOT/scripts/watchdog-cc.sh" >/dev/null 2>"$WORK/wd3.err"; CODE3=$?
unset CC_PUBLIC_URL
RECOVERIES=$(grep -c '"watchdog_recovery":true' "$WORK/watchdog-alerts.log" 2>/dev/null); RECOVERIES=${RECOVERIES:-0}; RECOVERIES=$(echo "$RECOVERIES" | tail -1)
if [[ "$CODE3" == "0" ]]; then ok "B2: GREEN pass exits 0"; else bad "B2: expected exit 0, got $CODE3"; fi
if [[ "$RECOVERIES" == "1" ]]; then ok "B2: exactly one RECOVERY line"; else bad "B2: expected 1 recovery, got $RECOVERIES"; fi
grep -q 'RECOVERY' "$WORK/wd3.err" && ok "B2: RECOVERY visible on stderr" || bad "B2: RECOVERY not on stderr"

echo "[B3] watchdog locked authorized rebuild — once, locked, disk-preflighted, backoff"
export PM2_JLIST_FIXTURE="$WORK/pm2-stopped.json"
make_fake_curl; export FAKE_CURL_MODE=fail
export CC_REFUSAL_RECEIPT="$WORK/receipts/cc-start-refused.json"
export WATCHDOG_SELF_HEAL=1
rm -rf "$W_STATE"; mkdir -p "$W_STATE"
export WATCHDOG_MIN_FREE_MB=16  # assume generous disk for the happy path
REBUILD_LOG="$W_STATE/rebuild.log"
: > "$WORK/watchdog-alerts.log"
# The rebuild command is a SENTINEL: appends a line; it must appear exactly once
# for two back-to-back passes (backoff blocks the second), and never runs
# pm2 stop/delete/start through the fake (which would exit 99).
export WATCHDOG_REBUILD_CMD="printf 'REBUILD-RAN\\n' >> $REBUILD_LOG"
bash "$REPO_ROOT/scripts/watchdog-cc.sh" >/dev/null 2>"$WORK/wd4.err"
sleep 1
bash "$REPO_ROOT/scripts/watchdog-cc.sh" >/dev/null 2>"$WORK/wd5.err"
RUNS=$(grep -c 'REBUILD-RAN' "$REBUILD_LOG" 2>/dev/null); RUNS=${RUNS:-0}; RUNS=$(echo "$RUNS" | tail -1)
if [[ "$RUNS" == "1" ]]; then ok "B3: exactly one rebuild attempt for two RED passes (backoff honored)"; else bad "B3: expected 1 rebuild run, got $RUNS"; fi
grep -q 'authorized atomic rebuild attempt' "$WORK/wd4.err" && ok "B3: rebuild announced as authorized+locked" || bad "B3: rebuild announcement missing"
grep -q 'FAKE-PM2-FORBIDDEN-COMMAND' "$WORK/wd4.err" "$WORK/wd5.err" 2>/dev/null && bad "B3: rebuild path invoked a forbidden pm2 mutation" || ok "B3: no pm2 mutation attempted by rebuild path"
# Attempt cap: after cap reached, no further runs even past backoff.
python3 -c "
import json
d = {'rebuild_attempts': 99, 'last_rebuild_at': '2026-01-01T00:00:00Z'}
json.dump(d, open('$W_STATE/rebuild-state.json', 'w'))
"
bash "$REPO_ROOT/scripts/watchdog-cc.sh" >/dev/null 2>"$WORK/wd6.err"
RUNS2=$(grep -c 'REBUILD-RAN' "$REBUILD_LOG" 2>/dev/null); RUNS2=${RUNS2:-0}; RUNS2=$(echo "$RUNS2" | tail -1)
if [[ "$RUNS2" == "1" ]]; then ok "B3: attempt cap respected (still 1 run)"; else bad "B3: cap not respected, runs=$RUNS2"; fi
grep -q 'attempt cap' "$WORK/wd6.err" && ok "B3: cap message present" || bad "B3: cap message missing"
# Disk preflight refusal: tiny free-space threshold forces refusal on this disk.
rm -rf "$W_STATE"; mkdir -p "$W_STATE"
export WATCHDOG_MIN_FREE_MB=99999999
bash "$REPO_ROOT/scripts/watchdog-cc.sh" >/dev/null 2>"$WORK/wd7.err"
RUNS3=$(grep -c 'REBUILD-RAN' "$REBUILD_LOG" 2>/dev/null); RUNS3=${RUNS3:-0}; RUNS3=$(echo "$RUNS3" | tail -1)
if [[ "$RUNS3" == "0" ]]; then ok "B3: disk preflight refused rebuild (no new run)"; else bad "B3: preflight not enforced, runs=$RUNS3"; fi
grep -q 'REBUILD REFUSED' "$WORK/wd7.err" && ok "B3: preflight refusal message present" || bad "B3: preflight message missing"
unset WATCHDOG_MIN_FREE_MB

echo "[B4] watchdog UNKNOWN — no alert, no action"
: > "$WORK/watchdog-alerts.log"
export WATCHDOG_SELF_HEAL=1
export WATCHDOG_MIN_FREE_MB=16
export PM2_JLIST_FIXTURE="$WORK/pm2-online-fresh.json"   # startup grace → exit 3
unset CC_REFUSAL_RECEIPT
bash "$REPO_ROOT/scripts/watchdog-cc.sh" >/dev/null 2>"$WORK/wd8.err"; CODE8=$?
ALERTS=$(grep -c '"watchdog_alert":true' "$WORK/watchdog-alerts.log" 2>/dev/null); ALERTS=${ALERTS:-0}; ALERTS=$(echo "$ALERTS" | tail -1)
if [[ "$CODE8" == "0" ]]; then ok "B4: exit 3 propagates as 0 (no failure)"; else bad "B4: expected exit 0, got $CODE8"; fi
if [[ "$ALERTS" == "0" ]]; then ok "B4: no alert on UNKNOWN"; else bad "B4: alert fired on UNKNOWN"; fi
grep -q 'not alerting' "$WORK/wd8.err" && ok "B4: no-action contract message present" || bad "B4: contract message missing"

# ── C: install templates ─────────────────────────────────────────────────────
echo "[C1] fresh templates carry the exact exit policy"
for T in mac-mini-bootstrap.sh vps-docker-bootstrap.sh; do
  if grep -q 'stop_exit_codes: \[78\],' "$REPO_ROOT/scripts/install/$T"; then
    ok "C1: $T fresh template carries stop_exit_codes: [78]"
  else
    bad "C1: $T missing stop_exit_codes: [78]"
  fi
done
if grep -q 'Change 78 only together with scripts/cc-start.sh' "$REPO_ROOT/scripts/install/mac-mini-bootstrap.sh" && grep -q 'Change 78 only together with scripts/cc-start.sh' "$REPO_ROOT/scripts/install/vps-docker-bootstrap.sh"; then
  ok "C1: both templates document the coupled-change exit policy"
else
  bad "C1: exit policy documentation missing"
fi

echo "[C2] upgrade reconciliation detects a pre-PRES-045 ecosystem and rewrites it"
# Execute ONLY the reconciliation block of the Mac template against a fixture
# ecosystem that lacks stop_exit_codes (extracted via a subshell harness — the
# template's earlier steps are install actions and are not run here).
make_eco_fixture() {  # $1 path, $2 stop_exit_codes present (0/1)
  mkdir -p "$(dirname "$1")"
  if [[ "$2" == "1" ]]; then
    cat > "$1" <<'EOF'
module.exports = {
  apps: [{
    name: "blackceo-command-center",
    cwd: "/x",
    script: "bash",
    args: "scripts/cc-start.sh --port 4000",
    env: { CC_PORT: "4000", NODE_ENV: "production", DATABASE_PATH: "/x/mission-control.db", CUSTOM_UNRELATED: "keep-me" },
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    min_uptime: 30000,
    max_restarts: 8,
    exp_backoff_restart_delay: 2000,
    stop_exit_codes: [78],
    kill_timeout: 10000,
    watch: false,
    max_memory_restart: "512M"
  }]
};
EOF
  else
    cat > "$1" <<'EOF'
module.exports = {
  apps: [{
    name: "blackceo-command-center",
    cwd: "/x",
    script: "bash",
    args: "scripts/cc-start.sh --port 4000",
    env: { CC_PORT: "4000", NODE_ENV: "production", DATABASE_PATH: "/x/mission-control.db", CUSTOM_UNRELATED: "keep-me" },
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    min_uptime: 30000,
    max_restarts: 8,
    exp_backoff_restart_delay: 2000,
    kill_timeout: 10000,
    watch: false,
    max_memory_restart: "512M"
  }]
};
EOF
  fi
}

# Drive the template's own reconciliation logic by sourcing only Step 8b.
# (The template is idempotent and steps 1-7/9 are guarded installs; running the
# whole template on this operator box is FORBIDDEN, so we extract the
# CANONICAL_ECOSYSTEM template assignment + reconciliation predicates verbatim.)
# The generated harness: template's CANONICAL_ECOSYSTEM line (single quoted
# assignment, copied verbatim) + a faithful copy of the template's own
# fresh/reconcile predicate block, with the reconciliation verdict echoed.
{
  echo 'set -uo pipefail'
  echo "ECOSYSTEM_DIR=\"$WORK/upg/projects/command-center\""
  echo 'ECOSYSTEM_FILE="$ECOSYSTEM_DIR/ecosystem.config.cjs"'
  echo 'mkdir -p "$ECOSYSTEM_DIR"'
  # Verbatim CANONICAL_ECOSYSTEM assignment from the template (single line,
  # ends at the closing `";"` on its own line).
  sed -n '/^CANONICAL_ECOSYSTEM="/,/^};"/p' "$REPO_ROOT/scripts/install/mac-mini-bootstrap.sh"
  cat <<'STUB2'

if [ ! -f "$ECOSYSTEM_FILE" ]; then
  printf '%s\n' "$CANONICAL_ECOSYSTEM" > "$ECOSYSTEM_FILE"
  echo "FRESH-WRITE"
else
  NEEDS_UPDATE=0
  grep -q '"blackceo-command-center"' "$ECOSYSTEM_FILE" || NEEDS_UPDATE=1
  grep -q 'cc-start.sh' "$ECOSYSTEM_FILE" || NEEDS_UPDATE=1
  grep -q 'min_uptime' "$ECOSYSTEM_FILE" || NEEDS_UPDATE=1
  grep -q 'CC_PORT' "$ECOSYSTEM_FILE" || NEEDS_UPDATE=1
  grep -q 'stop_exit_codes' "$ECOSYSTEM_FILE" || NEEDS_UPDATE=1
  grep -q 'stop_exit_codes: \[78\]' "$ECOSYSTEM_FILE" || NEEDS_UPDATE=1
  if [ "$NEEDS_UPDATE" -eq 1 ]; then
    cp "$ECOSYSTEM_FILE" "${ECOSYSTEM_FILE}.bak"
    printf '%s\n' "$CANONICAL_ECOSYSTEM" > "$ECOSYSTEM_FILE"
    echo "RECONCILED"
  else
    echo "ALREADY-CANONICAL"
  fi
fi
STUB2
} > "$WORK/run-mac-8b.sh"
# C2a: legacy file (no stop_exit_codes) → NEEDS_UPDATE → rewritten, backup made
FIX="$WORK/upg/projects/command-center/ecosystem.config.cjs"
make_eco_fixture "$FIX" 0
bash "$WORK/run-mac-8b.sh" > "$WORK/mac8b.out" 2>&1
if grep -q 'RECONCILED' "$WORK/mac8b.out"; then ok "C2a: legacy ecosystem detected for reconciliation"; else bad "C2a: legacy file not detected (got: $(cat "$WORK/mac8b.out"))"; fi
grep -q 'stop_exit_codes: \[78\]' "$FIX" && ok "C2a: reconciled file now carries the exit policy" || bad "C2a: reconciled file missing policy"
[[ -f "$FIX.bak" ]] && ok "C2a: backup .bak created before overwrite" || bad "C2a: backup missing"

# C2b: already-canonical file → no churn
make_eco_fixture "$FIX" 1
rm -f "$FIX.bak"
bash "$WORK/run-mac-8b.sh" > "$WORK/mac8b-2.out" 2>&1
if grep -q 'ALREADY-CANONICAL' "$WORK/mac8b-2.out"; then ok "C2b: canonical file left alone (no churn)"; else bad "C2b: canonical file churned (got: $(cat "$WORK/mac8b-2.out"))"; fi
[[ ! -f "$FIX.bak" ]] && ok "C2b: no backup sidecar left behind" || bad "C2b: stray .bak created"

echo
echo "════════════════════════════════════════════"
printf 'pres-045-refusal-protection: %s ok, %s FAIL\n' "$PASS" "$FAIL"
[[ "$FAIL" == "0" ]] || exit 1
exit 0