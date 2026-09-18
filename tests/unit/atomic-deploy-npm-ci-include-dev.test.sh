#!/usr/bin/env bash
# The candidate build needs dev dependencies. A container exporting
# NODE_ENV=production makes npm omit them by default (measured 2026-09-18 on a
# Contabo box: "Cannot find module 'tailwindcss'" in the candidate build).
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }
grep -qE 'npm ci [^|]*--include=dev' scripts/atomic-deploy.sh && ok "atomic-deploy runs npm ci with --include=dev" || bad "npm ci lacks --include=dev"
grep -qE 'npm ci [^|]*--ignore-scripts=false' scripts/atomic-deploy.sh && ok "install scripts still enabled for native modules" || bad "--ignore-scripts=false missing"
printf 'npm ci --no-audit\n' | grep -qE 'npm ci [^|]*--include=dev' && bad "control: pattern matched a line without the flag" || ok "control: pattern requires the flag"
printf '[atomic-deploy-npm-ci-include-dev] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
