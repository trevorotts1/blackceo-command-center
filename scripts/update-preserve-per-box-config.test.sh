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
#   The fix snapshots each per-box file the box customized (committed, staged,
#   unstaged, or untracked), merges upstream without discarding local commits,
#   then restores the box's copy byte-for-byte as ignored runtime state.
#   Uncustomized files are generated from tracked *.example.json templates.
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
UPDATE_SH="${UPDATE_SH_UNDER_TEST:-$SCRIPT_DIR/../update.sh}"
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
# TRAP-2: update.sh no longer accepts a CC_APP_DIR pin on the strength of
# "it is a directory containing a package.json" — a decoy passed that. The
# pin must now be a git worktree ROOT whose `origin` remote resolves to this
# repo's slug, holding the app structure the updater drives. This fixture
# therefore has to LOOK like a real checkout: the fixture remote is named
# `blackceo-command-center` so a clone's origin slug matches, the package
# name is the app's real name, and the marker files exist. Keep in sync with
# CC_REQUIRED_MARKERS / CC_PKG_NAME in update.sh.
ORIGIN="$WORK/blackceo-command-center"
git init -q -b main "$ORIGIN"
git -C "$ORIGIN" config user.email "fixture@test.invalid"
git -C "$ORIGIN" config user.name "Fixture"
mkdir -p "$ORIGIN/config" "$ORIGIN/public" "$ORIGIN/scripts" "$ORIGIN/src"
printf '{"name":"mission-control","version":"1.0.0"}\n' > "$ORIGIN/package.json"
printf '6.0.0\n' > "$ORIGIN/version"
: > "$ORIGIN/next.config.mjs"
: > "$ORIGIN/ecosystem.config.cjs"
# git does not track empty directories — src/ must contain something to survive
# the clone, or the install dir fails the app-structure check.
printf '// fixture\n' > "$ORIGIN/src/.gitkeep"
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
printf '{"logoUrl":"https://example.invalid/default-logo.png"}\n' > "$ORIGIN/public/logo-config.json"
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
  && ok "upstream code change landed alongside per-box runtime state" \
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

# ── Scenario 5: the FOURTH per-box file (logo-config.json) survives ───────────
echo "Scenario 5: customized public/logo-config.json"
INST="$WORK/install-s5"
new_install "$INST"
printf '{"logoUrl":"https://example.invalid/box-logo.png"}\n' > "$INST/public/logo-config.json"

printf 'logo scenario upstream code\n' > "$ORIGIN/logo-feature.txt"
git -C "$ORIGIN" add -A && git -C "$ORIGIN" commit -qm "fixture: logo scenario code"

if run_updater "$INST" "$WORK/out-s5.txt" "$WORK/receipt-s5.txt"; then
  ok "updater exits 0 with a customized logo config"
else
  bad "updater exits non-zero with a customized logo config (see $WORK/out-s5.txt)"
fi
[ "$(json_get "$INST/public/logo-config.json" logoUrl)" = "https://example.invalid/box-logo.png" ] \
  && ok "public/logo-config.json survives the update" \
  || bad "public/logo-config.json was reverted to the tracked default"

# ── Scenario 6: locally committed work remains in history and on disk ────────
echo "Scenario 6: locally committed customization"
INST="$WORK/install-s6"
new_install "$INST"
python3 - "$INST/config/company-config.json" <<'PYBRAND'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["companyName"] = "Committed Brand Co"
json.dump(d, open(p, "w"), indent=2)
PYBRAND
printf 'box-local extension\n' > "$INST/box-local-extension.txt"
git -C "$INST" add config/company-config.json box-local-extension.txt
git -C "$INST" commit -qm "box: committed customization"
LOCAL_COMMIT=$(git -C "$INST" rev-parse HEAD)

printf 'committed scenario upstream code\n' > "$ORIGIN/committed-feature.txt"
git -C "$ORIGIN" add -A && git -C "$ORIGIN" commit -qm "fixture: committed scenario code"

if run_updater "$INST" "$WORK/out-s6.txt" "$WORK/receipt-s6.txt"; then
  ok "updater exits 0 with locally committed work"
else
  bad "updater exits non-zero with locally committed work (see $WORK/out-s6.txt)"
fi
git -C "$INST" merge-base --is-ancestor "$LOCAL_COMMIT" HEAD \
  && ok "locally committed work remains in updated branch history" \
  || bad "locally committed work was discarded from updated branch history"
[ -f "$INST/box-local-extension.txt" ] \
  && ok "locally committed code remains in the working tree" \
  || bad "locally committed code was deleted by the update"
[ "$(json_get "$INST/config/company-config.json" companyName)" = "Committed Brand Co" ] \
  && ok "locally committed branding survives the update" \
  || bad "locally committed branding was reverted"
[ -f "$INST/committed-feature.txt" ] \
  && ok "upstream code lands alongside the local commit" \
  || bad "upstream code did not land alongside the local commit"

# ── Scenario 7: existing boxes migrate from tracked files to ignored runtime ─
echo "Scenario 7: tracked-to-runtime migration"
INST="$WORK/install-s7"
new_install "$INST"
python3 - "$INST/config/company-config.json" <<'PYBRAND'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["companyName"] = "Migrated Brand Co"
json.dump(d, open(p, "w"), indent=2)
PYBRAND
printf '[{"slug":"migrated-ops","name":"Migrated Ops"}]\n' > "$INST/config/departments.json"
printf '{"migrated-ops":{"staleReviewHours":7}}\n' > "$INST/config/board-slas.json"
printf '{"logoUrl":"https://example.invalid/migrated-logo.png"}\n' > "$INST/public/logo-config.json"

cp "$ORIGIN/config/company-config.json" "$ORIGIN/config/company-config.example.json"
cp "$ORIGIN/config/departments.json" "$ORIGIN/config/departments.example.json"
cp "$ORIGIN/config/board-slas.json" "$ORIGIN/config/board-slas.example.json"
cp "$ORIGIN/public/logo-config.json" "$ORIGIN/public/logo-config.example.json"
cat >> "$ORIGIN/.gitignore" <<'IGNORE'
/config/company-config.json
/config/departments.json
/config/board-slas.json
/public/logo-config.json
IGNORE
git -C "$ORIGIN" rm -q config/company-config.json config/departments.json config/board-slas.json public/logo-config.json
git -C "$ORIGIN" add -A && git -C "$ORIGIN" commit -qm "fixture: move per-box config to ignored runtime files"

if run_updater "$INST" "$WORK/out-s7.txt" "$WORK/receipt-s7.txt"; then
  ok "updater exits 0 while migrating an existing customized box"
else
  bad "updater exits non-zero during tracked-to-runtime migration (see $WORK/out-s7.txt)"
fi
[ "$(json_get "$INST/config/company-config.json" companyName)" = "Migrated Brand Co" ] \
  && ok "company config survives tracked-to-runtime migration" \
  || bad "company config was lost during tracked-to-runtime migration"
grep -q 'migrated-ops' "$INST/config/departments.json" \
  && ok "departments config survives tracked-to-runtime migration" \
  || bad "departments config was lost during tracked-to-runtime migration"
grep -q 'staleReviewHours' "$INST/config/board-slas.json" \
  && ok "board SLA config survives tracked-to-runtime migration" \
  || bad "board SLA config was lost during tracked-to-runtime migration"
[ "$(json_get "$INST/public/logo-config.json" logoUrl)" = "https://example.invalid/migrated-logo.png" ] \
  && ok "logo config survives tracked-to-runtime migration" \
  || bad "logo config was lost during tracked-to-runtime migration"
if git -C "$INST" ls-files --error-unmatch \
  config/company-config.json config/departments.json config/board-slas.json public/logo-config.json \
  >/dev/null 2>&1; then
  bad "runtime config files are still git-tracked after migration"
else
  ok "all four runtime config files are untracked after migration"
fi
for template in \
  config/company-config.example.json config/departments.example.json \
  config/board-slas.example.json public/logo-config.example.json; do
  [ -f "$INST/$template" ] || bad "tracked template missing after migration: $template"
done

# ── Scenario 8: a box left on a feature branch converges to main ────────────
echo "Scenario 8: feature-branch checkout converges to latest main"
INST="$WORK/install-s8"
new_install "$INST"
git -C "$INST" checkout -qb box-feature
printf 'box-local feature commit\n' > "$INST/box-feature.txt"
git -C "$INST" add box-feature.txt
git -C "$INST" commit -qm "box: local feature"
FEATURE_COMMIT="$(git -C "$INST" rev-parse HEAD)"

printf 'latest upstream main\n' > "$ORIGIN/latest-main.txt"
git -C "$ORIGIN" add latest-main.txt
git -C "$ORIGIN" commit -qm "fixture: latest main"

if run_updater "$INST" "$WORK/out-s8.txt" "$WORK/receipt-s8.txt"; then
  ok "updater exits 0 from a feature-branch checkout"
else
  bad "updater exits non-zero from a feature branch (see $WORK/out-s8.txt)"
fi
[ "$(git -C "$INST" symbolic-ref --quiet --short HEAD 2>/dev/null || true)" = "main" ] \
  && ok "active checkout is main after update" \
  || bad "active checkout was left on a feature branch"
git -C "$INST" merge-base --is-ancestor origin/main HEAD \
  && ok "updated main contains latest origin/main" \
  || bad "updated checkout does not contain latest origin/main"
git -C "$INST" merge-base --is-ancestor "$FEATURE_COMMIT" HEAD \
  && ok "local feature commit remains in active history" \
  || bad "local feature commit was discarded"
git -C "$INST" show-ref --verify --quiet refs/heads/box-feature \
  && ok "original feature branch reference is retained" \
  || bad "original feature branch reference was deleted"
[ -f "$INST/latest-main.txt" ] && ok "latest upstream file landed" || bad "latest upstream file missing"

# ── summary ─────────────────────────────────────────────────────────────────
echo ""
echo "update-preserve-per-box-config: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
