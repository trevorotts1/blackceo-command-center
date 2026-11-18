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
cat > "$W/bin/node" <<'F'
#!/bin/sh
# fake launch probe: PROBE_OK=1 -> browsers launch, otherwise they do not
echo probe >> "$FAKE_PROBE"; [ "${PROBE_OK:-0}" = "1" ]
F
chmod +x "$W/bin/node"
run() { env PATH="$W/bin:$PATH" FAKE_LOG="$W/log" FAKE_PROBE="$W/probe" PW_INSTALL_ATTEMPTS=3 PW_DEPS_ATTEMPTS=5 PW_RETRY_SLEEP=0 "$@" bash "$S" chromium webkit >"$W/out" 2>&1; }

: > "$W/log"; FAIL_FIRST=0 PROBE_OK=1 run; rc=$?
[ $rc -eq 0 ] && [ "$(wc -l < "$W/log")" -eq 1 ] && grep -q '^playwright install chromium webkit' "$W/log" && ok "browsers launch: only the browser install runs, apt (install-deps) skipped" || bad "launching run rc=$rc log=$(cat "$W/log")"

: > "$W/log"; FAIL_FIRST=0 PROBE_OK=0 run; rc=$?
[ $rc -eq 0 ] && grep -q 'install-deps chromium webkit' "$W/log" && ok "browsers do not launch: install-deps runs" || bad "install-deps not run when launch fails"

: > "$W/log"; FAIL_FIRST=2 PROBE_OK=1 run; rc=$?
[ $rc -eq 0 ] && ok "recovers after two failed browser-install attempts" || bad "did not recover (rc $rc)"

: > "$W/log"; FAIL_FIRST=99 PROBE_OK=1 run; rc=$?
[ $rc -ne 0 ] && [ "$(wc -l < "$W/log")" -eq 3 ] && ok "gives up after 3 attempts and fails" || bad "limit not enforced rc=$rc calls=$(wc -l < "$W/log")"

: > "$W/log"; FAIL_FIRST=4 PROBE_OK=0 run; rc=$?
[ $rc -ne 0 ] || bad "browser install failures should have consumed attempts first"
: > "$W/log"; FAIL_FIRST=1 PROBE_OK=0 run; rc=$?
[ $rc -eq 0 ] && ok "install-deps path also retries (fake npx fails once more)" || bad "install-deps retry rc=$rc"

if grep -q 'playwright test\|vitest\|--retries' "$S"; then bad "installer touches tests"; else ok "installer never retries or alters tests"; fi
echo "playwright-install: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
