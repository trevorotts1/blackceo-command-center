#!/usr/bin/env bash
# NEXT_DIST_DIR must always be RELATIVE in the scripts that export it for the
# runtime. next.config.mjs does path.join(<project dir>, distDir); an absolute
# value is concatenated, not replaced, and `next start` then cannot find the
# build. Measured 2026-09-18 on the operator Mac (71 restarts, app down).
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }
for f in scripts/cc-start.sh scripts/atomic-deploy.sh; do
  if grep -nE 'export NEXT_DIST_DIR="\$\{?(CC_DIR|APP_DIR)\}?/' "$f" >/dev/null; then
    bad "$f exports an ABSOLUTE NEXT_DIST_DIR"
  else
    ok "$f does not export an absolute NEXT_DIST_DIR"
  fi
  if grep -nE '^\s*export NEXT_DIST_DIR="\.next"' "$f" >/dev/null; then
    ok "$f pins NEXT_DIST_DIR to the relative .next"
  else
    bad "$f does not pin NEXT_DIST_DIR=\".next\""
  fi
done
# Control: the pattern must actually detect the defect.
if printf 'export NEXT_DIST_DIR="${CC_DIR}/.next"\n' | grep -qE 'export NEXT_DIST_DIR="\$\{?(CC_DIR|APP_DIR)\}?/'; then ok "control: the absolute pattern is detected"; else bad "control: the absolute pattern is NOT detected"; fi
printf '[next-dist-dir-relative] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
