#!/usr/bin/env bash
# Phase 5 hooks (pm2 save, pm2-logrotate install, watchdog install) must run
# from the live app directory, not from the deleted candidate directory.
# Measured 2026-09-18 on every box: pm2 save "ENOENT: process.cwd failed".
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }
F=scripts/atomic-deploy.sh
rel=$(grep -n '^cd "\$RELEASE_DIR" || exit 2' "$F" | cut -d: -f1)
p5=$(grep -n '^_banner "Phase 5 — Verdict"' "$F" | cut -d: -f1)
back=$(awk -v s="$p5" 'NR>s && /^cd "\$APP_DIR" \|\| _warn/{print NR; exit}' "$F")
save=$(awk -v s="$p5" 'NR>s && /pm2 save 2>&1/{print NR; exit}' "$F")
[[ -n "$rel" ]] && ok "the deploy does enter the candidate directory (line $rel)" || bad "cd RELEASE_DIR not found"
[[ -n "$back" ]] && ok "Phase 5 returns to APP_DIR (line $back)" || bad "no cd APP_DIR after the Phase 5 banner"
[[ -n "$back" && -n "$save" && "$back" -lt "$save" ]] && ok "the return happens before pm2 save (line $save)" || bad "pm2 save runs before returning to APP_DIR (back=$back save=$save)"
# control: the awk window must not match before the banner
pre=$(awk -v s="$p5" 'NR<s && /^cd "\$APP_DIR" \|\| _warn/{print NR; exit}' "$F"); [[ -z "$pre" ]] && ok "control: the return line exists only after the banner" || bad "control: unexpected early match at $pre"
printf '[atomic-deploy-phase5-cwd] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
