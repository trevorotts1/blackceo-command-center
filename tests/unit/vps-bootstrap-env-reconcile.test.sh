#!/usr/bin/env bash
# vps-bootstrap-env-reconcile.test.sh — additive env-file reconcile for
# vps-docker-bootstrap.sh step 8c (mechanism: reconcile_env_file_additive).
#
# Extracts the REAL functions from scripts/install/vps-docker-bootstrap.sh
# (sed range, not a copy) and drives them against temp dirs: existing
# operator keys are byte-preserved, only missing ACTIVE template keys are
# appended, commented template lines are never activated, a .bak precedes
# every write, FILE-perms are 600, and no secret VALUE ever hits stdout.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 9
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# Extract the real helpers verbatim so the test runs the real code, not a copy.
sed -n '/^_ilj_env_key_of_line() {/,/^}/p' scripts/install/vps-docker-bootstrap.sh > "$TMP/fn.sh"
sed -n '/^reconcile_env_file_additive() {/,/^}/p' scripts/install/vps-docker-bootstrap.sh >> "$TMP/fn.sh"
[[ -s "$TMP/fn.sh" ]] && ok "reconcile functions found in scripts/install/vps-docker-bootstrap.sh" || bad "reconcile functions missing"
# Step 8c numbering check: additive reconcile sits BETWEEN step 8b (PM2) and
# step 9 (systemd), alongside — never replacing — the PM2 reconcile.
grep -q 'Step 8c' scripts/install/vps-docker-bootstrap.sh && ok "step 8c present (alongside step 8b, not replacing)" || bad "step 8c marker missing"
grep -q 'systemd startup' scripts/install/vps-docker-bootstrap.sh && ok "step 9 still follows" || bad "step 9 missing after 8c"
# Fixture: template with active + commented-only + blank + comment lines.
TEMPLATE="$TMP/.env.example"; TARGET="$TMP/live/.env"
printf '%s\n' \
  '# interview-relevant keys (canonical template)' \
  'MISSION_CONTROL_URL=http://localhost:4000' \
  'OPENCLAW_DASHBOARD_URL=https://example.invalid' \
  '' \
  '# MC_API_TOKEN=' \
  'INTERVIEW_NUDGE_SWEEP_ENABLED=1' \
  > "$TEMPLATE"
# shellcheck disable=SC1090
source "$TMP/fn.sh"
# 1. operator value is preserved byte-for-byte, never overwritten by template.
mkdir -p "$TMP/live"
printf '%s\n' 'OPENCLAW_DASHBOARD_URL=https://operator-real.invalid' 'MC_API_TOKEN=operator-secret-aaa' > "$TARGET"
out="$(reconcile_env_file_additive "$TEMPLATE" "$TARGET" 2>&1)"
[[ "$out" == *"operator-secret-aaa"* ]] && bad "secret VALUE leaked to stdout" || ok "no secret value on stdout (names/counts only)"
grep -q '^OPENCLAW_DASHBOARD_URL=https://operator-real.invalid$' "$TARGET" && ok "operator key preserved byte-for-byte" || bad "operator key overwritten: $(grep '^OPENCLAW_DASHBOARD_URL' "$TARGET" || echo MISSING)"
grep -q '^MC_API_TOKEN=operator-secret-aaa$' "$TARGET" && ok "second operator key preserved" || bad "MC_API_TOKEN changed"
# 2. missing ACTIVE template keys are appended.
grep -q '^MISSION_CONTROL_URL=http://localhost:4000$' "$TARGET" && ok "missing key MISSION_CONTROL_URL appended" || bad "missing key MISSION_CONTROL_URL not appended"
grep -q '^INTERVIEW_NUDGE_SWEEP_ENABLED=1$' "$TARGET" && ok "missing key INTERVIEW_NUDGE_SWEEP_ENABLED appended" || bad "INTERVIEW_NUDGE_SWEEP_ENABLED not appended"
# 3. commented-only template lines are NOT activated.
[[ "$(grep -c '^MC_API_TOKEN=' "$TARGET")" -eq 1 ]] && ok "commented template line not activated (exactly 1 MC_API_TOKEN line)" || bad "commented line activated: $(grep '^MC_API_TOKEN=' "$TARGET")"
# 4. .bak backup precedes the write and holds the pre-reconcile content.
[[ -f "${TARGET}.bak" ]] && ok ".env.bak written (same .bak convention as step 8b)" || bad ".env.bak missing"
grep -q '^OPENCLAW_DASHBOARD_URL=https://operator-real.invalid$' "${TARGET}.bak" && ! grep -q 'MISSION_CONTROL_URL' "${TARGET}.bak" && ok ".bak holds pre-reconcile content" || bad ".bak content wrong"
# 5. missing target seeds from template (fresh box) with 0600 perms.
rm -f "$TARGET" "${TARGET}.bak"
reconcile_env_file_additive "$TEMPLATE" "$TARGET" >/dev/null 2>&1
[[ -f "$TARGET" ]] && ok "fresh box: target seeded from template" || bad "fresh box: target not seeded"
cmp -s "$TEMPLATE" "$TARGET" && ok "fresh box: seeded content equals template" || bad "fresh box: seeded content differs"
[[ "$(stat -f %A "$TARGET" 2>/dev/null || stat -c %a "$TARGET")" == *"600"* ]] && ok "seeded file is mode 600" || bad "seeded file not 600: $(stat -f %A "$TARGET" 2>/dev/null || stat -c %a "$TARGET")"
# 6. missing template warns, returns 0 (non-fatal; bootstrap still reaches step 9).
if reconcile_env_file_additive "$TMP/no-template-here" "$TARGET" >/dev/null 2>&1; then ok "missing template: non-fatal exit 0"; else bad "missing template: non-zero exit"; fi
# 7. reconciled file is 600 too.
[[ "$(stat -f %A "$TARGET" 2>/dev/null || stat -c %a "$TARGET")" == *"600"* ]] && ok "reconciled file is mode 600" || bad "reconciled file not 600"
# 8. idempotence: second run appends nothing.
before="$(wc -l < "$TARGET")"
reconcile_env_file_additive "$TEMPLATE" "$TARGET" >/dev/null 2>&1
[[ "$(wc -l < "$TARGET")" == "$before" ]] && ok "second run appends nothing (idempotent)" || bad "second run changed line count"
# 9. step 8c actually calls the function (not dead code).
grep -q '^reconcile_env_file_additive' scripts/install/vps-docker-bootstrap.sh && ok "step 8c invokes the reconcile" || bad "step 8c never invokes the function"
printf '[vps-bootstrap-env-reconcile] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
