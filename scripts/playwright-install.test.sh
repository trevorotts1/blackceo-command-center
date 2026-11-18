#!/usr/bin/env bash
# Proves .github/scripts/playwright-install.sh retries ONLY the install, gives up
# after the attempt limit, and fails loudly. Fake npx; no network.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
S="$ROOT/.github/scripts/playwright-install.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
mkdir -p "$W/bin"
cat > "$W/bin/npx" <<'F'
#!/bin/sh
echo "$@" >> "$FAKE_LOG"
n=$(wc -l < "$FAKE_LOG")
[ "$n" -le "${FAIL_FIRST:-0}" ] && exit 1
exit 0
F
chmod +x "$W/bin/npx"
run() { env PATH="$W/bin:$PATH" FAKE_LOG="$W/log" PW_INSTALL_ATTEMPTS=3 PW_RETRY_SLEEP=0 "$@" bash "$S" chromium webkit >"$W/out" 2>&1; }

: > "$W/log"; FAIL_FIRST=0 run; rc=$?
[ $rc -eq 0 ] && [ "$(wc -l < "$W/log")" -eq 2 ] && ok "healthy run: install-deps then install, once each" || bad "healthy run rc=$rc calls=$(wc -l < "$W/log")"
grep -q 'install-deps chromium webkit' "$W/log" && grep -q '^playwright install chromium webkit' "$W/log" && ok "both browsers passed through" || bad "arguments lost"

: > "$W/log"; FAIL_FIRST=2 run; rc=$?
[ $rc -eq 0 ] && ok "recovers after two failed install attempts" || bad "did not recover (rc $rc)"

: > "$W/log"; FAIL_FIRST=99 run; rc=$?
[ $rc -ne 0 ] && [ "$(wc -l < "$W/log")" -eq 3 ] && ok "gives up after 3 attempts and fails" || bad "limit not enforced rc=$rc calls=$(wc -l < "$W/log")"

if grep -q 'playwright test\|vitest\|--retries' "$S"; then bad "installer touches tests"; else ok "installer never retries or alters tests"; fi
echo "playwright-install: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
