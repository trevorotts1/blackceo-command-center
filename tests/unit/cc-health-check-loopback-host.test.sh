#!/usr/bin/env bash
# v7.6.81: a box with a tenant registry (written once its tunnel exists) does not
# treat a loopback Host as self, so the outside-in probe of
# http://127.0.0.1:4000/interview got 403 unregistered_hostname: RED, and every
# deploy rolled back. The probe now connects to loopback but asks for the box's
# public host (CC_PUBLIC_URL / MC_TENANT_PUBLIC_URL in the app's .env.local).
# Drives the real script with curl shadowed by a fake that answers like the
# middleware: the page is served only for the registered host.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cc-health-loopback-host.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/app/scripts" "$WORK/bin"
cp scripts/cc-health-check.sh "$WORK/app/scripts/cc-health-check.sh"

cat > "$WORK/bin/curl" <<'FAKECURL'
#!/usr/bin/env bash
args=("$@"); url="${args[$((${#args[@]}-1))]}"; host=""; wval=""; head=0; out=0
for i in "${!args[@]}"; do
  case "${args[$i]}" in
    -H) h="${args[$((i+1))]}"; [[ "$h" == Host:* ]] && host="${h#Host: }" ;;
    -w) wval="${args[$((i+1))]}" ;;
    -o) out=1 ;;
    -I) head=1 ;;
  esac
done
printf '%s|%s\n' "$url" "$host" >> "$FAKE_LOG"
case "$url" in
  */api/health/deep) printf '%s\n{"_http_code":200}' "$FAKE_DEEP_BODY"; exit 0 ;;
  */_next/static/*)
    if [[ $head -eq 1 ]]; then printf 'HTTP/1.1 200 OK\r\nContent-Type: application/javascript\r\n\r\n'; else printf '200'; fi; exit 0 ;;
esac
# A page: the middleware serves it only for a registered host.
if [[ "$host" == "$FAKE_REGISTERED_HOST" ]]; then code=200; body='<html><script src="/_next/static/chunks/main-abc.js"></script></html>'
else code=403; body='{"error":"unregistered_hostname","message":"x"}'; fi
if [[ $out -eq 1 ]]; then
  if [[ "$wval" == *redirect_url* ]]; then printf '%s ' "$code"; else printf '%s' "$code"; fi
else printf '%s' "$body"; fi
FAKECURL
chmod +x "$WORK/bin/curl"

DEEP='{"pass":true,"indeterminate":false,"timestamp":"x","checks":{"asset_manifest":{"pass":true,"detail":"ok"}},"advisory":{}}'
run() {  # $1 = script path; remaining = flags
  : > "$WORK/log"
  env -u CC_PUBLIC_URL PATH="$WORK/bin:$PATH" FAKE_LOG="$WORK/log" FAKE_DEEP_BODY="$DEEP" \
    FAKE_REGISTERED_HOST=box.example.com timeout 20 bash "$@" --json-only --skip-pm2 >/dev/null 2>&1
}
S="$WORK/app/scripts/cc-health-check.sh"

# 1. Registry + MC_TENANT_PUBLIC_URL in .env.local (the installer's tunnel write): GREEN.
printf 'MC_TENANT_REGISTRY_JSON={"box.example.com":{"tenantId":"self"}}\nMC_TENANT_PUBLIC_URL="https://Box.example.com/"\n' > "$WORK/app/.env.local"
run "$S"; e=$?
[[ "$e" == 0 ]] && ok "loopback probe with a one-host registry passes (exit 0)" || bad "loopback probe with a one-host registry: expected exit 0, got $e"
grep -q '^http://127.0.0.1:4000/interview|box.example.com$\|^http://127.0.0.1:4000/|box.example.com$' "$WORK/log" \
  && ok "the probe connects to 127.0.0.1 and asks for the registered host" || bad "probe did not send Host: box.example.com to 127.0.0.1"
! grep -q '^https\?://box.example.com' "$WORK/log" && ok "the page probe never leaves the box" || bad "the page probe fetched the public URL"

# 2. The same with CC_PUBLIC_URL, via --canonical-dir (the app dir, not the script's parent).
mkdir -p "$WORK/other"; printf 'CC_PUBLIC_URL=https://box.example.com\n' > "$WORK/other/.env.local"; rm -f "$WORK/app/.env.local"
run "$S" --canonical-dir "$WORK/other"; e=$?
[[ "$e" == 0 ]] && ok "CC_PUBLIC_URL from --canonical-dir's .env.local is used (exit 0)" || bad "--canonical-dir .env.local: expected exit 0, got $e"

# 3. No public URL anywhere: loopback Host, the wall is still RED.
run "$S"; e=$?
[[ "$e" == 1 ]] && ok "no public URL: a 403 unregistered_hostname is still RED" || bad "no public URL: expected exit 1, got $e"

# 4. A public URL whose host is not registered: RED (a browser there is refused too).
printf 'MC_TENANT_PUBLIC_URL=https://other.example.com\n' > "$WORK/app/.env.local"
run "$S"; e=$?
[[ "$e" == 1 ]] && ok "an unregistered public host is still RED" || bad "unregistered public host: expected exit 1, got $e"

# Control: the pre-fix script reads RED on the case-1 box.
printf 'MC_TENANT_PUBLIC_URL=https://box.example.com\n' > "$WORK/app/.env.local"
if git show v7.6.80:scripts/cc-health-check.sh > "$WORK/app/scripts/old.sh" 2>/dev/null; then
  run "$WORK/app/scripts/old.sh"; e=$?
  [[ "$e" == 1 ]] && ok "control: the v7.6.80 script is RED on the same box" || bad "control: v7.6.80 script expected exit 1, got $e"
fi

printf '[cc-health-check-loopback-host] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
