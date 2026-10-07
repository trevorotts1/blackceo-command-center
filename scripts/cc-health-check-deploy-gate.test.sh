#!/usr/bin/env bash
# Tests for cc-health-check.sh's exit-3 verdict logic (U51 fix).
#
# REGRESSION GUARD, two independent defects:
#   1. The script used to exit 3 the INSTANT /api/health/deep reported ANY
#      gating check as indeterminate (e.g. html_title finding no
#      pre-rendered HTML — routine on a middleware-gated root route) —
#      BEFORE the pm2 topology, outside-in asset probe, or CF public-URL
#      probe below ever ran. A fully healthy box therefore reported exit 3
#      forever, identically to a genuinely dead box, and the emitted JSON
#      never carried pm2_topology/outside_in_asset/cf_probe.
#   2. Checking "any indeterminate" before "any hard fail" meant a GENUINE
#      gating failure (e.g. company_branding pass:false, indeterminate:
#      false) was silently downgraded to UNKNOWN whenever a DIFFERENT
#      gating check (e.g. html_title) was merely indeterminate.
#
# This test drives the real script end-to-end with curl shadowed by a fake
# binary on PATH (no network, no live box) so both scenarios are exercised
# deterministically.
#
# Run:  bash scripts/cc-health-check-exit3.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cc-health-deploy-gate-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

cp "$SCRIPT_DIR/cc-health-check.sh" "$WORK/cc-health-check.sh"
chmod +x "$WORK/cc-health-check.sh"
# pm2-analyze-cc.py is only invoked when --skip-pm2 is absent; every scenario
# below passes --skip-pm2, so it does not need to exist in $WORK.

# Fake curl: distinguishes cc-health-check.sh's call shapes by flags present.
cat > "$WORK/bin/curl" <<'FAKECURL'
#!/usr/bin/env bash
args=("$@")
has_flag() { local f; for f in "${args[@]}"; do [[ "$f" == "$1" ]] && return 0; done; return 1; }
wval=""
for i in "${!args[@]}"; do
  if [[ "${args[$i]}" == "-w" ]]; then wval="${args[$((i+1))]}"; fi
done
if has_flag "--write-out"; then
  printf '%s' "$FAKE_DEEP_BODY"
  printf '\n{"_http_code":200}'
elif has_flag "-I"; then
  printf 'HTTP/1.1 200 OK\r\nContent-Type: application/javascript\r\n\r\n'
elif has_flag "-o" && [[ -n "$wval" ]]; then
  if [[ "$wval" == *redirect_url* ]]; then printf '200 '; else printf '200'; fi
else
  printf '%s' "$FAKE_ROOT_HTML"
fi
FAKECURL
chmod +x "$WORK/bin/curl"

FAKE_ROOT_HTML='<html><head><title>Real Brand</title></head><body><script src="/_next/static/chunks/main-abc123.js"></script></body></html>'

deep_body() {
  # $1 = 'healthy' (only html_title indeterminate) | 'hardfail' (company_branding
  # genuine hard fail, html_title ALSO indeterminate — proves no masking)
  python3 -c "
import json
checks = {
  'asset_manifest':   {'pass': True, 'detail': 'ok'},
  'company_branding': {'pass': $([[ "$1" == "hardfail" ]] && echo False || echo True), 'indeterminate': False, 'detail': 'x'},
  'html_title':       {'pass': False, 'indeterminate': True, 'detail': 'no pre-rendered HTML — indeterminate'},
  'database_path':    {'pass': True, 'detail': 'ok'},
  'migrations':       {'pass': True, 'detail': 'ok'},
  'disk_headroom':    {'pass': True, 'detail': 'ok'},
  'next_public_app_url': {'pass': True, 'detail': 'ok'},
}
print(json.dumps({'pass': False, 'indeterminate': True, 'timestamp': 'x', 'checks': checks, 'advisory': {}}))
"
}

deep_rows() {
  # $1 = the row that fails (pass:false, indeterminate:false)
  python3 -c "
import json, sys
rows = ['asset_manifest','build_content','company_branding','html_title','database_path','migrations','disk_headroom','next_public_app_url','scheduler_liveness']
checks = {r: {'pass': r != sys.argv[1], 'indeterminate': False, 'detail': 'x'} for r in rows}
print(json.dumps({'pass': False, 'indeterminate': False, 'timestamp': 'x', 'checks': checks, 'advisory': {}}))
" "$1"
}
run_gate() {
  (cd "$WORK" && env PATH="$WORK/bin:$PATH" FAKE_DEEP_BODY="$1" FAKE_ROOT_HTML="$FAKE_ROOT_HTML" \
    timeout 15 bash ./cc-health-check.sh --json-only --skip-pm2 "${@:2}")
}

# An unbuilt box (interview never run): company_branding is RED. That is a
# content/config fact, not a broken build — a deploy must not roll back over it.
for row in company_branding html_title disk_headroom next_public_app_url; do
  run_gate "$(deep_rows "$row")" >/dev/null; e=$?
  [[ "$e" == "1" ]] && ok "no --deploy-gate: $row fail is RED (heartbeat/watchdog unchanged)" || bad "no --deploy-gate: $row expected exit 1, got $e"
  OUT="$(run_gate "$(deep_rows "$row")" --deploy-gate)"; e=$?
  [[ "$e" == "0" ]] && ok "--deploy-gate: $row fail is a warning, deploy stays green" || bad "--deploy-gate: $row expected exit 0, got $e"
  printf '%s' "$OUT" | python3 -c "import sys,json; sys.exit(0 if '$row' in json.load(sys.stdin).get('deploy_warnings',{}) else 1)" \
    && ok "--deploy-gate: $row reported under deploy_warnings" || bad "--deploy-gate: $row missing from deploy_warnings"
done
# Build/serve rows still gate the deploy.
for row in asset_manifest build_content database_path migrations scheduler_liveness; do
  run_gate "$(deep_rows "$row")" --deploy-gate >/dev/null; e=$?
  [[ "$e" == "1" ]] && ok "--deploy-gate: $row fail still RED" || bad "--deploy-gate: $row expected exit 1, got $e"
done

# ── pm2 reading that cannot be taken is INDETERMINATE (exit 3), never RED ──────
# Incident: mid pm2-switch the analyzer failed -> app_count 0 -> exit 1 -> a good
# release was rolled back. Real pm2 failures (errored app) must stay exit 1.
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
cp "$SCRIPT_DIR/pm2-analyze-cc.py" "$WORK/"; mkdir -p "$WORK/lib"; cp "$SCRIPT_DIR/lib/pm2_json.py" "$WORK/lib/"
cat > "$WORK/bin/pm2" <<'FAKEPM2'
#!/usr/bin/env bash
# FAKE_PM2_MODE: fail -> nonzero exit; file -> cat $FAKE_PM2_FILE; garbage -> not JSON
case "$FAKE_PM2_MODE" in
  fail)    echo "daemon not ready" >&2; exit 1 ;;
  garbage) echo "<<not json>>"; exit 0 ;;
  file)    cat "$FAKE_PM2_FILE" ;;
esac
FAKEPM2
chmod +x "$WORK/bin/pm2"
GREEN_DEEP="$(deep_rows none)"
run_pm2() {  # $1 mode  $2 fixture file (optional)  $3 deep body (optional)
  (cd "$WORK" && env PATH="$WORK/bin:$PATH" FAKE_DEEP_BODY="${3:-$GREEN_DEEP}" FAKE_ROOT_HTML="$FAKE_ROOT_HTML" \
    FAKE_PM2_MODE="$1" FAKE_PM2_FILE="${2:-}" timeout 30 bash ./cc-health-check.sh --json-only --deploy-gate)
}
FIX="$REPO/tests/fixtures/pm2-stubs"
OUT="$(run_pm2 file "$FIX/fixture-2e-healthy.json")"; e=$?
[[ "$e" == "0" ]] && ok "pm2 healthy fixture -> exit 0" || bad "pm2 healthy fixture expected 0, got $e"
OUT="$(run_pm2 fail)"; e=$?
[[ "$e" == "3" ]] && ok "pm2 list failing -> exit 3 (indeterminate)" || bad "pm2 list failing expected 3, got $e"
printf '%s' "$OUT" | grep -q 'daemon not ready' && ok "pm2 failure detail carries the cause" || bad "pm2 failure detail missing"
OUT="$(run_pm2 garbage)"; e=$?
[[ "$e" == "3" ]] && ok "unparseable pm2 output (analyzer error) -> exit 3" || bad "unparseable pm2 output expected 3, got $e"
mv "$WORK/pm2-analyze-cc.py" "$WORK/pm2-analyze-cc.py.off"
OUT="$(run_pm2 file "$FIX/fixture-2e-healthy.json")"; e=$?
[[ "$e" == "3" ]] && ok "analyzer crash (script unrunnable) -> exit 3, not 1" || bad "analyzer crash expected 3, got $e"
printf '%s' "$OUT" | grep -q 'pm2-analyze-cc.py failed' && ok "analyzer rc/stderr captured in JSON detail" || bad "analyzer failure detail missing"
mv "$WORK/pm2-analyze-cc.py.off" "$WORK/pm2-analyze-cc.py"
run_pm2 file "$FIX/fixture-2f-errored.json" >/dev/null; e=$?
[[ "$e" == "1" ]] && ok "genuinely errored app still RED (exit 1)" || bad "errored app expected 1, got $e"
run_pm2 file "$FIX/fixture-duplicate-cc.json" >/dev/null; e=$?
[[ "$e" == "1" ]] && ok "zombie duplicate still RED (exit 1)" || bad "duplicate expected 1, got $e"
run_pm2 file "$FIX/fixture-empty.json" >/dev/null; e=$?
[[ "$e" == "1" ]] && ok "valid pm2 list with no CC app still RED (exit 1)" || bad "empty list expected 1, got $e"
# A definitive RED elsewhere is never softened by an indeterminate pm2 reading.
run_pm2 fail "" "$(deep_rows asset_manifest)" >/dev/null; e=$?
[[ "$e" == "1" ]] && ok "asset_manifest RED + pm2 indeterminate -> still exit 1" || bad "RED + indeterminate expected 1, got $e"

# atomic-deploy: exit 3 is a retry, exit 1 is the only rollback trigger.
AD="$SCRIPT_DIR/atomic-deploy.sh"
awk '/HEALTH_EXIT -eq 3 \]\]; then/{f=1} f&&/Retrying in/{r=1} END{exit !r}' "$AD" && ok "atomic-deploy: exit 3 path retries" || bad "atomic-deploy exit-3 retry path missing"
grep -q 'CC_POST_SWITCH_WAIT' "$AD" && ! grep -qx '  sleep 5' "$AD" && ok "atomic-deploy: bounded readiness poll replaces flat sleep 5" || bad "atomic-deploy readiness poll missing"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
