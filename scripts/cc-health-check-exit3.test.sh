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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cc-health-exit3-test.XXXXXX")"
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

run_it() {
  (cd "$WORK" && env PATH="$WORK/bin:$PATH" FAKE_DEEP_BODY="$1" FAKE_ROOT_HTML="$FAKE_ROOT_HTML" \
    CC_PUBLIC_URL="http://fake-public.test" \
    timeout 15 bash ./cc-health-check.sh --json-only --skip-pm2)
}

# ── scenario 1: healthy baseline, only html_title indeterminate ────────────
OUT1="$(run_it "$(deep_body healthy)")"
EXIT1=$?
# Still exit 3: html_title's own indeterminate is genuinely unresolvable here
# (no other probe in this script verifies page-title content) — that is
# honest UNKNOWN, not the masking bug. The fix under test is that the script
# no longer short-circuits BEFORE running pm2/outside-in/CF (asserted below),
# not that indeterminate always becomes green.
[[ "$EXIT1" == "3" ]] && ok "healthy baseline: still exit 3 (honest UNKNOWN, not a masked green)" \
  || bad "healthy baseline: expected exit 3, got $EXIT1"
if printf '%s' "$OUT1" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'pm2_topology' in d else 1)"; then
  ok "healthy baseline: pm2_topology present (probes now run instead of short-circuiting)"
else
  bad "healthy baseline: pm2_topology MISSING — still short-circuiting"
fi
if printf '%s' "$OUT1" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'outside_in_asset' in d and 'cf_probe' in d else 1)"; then
  ok "healthy baseline: outside_in_asset + cf_probe present"
else
  bad "healthy baseline: outside_in_asset / cf_probe MISSING"
fi
if printf '%s' "$OUT1" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('cc_port')==4000 and d.get('override_ack_set')==False else 1)"; then
  ok "healthy baseline: cc_port=4000, override_ack_set=false present in JSON"
else
  bad "healthy baseline: cc_port / override_ack_set missing or wrong"
fi

# ── scenario 2: genuine hard fail on company_branding, ALSO indeterminate
#    html_title — must NOT be masked as UNKNOWN
OUT2="$(run_it "$(deep_body hardfail)")"
EXIT2=$?
[[ "$EXIT2" == "1" ]] && ok "masked hard-fail scenario: exit code is 1 (RED), not 3 (UNKNOWN)" \
  || bad "masked hard-fail scenario: expected exit 1, got $EXIT2 — genuine fail is being masked"
if printf '%s' "$OUT2" | python3 -c "
import sys,json
d=json.load(sys.stdin)
cb=d.get('checks',{}).get('company_branding',{})
sys.exit(0 if cb.get('pass') is False else 1)
"; then
  ok "masked hard-fail scenario: company_branding fail still visible in checks"
else
  bad "masked hard-fail scenario: company_branding fail not visible in output"
fi
if printf '%s' "$OUT2" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('cc_port')==4000 else 1)"; then
  ok "masked hard-fail scenario: cc_port present even on the early-exit RED path"
else
  bad "masked hard-fail scenario: cc_port missing on early-exit RED path"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
