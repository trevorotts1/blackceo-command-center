#!/usr/bin/env bash
# Tests for update.sh's per-box config preservation (BRAND-01 fix).
#
# REGRESSION GUARD:
#   update.sh's Step 2 used to `git stash push` (never popped) and then
#   `git reset --hard origin/main`. On any box whose app had written per-box
#   client data into the git-tracked config files
#   (config/company-config.json, config/departments.json,
#   config/board-slas.json), the updater reverted them to the repo's
#   placeholder template — wiping the box's branding. The company_branding
#   deploy gate then correctly FAILED and atomic-deploy rolled the update
#   back (proven live on the operator box, 2026-07-19), so every branded box
#   was permanently unable to take updates.
#
#   The fix snapshots each per-box file the box customized (staged, unstaged,
#   or untracked), lets the hard reset land upstream code, then restores the
#   box's copy byte-for-byte with verification. Uncustomized files are NOT
#   snapshotted, so upstream template changes still land on uncustomized
#   boxes.
#
# This test drives the REAL update.sh end-to-end against a throwaway git
# origin + install clone, with npm faked and pm2 hidden from PATH (no
# network beyond the local fixture remote, no live box). The fixture's
# scripts/atomic-deploy.sh records the companyName visible at deploy time —
# the same file the real company_branding gate reads.
#
# Run:  bash scripts/update-preserve-per-box-config.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATE_SH="$SCRIPT_DIR/../update.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/update-preserve-config-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/home"

# Fake npm: install is a no-op; `npm run build` fabricates a BUILD_ID so the
# degraded (no-bash4 / no-atomic-deploy) path also completes if ever taken.
cat > "$WORK/bin/npm" <<'FAKENPM'
#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "build" ]; then
  mkdir -p .next && printf 'fixture-build\n' > .next/BUILD_ID
fi
exit 0
FAKENPM
chmod +x "$WORK/bin/npm"

# PATH: fake bin first, then system dirs ONLY — hides any real npm/pm2 so the
# updater cannot touch a live process manager.
FIXTURE_PATH="$WORK/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# ── fixture "upstream" repo ─────────────────────────────────────────────────
ORIGIN="$WORK/origin"
git init -q -b main "$ORIGIN"
git -C "$ORIGIN" config user.email "fixture@test.invalid"
git -C "$ORIGIN" config user.name "Fixture"
mkdir -p "$ORIGIN/config" "$ORIGIN/scripts"
printf '{"name":"fixture-cc","version":"1.0.0"}\n' > "$ORIGIN/package.json"
printf '6.0.0\n' > "$ORIGIN/version"
cat > "$ORIGIN/config/company-config.json" <<'TPL'
{
  "companyName": "Your Company",
  "industry": "",
  "commandCenterName": "Command Center",
  "companyKPIs": [],
  "departments": []
}
TPL
printf '[]\n' > "$ORIGIN/config/departments.json"
printf '{}\n' > "$ORIGIN/config/board-slas.json"
# Fake atomic-deploy: exits 0 and records the companyName it can see — the
# same file the real company_branding gate reads at deploy time.
cat > "$ORIGIN/scripts/atomic-deploy.sh" <<'FAKEDEPLOY'
#!/usr/bin/env bash
name=$(python3 -c "import json;print(json.load(open('config/company-config.json'))['companyName'])" 2>/dev/null || echo "UNREADABLE")
[ -n "${FAKE_DEPLOY_RECEIPT:-}" ] && printf '%s\n' "$name" > "$FAKE_DEPLOY_RECEIPT"
echo "fake-atomic-deploy: GREEN (companyName seen: $name)"
exit 0
FAKEDEPLOY
chmod +x "$ORIGIN/scripts/atomic-deploy.sh"
git -C "$ORIGIN" add -A
git -C "$ORIGIN" commit -qm "fixture v6.0.0"

new_install() {
  # $1 = install dir
  rm -rf "$1"
  git clone -q "$ORIGIN" "$1"
  git -C "$1" config user.email "box@test.invalid"
  git -C "$1" config user.name "Box"
}

run_updater() {
  # $1 = install dir, $2 = output file, $3 = deploy receipt file
  HOME="$WORK/home" PATH="$FIXTURE_PATH" CC_APP_DIR="$1" \
    FAKE_DEPLOY_RECEIPT="$3" \
    bash "$UPDATE_SH" > "$2" 2>&1
}

json_get() {
  # $1 = file, $2 = key
  python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" "$1" "$2" 2>/dev/null
}

# ── Scenario 1: branded box + upstream CODE change ──────────────────────────
# Branding and Skill-23 departments must survive; the new upstream code file
# must still land (the reset really happened).
echo "Scenario 1: branded box, upstream code change"
INST="$WORK/install-s1"
new_install "$INST"
python3 - "$INST/config/company-config.json" <<'PYBRAND'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["companyName"] = "Fixture Test Co"
d["brandPrimaryColor"] = "#123456"
json.dump(d, open(p, "w"), indent=2)
PYBRAND
printf '[{"slug":"ops","name":"Operations"}]\n' > "$INST/config/departments.json"

printf 'new upstream code\n' > "$ORIGIN/newfeature.txt"
printf '6.0.1\n' > "$ORIGIN/version"
git -C "$ORIGIN" add -A && git -C "$ORIGIN" commit -qm "fixture v6.0.1: code change"

if run_updater "$INST" "$WORK/out-s1.txt" "$WORK/receipt-s1.txt"; then
  ok "updater exits 0 on a branded box"
else
  bad "updater exits non-zero on a branded box (see $WORK/out-s1.txt)"
fi
[ "$(json_get "$INST/config/company-config.json" companyName)" = "Fixture Test Co" ] \
  && ok "companyName survives the update (was wiped to 'Your Company' before the fix)" \
  || bad "companyName was reverted: got '$(json_get "$INST/config/company-config.json" companyName)'"
[ "$(json_get "$INST/config/company-config.json" brandPrimaryColor)" = "#123456" ] \
  && ok "brandPrimaryColor survives the update" \
  || bad "brandPrimaryColor was reverted"
grep -q '"slug": *"ops"\|"slug":"ops"' "$INST/config/departments.json" \
  && ok "Skill-23 departments.json survives the update" \
  || bad "departments.json was reverted to the empty template"
[ -f "$INST/newfeature.txt" ] \
  && ok "upstream code change landed (reset --hard still ran)" \
  || bad "upstream code change did NOT land"
[ "$(cat "$WORK/receipt-s1.txt" 2>/dev/null)" = "Fixture Test Co" ] \
  && ok "deploy-time view (company_branding gate input) sees the client name" \
  || bad "deploy-time view saw '$(cat "$WORK/receipt-s1.txt" 2>/dev/null)' instead of the client name"

# ── Scenario 2: STAGED-only branding edit survives ──────────────────────────
# The old detection (`git diff --quiet`, worktree-vs-index) missed
# staged-only edits entirely; diff-vs-HEAD catches them.
echo "Scenario 2: staged-only branding edit"
INST="$WORK/install-s2"
new_install "$INST"
python3 - "$INST/config/company-config.json" <<'PYBRAND'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["companyName"] = "Staged Brand Co"
json.dump(d, open(p, "w"), indent=2)
PYBRAND
git -C "$INST" add config/company-config.json

printf 'more upstream code\n' >> "$ORIGIN/newfeature.txt"
git -C "$ORIGIN" add -A && git -C "$ORIGIN" commit -qm "fixture: more code"

if run_updater "$INST" "$WORK/out-s2.txt" "$WORK/receipt-s2.txt"; then
  ok "updater exits 0 with a staged-only edit"
else
  bad "updater exits non-zero with a staged-only edit (see $WORK/out-s2.txt)"
fi
[ "$(json_get "$INST/config/company-config.json" companyName)" = "Staged Brand Co" ] \
  && ok "staged-only branding edit survives the update" \
  || bad "staged-only branding edit was reverted"

# ── Scenario 3: uncustomized box takes an upstream TEMPLATE change ──────────
# A box that never branded must still receive legitimate upstream changes to
# the template — preservation must not freeze the file forever.
echo "Scenario 3: uncustomized box, upstream template change"
INST="$WORK/install-s3"
new_install "$INST"

python3 - "$ORIGIN/config/company-config.json" <<'PYTPL'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["newTemplateKey"] = "added-upstream"
json.dump(d, open(p, "w"), indent=2)
PYTPL
git -C "$ORIGIN" add -A && git -C "$ORIGIN" commit -qm "fixture: template change"

if run_updater "$INST" "$WORK/out-s3.txt" "$WORK/receipt-s3.txt"; then
  ok "updater exits 0 on an uncustomized box"
else
  bad "updater exits non-zero on an uncustomized box (see $WORK/out-s3.txt)"
fi
[ "$(json_get "$INST/config/company-config.json" newTemplateKey)" = "added-upstream" ] \
  && ok "upstream template change LANDS on an uncustomized box" \
  || bad "upstream template change did not land on an uncustomized box"

# ── Scenario 4: branded box + upstream template change → box data wins ──────
echo "Scenario 4: branded box AND upstream template change"
INST="$WORK/install-s4"
new_install "$INST"
python3 - "$INST/config/company-config.json" <<'PYBRAND'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["companyName"] = "Conflict Brand Co"
json.dump(d, open(p, "w"), indent=2)
PYBRAND

python3 - "$ORIGIN/config/company-config.json" <<'PYTPL'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["newTemplateKey"] = "changed-again"
json.dump(d, open(p, "w"), indent=2)
PYTPL
git -C "$ORIGIN" add -A && git -C "$ORIGIN" commit -qm "fixture: template change 2"

if run_updater "$INST" "$WORK/out-s4.txt" "$WORK/receipt-s4.txt"; then
  ok "updater exits 0 on branded box + template conflict"
else
  bad "updater exits non-zero on branded box + template conflict (see $WORK/out-s4.txt)"
fi
[ "$(json_get "$INST/config/company-config.json" companyName)" = "Conflict Brand Co" ] \
  && ok "per-box branding wins over the upstream template change" \
  || bad "upstream template overwrote per-box branding"
grep -q "per-box client data" "$WORK/out-s4.txt" \
  && ok "updater reports that the template change was superseded by per-box data" \
  || bad "updater did not report the template-vs-per-box conflict"

# ── summary ─────────────────────────────────────────────────────────────────
echo ""
echo "update-preserve-per-box-config: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
