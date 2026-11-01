#!/usr/bin/env bash
# Tests for approved-target / pin enforcement across EVERY Command Center
# update path: update.sh's zero-downtime path, update.sh's merge fallback, and
# check-updates.sh.
#
# REGRESSION GUARD:
#   CC_UPDATE_TARGET pins ONE main commit for a fleet roll. Only update.sh's
#   zero-downtime path honoured it; the merge fallback merged moving
#   origin/main and check-updates.sh always measured against main. A box could
#   therefore deploy a commit the roll never approved, or report an update the
#   roll deliberately held back. Each path must now use the approved commit or
#   refuse with the named reason code CC_UPDATE_TARGET_REQUIRED — never fall
#   back to the default branch. Policy is selectable (registry entry or
#   CC_REQUIRE_APPROVED_TARGET=1) because the fleet decision is not made yet.
#
# Drives the REAL update.sh and check-updates.sh against throwaway fixtures.
# No network, no live box.
#
# Run:  bash scripts/update-approved-target.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UPDATE_SH="${UPDATE_SH_UNDER_TEST:-$REPO_ROOT/update.sh}"
CHECK_SH="${CHECK_UPDATES_UNDER_TEST:-$REPO_ROOT/check-updates.sh}"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/update-approved-target-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/home"

cat > "$WORK/bin/npm" <<'FAKENPM'
#!/bin/sh
if [ "$1" = "run" ] && [ "$2" = "build" ]; then
  mkdir -p .next && printf 'fixture-build\n' > .next/BUILD_ID
fi
exit 0
FAKENPM
chmod +x "$WORK/bin/npm"
cat > "$WORK/bin/node" <<'FAKENODE'
#!/bin/sh
printf 'v24.0.0\n'
FAKENODE
chmod +x "$WORK/bin/node"
# Fake curl for check-updates.sh: serve http://fixture.invalid/<ref>/<file>
# from $RAW_DIR locally, so the test needs no network and no file:// (the
# macOS curl rejects a file URL whose path contains spaces, which the
# harness's own work directory does).
cat > "$WORK/bin/curl" <<'FAKECURL'
#!/bin/sh
url=""
for a in "$@"; do url="$a"; done
case "$url" in
  http://fixture.invalid/*)
    rel="${url#http://fixture.invalid/}"
    [ -n "${RAW_DIR:-}" ] && [ -f "$RAW_DIR/$rel" ] || exit 22
    cat "$RAW_DIR/$rel" ;;
  *) exit 22 ;;
esac
FAKECURL
chmod +x "$WORK/bin/curl"
FIXTURE_PATH="$WORK/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# ── fixture "upstream" repo ─────────────────────────────────────────────────
ORIGIN="$WORK/blackceo-command-center"
git init -q -b main "$ORIGIN"
git -C "$ORIGIN" config user.email "fixture@test.invalid"
git -C "$ORIGIN" config user.name "Fixture"
mkdir -p "$ORIGIN/config" "$ORIGIN/public" "$ORIGIN/scripts" "$ORIGIN/src"
printf '{"name":"mission-control","version":"1.0.0"}\n' > "$ORIGIN/package.json"
printf '{"name":"mission-control","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"mission-control","version":"1.0.0"}}}\n' > "$ORIGIN/package-lock.json"
printf '6.0.0\n' > "$ORIGIN/version"
: > "$ORIGIN/next.config.mjs"
: > "$ORIGIN/ecosystem.config.cjs"
printf '// fixture\n' > "$ORIGIN/src/.gitkeep"
printf '{"companyName":"Your Company","industry":"","commandCenterName":"Command Center","companyKPIs":[],"departments":[]}\n' > "$ORIGIN/config/company-config.json"
printf '[]\n' > "$ORIGIN/config/departments.json"
printf '{}\n' > "$ORIGIN/config/board-slas.json"
printf '{"logoUrl":"https://example.invalid/default-logo.png"}\n' > "$ORIGIN/public/logo-config.json"
cat > "$ORIGIN/scripts/atomic-deploy.sh" <<'FAKEDEPLOY'
#!/usr/bin/env bash
app="$PWD"; rev=""
while [ $# -gt 0 ]; do
  case "$1" in --app-dir) app="$2"; shift 2 ;; --revision) rev="$2"; shift 2 ;; *) shift ;; esac
done
if [ -n "$rev" ] && [ "$(git -C "$app" rev-parse HEAD)" != "$rev" ]; then
  git -C "$app" merge --ff-only -q "$rev" 2>/dev/null || git -C "$app" checkout -q "$rev" || exit 2
fi
echo "fake-atomic-deploy: GREEN"
exit 0
FAKEDEPLOY
chmod +x "$ORIGIN/scripts/atomic-deploy.sh"
git -C "$ORIGIN" add -A && git -C "$ORIGIN" commit -qm "fixture v6.0.0"

new_install() {
  rm -rf "$1"
  git clone -q "$ORIGIN" "$1"
  git -C "$1" config user.email "box@test.invalid"
  git -C "$1" config user.name "Box"
  git -C "$1" remote set-url origin "https://github.com/trevorotts1/blackceo-command-center.git"
  git -C "$1" config --add "url.${ORIGIN}.insteadOf" \
    "https://github.com/trevorotts1/blackceo-command-center.git"
}

run_updater() {  # $1=install dir, $2=out file, rest=env assignments
  local inst="$1" out="$2"; shift 2
  env HOME="$WORK/home" PATH="$FIXTURE_PATH" CC_APP_DIR="$inst" "$@" \
    bash "$UPDATE_SH" > "$out" 2>&1
}

# ── Control 1: no pin, optional policy → merge path still updates ───────────
echo "Control 1: optional policy, no pin → merge path updates to main"
INST="$WORK/install-c1"; new_install "$INST"
printf 'control\n' > "$ORIGIN/c1.txt"
git -C "$ORIGIN" add -A && git -C "$ORIGIN" commit -qm "fixture: c1"
MAIN1="$(git -C "$ORIGIN" rev-parse HEAD)"
if run_updater "$INST" "$WORK/out-c1.txt" CC_UPDATE_ZERO_DOWNTIME=0; then
  ok "control: updater exits 0 with no pin"
else
  bad "control: updater failed with no pin (see $WORK/out-c1.txt)"
fi
[ "$(git -C "$INST" rev-parse HEAD)" = "$MAIN1" ] && [ -f "$INST/c1.txt" ] \
  && ok "control: box reached main (harness really runs the merge path)" \
  || bad "control: box did not reach main"

# ── Path A: merge fallback refuses when a target is required and missing ────
echo "Path A: requirement + no pin → merge fallback REFUSES"
INST="$WORK/install-a"; new_install "$INST"
HEAD_BEFORE="$(git -C "$INST" rev-parse HEAD)"
if run_updater "$INST" "$WORK/out-a.txt" CC_UPDATE_ZERO_DOWNTIME=0 CC_REQUIRE_APPROVED_TARGET=1; then
  bad "merge fallback exited 0 with a required target missing (see $WORK/out-a.txt)"
else
  ok "merge fallback refuses (non-zero exit)"
fi
grep -q 'CC_UPDATE_TARGET_REQUIRED' "$WORK/out-a.txt" \
  && ok "merge fallback names reason code CC_UPDATE_TARGET_REQUIRED" \
  || bad "merge fallback did not name the reason code (see $WORK/out-a.txt)"
grep -qi 'Nothing was changed' "$WORK/out-a.txt" \
  && ok "merge fallback reports that nothing was changed" \
  || bad "merge fallback did not report 'Nothing was changed'"
[ "$(git -C "$INST" rev-parse HEAD)" = "$HEAD_BEFORE" ] \
  && ok "merge fallback left the checkout untouched" \
  || bad "merge fallback mutated the checkout before refusing"

# ── Path B: zero-downtime refuses when a target is required and missing ─────
echo "Path B: requirement + no pin → zero-downtime path REFUSES"
INST="$WORK/install-b"; new_install "$INST"
HEAD_BEFORE="$(git -C "$INST" rev-parse HEAD)"
if run_updater "$INST" "$WORK/out-b.txt" CC_REQUIRE_APPROVED_TARGET=1; then
  bad "zero-downtime exited 0 with a required target missing (see $WORK/out-b.txt)"
else
  ok "zero-downtime refuses (non-zero exit)"
fi
grep -q 'CC_UPDATE_TARGET_REQUIRED' "$WORK/out-b.txt" \
  && ok "zero-downtime names reason code CC_UPDATE_TARGET_REQUIRED" \
  || bad "zero-downtime did not name the reason code"
[ "$(git -C "$INST" rev-parse HEAD)" = "$HEAD_BEFORE" ] \
  && ok "zero-downtime left the checkout untouched" \
  || bad "zero-downtime mutated the checkout before refusing"

# ── Path C: merge fallback lands on the PIN, not the later main ─────────────
echo "Path C: pin + later main → merge fallback lands on the pin"
INST="$WORK/install-c"; new_install "$INST"
printf 'pinned\n' > "$ORIGIN/pinned.txt"
git -C "$ORIGIN" add -A && git -C "$ORIGIN" commit -qm "fixture: the roll's commit"
PIN="$(git -C "$ORIGIN" rev-parse HEAD)"
printf 'later\n' > "$ORIGIN/later.txt"
git -C "$ORIGIN" add -A && git -C "$ORIGIN" commit -qm "fixture: merged mid-roll"
if run_updater "$INST" "$WORK/out-c.txt" CC_UPDATE_ZERO_DOWNTIME=0 CC_UPDATE_TARGET="$PIN"; then
  ok "merge fallback exits 0 with an approved target"
else
  bad "merge fallback failed with an approved target (see $WORK/out-c.txt)"
fi
[ "$(git -C "$INST" rev-parse HEAD)" = "$PIN" ] && [ -f "$INST/pinned.txt" ] && [ ! -f "$INST/later.txt" ] \
  && ok "merge fallback deployed the pinned commit, not the later main" \
  || bad "merge fallback did not land on the pinned commit"

# ── Path D: registry makes the requirement drive every path ─────────────────
echo "Path D: registry policy (not env) makes the target mandatory"
SDIR="$WORK/scripts-required"
rm -rf "$SDIR"; mkdir -p "$SDIR/config"
cp "$UPDATE_SH" "$SDIR/update.sh"; cp "$CHECK_SH" "$SDIR/check-updates.sh"
python3 - "$SDIR/config/update-target-registry.json" <<'PYREG'
import json, sys
json.dump({"schema":"blackceo.update-target-registry/v1","repo":"trevorotts1/blackceo-command-center",
           "install_roots":[],"update_paths":[{"name":"merge-fallback","requires_approved_target":True}]},
          open(sys.argv[1],"w"), indent=1)
PYREG
INST="$WORK/install-d"; new_install "$INST"
HEAD_BEFORE="$(git -C "$INST" rev-parse HEAD)"
if HOME="$WORK/home" PATH="$FIXTURE_PATH" CC_APP_DIR="$INST" CC_UPDATE_ZERO_DOWNTIME=0 \
     bash "$SDIR/update.sh" > "$WORK/out-d.txt" 2>&1; then
  bad "registry requirement did not refuse (see $WORK/out-d.txt)"
else
  ok "registry requirement refuses the merge fallback"
fi
grep -q 'CC_UPDATE_TARGET_REQUIRED' "$WORK/out-d.txt" \
  && ok "registry refusal carries the named reason code" \
  || bad "registry refusal lacked the reason code"
[ "$(git -C "$INST" rev-parse HEAD)" = "$HEAD_BEFORE" ] \
  && ok "registry refusal left the checkout untouched" \
  || bad "registry refusal mutated the checkout"

# ── Path E: check-updates refuses by name ──────────────────────────────────
echo "Path E: check-updates REFUSES when a target is required and missing"
INST="$WORK/install-e"; new_install "$INST"
set +e
HOME="$WORK/home" PATH="$FIXTURE_PATH" CC_APP_DIR="$INST" CC_REQUIRE_APPROVED_TARGET=1 \
  bash "$CHECK_SH" > "$WORK/out-e.txt" 2>&1
RC_E=$?
set +e
[ "$RC_E" -eq 2 ] && ok "check-updates exits 2 on refusal" || bad "check-updates exit was $RC_E, expected 2"
python3 - "$WORK/out-e.txt" <<'PY' && ok "check-updates refusal JSON names status + reason_code" || bad "check-updates refusal JSON missing status/reason_code"
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("status") == "refused", d.get("status")
assert d.get("reason_code") == "CC_UPDATE_TARGET_REQUIRED", d.get("reason_code")
assert d.get("has_update") is False, d.get("has_update")
PY

# ── Path F: check-updates measures against the PIN, not moving main ────────
echo "Path F: check-updates reports the pinned commit's version"
RAW="$WORK/raw"; mkdir -p "$RAW/main" "$RAW/$PIN"
printf '9.9.9\n' > "$RAW/main/version"
printf '6.0.1\n' > "$RAW/$PIN/version"
printf '## v9.9.9\nlater\n' > "$RAW/main/CHANGELOG.md"
printf '## v6.0.1\npinned\n' > "$RAW/$PIN/CHANGELOG.md"
HOME="$WORK/home" PATH="$FIXTURE_PATH" CC_APP_DIR="$INST" \
  CC_UPDATE_BASE="http://fixture.invalid" RAW_DIR="$RAW" CC_UPDATE_TARGET="$PIN" \
  bash "$CHECK_SH" > "$WORK/out-f.txt" 2>&1
python3 - "$WORK/out-f.txt" "$PIN" <<'PY' && ok "check-updates reads version at the pinned ref" || bad "check-updates ignored the pin (see $WORK/out-f.txt)"
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("target_pinned") is True, d
assert d.get("latest_version") == "6.0.1", d.get("latest_version")
assert sys.argv[2] in d.get("target_ref", ""), d.get("target_ref")
PY
HOME="$WORK/home" PATH="$FIXTURE_PATH" CC_APP_DIR="$INST" CC_UPDATE_BASE="http://fixture.invalid" RAW_DIR="$RAW" \
  bash "$CHECK_SH" > "$WORK/out-f2.txt" 2>&1
python3 - "$WORK/out-f2.txt" <<'PY' && ok "control: without a pin check-updates follows main (9.9.9)" || bad "control: unpinned check did not follow main"
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("target_pinned") is False, d
assert d.get("latest_version") == "9.9.9", d.get("latest_version")
PY

# ── Path G: registry drives check-updates install-root coverage ────────────
echo "Path G: registry-listed root is covered by check-updates"
CUSTOM="$WORK/customroot/cc"
mkdir -p "$(dirname "$CUSTOM")"; new_install "$CUSTOM"
printf '6.0.0\n' > "$CUSTOM/version"
mkdir -p "$WORK/scripts-cov/config"
cp "$CHECK_SH" "$WORK/scripts-cov/check-updates.sh"
python3 - "$WORK/scripts-cov/config/update-target-registry.json" "$CUSTOM" <<'PY' && ok "registry file written with custom root" || bad "could not write registry"
import json, sys
json.dump({"schema":"blackceo.update-target-registry/v1","repo":"trevorotts1/blackceo-command-center",
           "install_roots":[{"path":sys.argv[2],"canonical":True}],"update_paths":[]}, open(sys.argv[1],"w"))
PY
HOME="$WORK/home" PATH="$FIXTURE_PATH" CC_UPDATE_BASE="http://fixture.invalid" RAW_DIR="$RAW" \
  bash "$WORK/scripts-cov/check-updates.sh" > "$WORK/out-g.txt" 2>&1
python3 - "$WORK/out-g.txt" "$(cd "$CUSTOM" && pwd -P)" <<'PY' && ok "check-updates resolved the registry-listed root" || bad "registry root not covered (see $WORK/out-g.txt)"
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("install_dir") == sys.argv[2], (d.get("install_dir"), sys.argv[2])
assert d.get("install_dir_status") == "autodetected", d.get("install_dir_status")
PY

echo ""
echo "update-approved-target: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
