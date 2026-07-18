#!/usr/bin/env bash
# Tests for cc-health-check.sh's CF public-URL probe (U51 regression fix).
#
# REGRESSION GUARD: Cloudflare Access, once enabled on a box, 302-redirects
# every unauthenticated request to its own off-origin login page:
#   https://<team>.cloudflareaccess.com/cdn-cgi/access/login/<app-host>?...
# The pre-fix script scored that identically to a dead origin (row 26 FAIL) —
# a real, correct security improvement (Access turning on) was indistinguishable
# from a genuine outage. This drives the real script end-to-end with curl
# shadowed by a fake binary on PATH (no network, no live box) across three
# scenarios so the fix is proven WITHOUT proving it swallows real failures.
#
# Run:  bash scripts/cc-health-check-cfaccess.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cc-health-cfaccess-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

cp "$SCRIPT_DIR/cc-health-check.sh" "$WORK/cc-health-check.sh"
chmod +x "$WORK/cc-health-check.sh"

FAKE_ROOT_HTML='<html><head><title>Real Brand</title></head><body><script src="/_next/static/chunks/main-abc123.js"></script></body></html>'

# Fake curl: distinguishes cc-health-check.sh's call shapes by flags AND, for
# the two "-w ... -o ..." shapes (outside-in root/asset probe vs CF public-URL
# probe), by whether the target URL is the CF public URL (env CC_PUBLIC_URL)
# so each gets its own configurable response.
cat > "$WORK/bin/curl" <<'FAKECURL'
#!/usr/bin/env bash
args=("$@")
has_flag() { local f; for f in "${args[@]}"; do [[ "$f" == "$1" ]] && return 0; done; return 1; }
wval=""
for i in "${!args[@]}"; do
  if [[ "${args[$i]}" == "-w" ]]; then wval="${args[$((i+1))]}"; fi
done
last="${args[$((${#args[@]}-1))]}"

if has_flag "--write-out"; then
  printf '%s' "$FAKE_DEEP_BODY"
  printf '\n{"_http_code":200}'
elif has_flag "-I"; then
  printf 'HTTP/1.1 200 OK\r\nContent-Type: application/javascript\r\n\r\n'
elif has_flag "-o" && [[ -n "$wval" ]]; then
  if [[ -n "${CC_PUBLIC_URL:-}" && "$last" == "$CC_PUBLIC_URL" ]]; then
    # CF public-URL probe call.
    if [[ "$wval" == *redirect_url* ]]; then
      printf '%s %s' "${FAKE_CF_HTTP_CODE:-200}" "${FAKE_CF_REDIRECT:-}"
    else
      printf '%s' "${FAKE_CF_HTTP_CODE:-200}"
    fi
  else
    # Outside-in root/asset probe call — always a healthy 200, no redirect.
    if [[ "$wval" == *redirect_url* ]]; then printf '200 '; else printf '200'; fi
  fi
else
  printf '%s' "$FAKE_ROOT_HTML"
fi
FAKECURL
chmod +x "$WORK/bin/curl"

deep_body_healthy() {
  python3 -c "
import json
checks = {
  'asset_manifest':      {'pass': True, 'detail': 'ok'},
  'company_branding':    {'pass': True, 'indeterminate': False, 'detail': 'ok'},
  'database_path':       {'pass': True, 'detail': 'ok'},
  'migrations':          {'pass': True, 'detail': 'ok'},
  'disk_headroom':       {'pass': True, 'detail': 'ok'},
  'next_public_app_url': {'pass': True, 'detail': 'ok'},
}
print(json.dumps({'pass': True, 'indeterminate': False, 'timestamp': 'x', 'checks': checks, 'advisory': {}}))
"
}

run_it() {
  # $1 = FAKE_CF_HTTP_CODE, $2 = FAKE_CF_REDIRECT
  (cd "$WORK" && env PATH="$WORK/bin:$PATH" FAKE_DEEP_BODY="$(deep_body_healthy)" \
    FAKE_ROOT_HTML="$FAKE_ROOT_HTML" \
    FAKE_CF_HTTP_CODE="$1" FAKE_CF_REDIRECT="$2" \
    CC_PUBLIC_URL="http://fake-public.test" \
    timeout 15 bash ./cc-health-check.sh --json-only --skip-pm2)
}

# ── scenario 1: genuine Cloudflare Access login-challenge redirect → PASS ───
OUT1="$(run_it "302" "https://myteam.cloudflareaccess.com/cdn-cgi/access/login/fake-public.test?kid=abc")"
EXIT1=$?
[[ "$EXIT1" == "0" ]] && ok "CF Access login redirect: exit 0 (green), not scored as an outage" \
  || bad "CF Access login redirect: expected exit 0, got $EXIT1"
if printf '%s' "$OUT1" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('cf_probe',{}).get('pass') is True else 1)"; then
  ok "CF Access login redirect: cf_probe.pass=true"
else
  bad "CF Access login redirect: cf_probe.pass is not true — fix not applied or broken"
fi

# ── scenario 2 (REGRESSION GUARD): off-origin 3xx to an UNRELATED host ─────
# must still FAIL — proves the fix did not broaden to "any off-origin 3xx".
OUT2="$(run_it "302" "https://totally-unrelated-host.example.com/somewhere")"
EXIT2=$?
[[ "$EXIT2" == "1" ]] && ok "unrelated off-origin redirect: still exit 1 (RED) — not swallowed by the fix" \
  || bad "unrelated off-origin redirect: expected exit 1, got $EXIT2 — fix over-broadened the check"
if printf '%s' "$OUT2" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('cf_probe',{}).get('pass') is False else 1)"; then
  ok "unrelated off-origin redirect: cf_probe.pass=false"
else
  bad "unrelated off-origin redirect: cf_probe.pass is not false — over-broadened"
fi

# ── scenario 3 (REGRESSION GUARD): genuinely unreachable public URL ────────
# curl returns 000 (network error) — must stay UNKNOWN (exit 3), never PASS.
OUT3="$(run_it "000" "")"
EXIT3=$?
[[ "$EXIT3" == "3" ]] && ok "genuinely unreachable public URL: exit 3 (UNKNOWN), never a false PASS" \
  || bad "genuinely unreachable public URL: expected exit 3, got $EXIT3"
if printf '%s' "$OUT3" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('cf_probe',{}).get('indeterminate') is True and d.get('cf_probe',{}).get('pass') is False else 1)"; then
  ok "genuinely unreachable public URL: cf_probe reports indeterminate, pass=false"
else
  bad "genuinely unreachable public URL: cf_probe verdict wrong"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
