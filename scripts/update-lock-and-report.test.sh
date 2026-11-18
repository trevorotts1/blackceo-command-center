#!/usr/bin/env bash
# Tests for the Command Center side of the Tuesday/Friday/Sunday auto-update:
#   - update.sh honours the shared box update lock (inherit, defer with exit 75,
#     release on the way out, proceed with a warning when the helper is absent);
#   - update.sh reports its version before and after (CC_UPDATE_RESULT line and
#     CC_UPDATE_RESULT_FILE) for the auto-update status beacon;
#   - the client "ask first" flow (cron-prompt.txt) is gone and DEPLOYMENT.md
#     documents the Tue/Fri/Sun 2:15 AM notice / 2:30 AM Eastern run.
#
# Drives the REAL update.sh against throwaway fixtures. No network, no live box,
# no client. Set ONB_LOCK_LIB to the onboarding repo's real scripts/box-update-lock.sh
# to run the same cases against the real helper instead of the bundled fixture.
#
# Run:  bash scripts/update-lock-and-report.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UPDATE_SH="${UPDATE_SH_UNDER_TEST:-$REPO_ROOT/update.sh}"
CHECK_SH="${CHECK_UPDATES_UNDER_TEST:-$REPO_ROOT/check-updates.sh}"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/update-lock-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/home"

cat > "$WORK/bin/npm" <<'FAKENPM'
#!/bin/sh
if [ "$1" = "ci" ] && [ -n "${NPM_CI_FAIL:-}" ]; then echo "fixture: npm ci failed" >&2; exit 1; fi
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
if [ -n "${FD9_PROBE:-}" ]; then
  if { true >&9; } 2>/dev/null; then echo open > "$FD9_PROBE"; else echo closed > "$FD9_PROBE"; fi
fi
echo "fake-atomic-deploy: GREEN"
exit "${ATOMIC_RC:-0}"
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


# ── lock helper fixture (same contract as the onboarding helper) ────────────
# acquire: rc 0 held/inherited, rc 3 live foreign owner. Record = pid + run_id.
LOCKLIB="$WORK/box-update-lock.sh"   # copied: keeps the path free of spaces
if [ -n "${ONB_LOCK_LIB:-}" ]; then
  cp "$ONB_LOCK_LIB" "$LOCKLIB"
else
cat > "$LOCKLIB" <<'FAKELOCK'
BUL_LOCK_PATH=""
_rec() { awk -F= -v k="$1" '$1==k{print $2; exit}' "$BUL_LOCK_PATH" 2>/dev/null; }
box_update_lock_acquire() {
  BUL_LOCK_PATH="${1:-/tmp/openclaw-update.lock}"
  local pid; pid="$(_rec pid)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    if [ -n "${BFX_LOCK_RUN_ID-}" ] && [ "$BFX_LOCK_RUN_ID" = "$(_rec run_id)" ]; then return 0; fi
    echo "LOCK HELD: fixture owner pid $pid" >&2; return 3
  fi
  if command -v flock >/dev/null 2>&1; then exec 9<>"$BUL_LOCK_PATH" && flock -n 9 || return 3; fi
  printf 'pid=%s\nrun_id=%s\nrole=%s\n' "$$" "$2" "$3" > "$BUL_LOCK_PATH" || return 1
  return 0
}
box_update_lock_release() {
  [ -n "${ORDER_LOG:-}" ] && echo "release: node_modules.prev=$([ -d node_modules.prev ] && echo present || echo gone)" >> "$ORDER_LOG"
  [ -f "${BUL_LOCK_PATH:-}" ] && [ "$(_rec pid)" = "$$" ] && rm -f "$BUL_LOCK_PATH"
  return 0
}
FAKELOCK
fi

LEASE="$WORK/openclaw-update.lock"
RESULT="$WORK/result.json"
jget() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$1" "$2"; }

bump_origin() {  # $1 = new version string
  printf '%s\n' "$1" > "$ORIGIN/version"
  printf '%s\n' "$1" > "$ORIGIN/bump-$1.txt"
  git -C "$ORIGIN" add -A && git -C "$ORIGIN" commit -qm "fixture: $1"
}

lock_env() { echo "OPENCLAW_UPDATE_LEASE=$LEASE" "CC_BOX_UPDATE_LOCK_LIB=$LOCKLIB" "CC_UPDATE_RESULT_FILE=$RESULT" CC_UPDATE_ZERO_DOWNTIME=0; }

# ── Case 1: lock free -> update runs, reports versions, releases the lease ──
echo "Case 1: free lock -> UPDATED with before/after, lease released"
INST="$WORK/install-1"; new_install "$INST"; rm -f "$LEASE" "$RESULT"
bump_origin 6.1.0
if run_updater "$INST" "$WORK/out-1.txt" $(lock_env); then ok "updater exits 0"; else bad "updater failed (see $WORK/out-1.txt)"; fi
[ "$(jget "$RESULT" status)" = "UPDATED" ] && ok "result status UPDATED" || bad "status was '$(jget "$RESULT" status)'"
[ "$(jget "$RESULT" before)" = "6.0.0" ] && [ "$(jget "$RESULT" after)" = "6.1.0" ] \
  && ok "result carries version before 6.0.0 and after 6.1.0" || bad "versions were '$(jget "$RESULT" before)' -> '$(jget "$RESULT" after)'"
[ "$(jget "$RESULT" commit_before)" != "$(jget "$RESULT" commit_after)" ] && [ -n "$(jget "$RESULT" commit_after)" ] \
  && ok "result carries distinct before/after commits" || bad "commit before/after wrong"
grep -q '^CC_UPDATE_RESULT {' "$WORK/out-1.txt" && ok "CC_UPDATE_RESULT line printed on stdout" || bad "no CC_UPDATE_RESULT line"
grep -q 'Tell the owner: "Command Center updated to' "$WORK/home/clawd/AGENTS.md" && ok "manual run still tells the agent to tell the owner" || bad "manual run lost the tell-the-owner step"
[ ! -e "$LEASE" ] && ok "lease file released on the way out" || bad "lease file left behind"

# ── Case 2: already current -> CURRENT, before == after ─────────────────────
echo "Case 2: nothing new -> CURRENT"
rm -f "$LEASE" "$RESULT"
if run_updater "$INST" "$WORK/out-2.txt" $(lock_env); then ok "updater exits 0 when current"; else bad "updater failed when current"; fi
[ "$(jget "$RESULT" status)" = "CURRENT" ] && [ "$(jget "$RESULT" before)" = "$(jget "$RESULT" after)" ] \
  && ok "status CURRENT with identical versions" || bad "current run reported '$(jget "$RESULT" status)'"

# ── Case 3: live foreign owner -> DEFERRED, exit 75, nothing changed ───────
echo "Case 3: another updater holds the lock -> exit 75, DEFERRED, no change"
INST="$WORK/install-3"; new_install "$INST"; rm -f "$RESULT"
bump_origin 6.2.0
sleep 120 & HOLDER=$!
printf 'pid=%s\nstart=none\nrun_id=other-run\nrole=fleet-roll\n' "$HOLDER" > "$LEASE"
HEAD_BEFORE="$(git -C "$INST" rev-parse HEAD)"
run_updater "$INST" "$WORK/out-3.txt" $(lock_env); RC3=$?
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
[ "$RC3" -eq 75 ] && ok "exit code 75 (deferred)" || bad "exit code was $RC3"
[ "$(jget "$RESULT" status)" = "DEFERRED" ] && ok "result status DEFERRED" || bad "status was '$(jget "$RESULT" status)'"
[ "$(git -C "$INST" rev-parse HEAD)" = "$HEAD_BEFORE" ] && ok "checkout untouched" || bad "checkout changed while another updater held the lock"
grep -q 'Step 1: Backup' "$WORK/out-3.txt" && bad "ran the backup step while deferred" || ok "no update step ran"
[ -e "$LEASE" ] && ok "the other owner's lease was not removed" || bad "foreign lease was deleted"

# ── Case 4: lock owned by the parent auto-update run -> inherited, proceeds ─
echo "Case 4: lease held by the launching auto-update run -> inherited"
INST="$WORK/install-4"; new_install "$INST"; rm -f "$LEASE" "$RESULT"
bump_origin 6.2.1
(
  . "$LOCKLIB"
  box_update_lock_acquire "$LEASE" "auto-update-20261117T000000Z-1" "auto-update" "$INST" || exit 9
  export BFX_LOCK_RUN_ID="auto-update-20261117T000000Z-1" BFX_LOCK_OWNER_PID="$$"
  env HOME="$WORK/home" PATH="$FIXTURE_PATH" CC_APP_DIR="$INST" $(lock_env) \
    bash "$UPDATE_SH" > "$WORK/out-4.txt" 2>&1
  echo $? > "$WORK/rc4"
  [ -e "$LEASE" ] && echo held > "$WORK/lease4" || echo gone > "$WORK/lease4"
  box_update_lock_release
)
[ "$(cat "$WORK/rc4" 2>/dev/null)" = "0" ] && ok "child update.sh proceeds under the parent's lease" || bad "child did not proceed (rc $(cat "$WORK/rc4" 2>/dev/null))"
[ "$(cat "$WORK/lease4" 2>/dev/null)" = "held" ] && ok "child left the parent's lease in place" || bad "child released the parent's lease"
if grep -q 'Tell the owner' "$WORK/home/clawd/AGENTS.md"; then bad "scheduled run told the agent to message the owner"; else ok "scheduled run adds NO tell-the-owner instruction"; fi
grep -q 'Do NOT message the owner' "$WORK/home/clawd/AGENTS.md" && ok "scheduled run says not to message the owner" || bad "no do-not-message line"
[ "$(jget "$RESULT" status)" = "UPDATED" ] && ok "inherited run reports UPDATED" || bad "inherited run reported '$(jget "$RESULT" status)'"

# ── Case 5: helper absent -> warn and proceed ───────────────────────────────
echo "Case 5: no lock helper on the box -> warning, update still runs"
INST="$WORK/install-5"; new_install "$INST"; rm -f "$LEASE" "$RESULT"
bump_origin 6.3.0
run_updater "$INST" "$WORK/out-5.txt" CC_BOX_UPDATE_LOCK_LIB="$WORK/does-not-exist.sh" OPENCLAW_ROOT_DIR="$WORK/no-root" CC_UPDATE_RESULT_FILE="$RESULT" CC_UPDATE_ZERO_DOWNTIME=0; RC5=$?
# CC_BOX_UPDATE_LOCK_LIB pointing at a missing file also counts as absent.
[ "$RC5" -eq 0 ] && ok "update proceeds without the helper" || bad "rc $RC5 without helper"
grep -q 'cannot be serialized' "$WORK/out-5.txt" && ok "warns that the run cannot be serialized" || bad "no serialization warning"
[ "$(jget "$RESULT" status)" = "UPDATED" ] && ok "still reports UPDATED" || bad "status '$(jget "$RESULT" status)'"

# ── Case 6: a failed run reports FAILED and releases the lease ──────────────
echo "Case 6: failing run -> FAILED result, lease released"
INST="$WORK/install-6"; new_install "$INST"; rm -f "$LEASE" "$RESULT"
if run_updater "$INST" "$WORK/out-6.txt" $(lock_env) CC_REQUIRE_APPROVED_TARGET=1; then bad "expected a refusal"; else ok "run fails without the required target"; fi
[ "$(jget "$RESULT" status)" = "FAILED" ] && ok "result status FAILED" || bad "status '$(jget "$RESULT" status)'"
[ ! -e "$LEASE" ] && ok "lease released after failure" || bad "lease left behind after failure"

# fake flock so the helper takes its flock path (fd 9) on every platform
mkdir -p "$WORK/flockbin"; printf '#!/bin/sh\nexit 0\n' > "$WORK/flockbin/flock"; chmod +x "$WORK/flockbin/flock"

# ── Case 8: flock fd 9 is closed for atomic-deploy (and the mutation proof) ──
echo "Case 8: the lock's fd 9 does not leak into atomic-deploy"
INST="$WORK/install-8"; new_install "$INST"; rm -f "$LEASE" "$RESULT" "$WORK/fd9"
bump_origin 6.4.0
FIXTURE_PATH_SAVE="$FIXTURE_PATH"; FIXTURE_PATH="$WORK/flockbin:$FIXTURE_PATH"
run_updater "$INST" "$WORK/out-8.txt" $(lock_env) FD9_PROBE="$WORK/fd9"
[ "$(cat "$WORK/fd9" 2>/dev/null)" = "closed" ] && ok "atomic-deploy child sees fd 9 closed" || bad "fd 9 state in child: '$(cat "$WORK/fd9" 2>/dev/null)'"
# mutation: the same run with the close removed MUST leak, or this test proves nothing
sed 's/ 9>&-//g' "$UPDATE_SH" > "$WORK/update-leaky.sh"
INST="$WORK/install-8b"; new_install "$INST"; rm -f "$LEASE" "$RESULT" "$WORK/fd9"
env HOME="$WORK/home" PATH="$FIXTURE_PATH" CC_APP_DIR="$INST" $(lock_env) FD9_PROBE="$WORK/fd9" bash "$WORK/update-leaky.sh" > "$WORK/out-8b.txt" 2>&1
[ "$(cat "$WORK/fd9" 2>/dev/null)" = "open" ] && ok "mutation proof: without the close fd 9 leaks (test can fail)" || bad "mutation did not leak ('$(cat "$WORK/fd9" 2>/dev/null)') — test is vacuous"
# every pm2 call and the deploy calls in update.sh close fd 9
MISSING="$(grep -nE '(^|[^a-zA-Z_.-])pm2 (list|jlist|reload|restart)|"\$\{?Z?D?_?BASH4\}?" "' "$UPDATE_SH" | grep -v '^[0-9]*:[[:space:]]*#' | grep -v '9>&-' | grep -v 'warn "' || true)"
[ -z "$MISSING" ] && ok "every pm2 and atomic-deploy call site closes fd 9" || bad "call sites without 9>&-: $MISSING"
FIXTURE_PATH="$FIXTURE_PATH_SAVE"

# ── Case 9: atomic-deploy exit 3 (health unknown) is not UPDATED ────────────
echo "Case 9: health unknown -> FAILED, non-zero exit"
INST="$WORK/install-9"; new_install "$INST"; rm -f "$LEASE" "$RESULT"
bump_origin 6.5.0
run_updater "$INST" "$WORK/out-9.txt" $(lock_env) ATOMIC_RC=3; RC9=$?
[ "$RC9" -ne 0 ] && ok "exit code non-zero ($RC9)" || bad "exit 0 with unknown health"
[ "$(jget "$RESULT" status)" = "FAILED" ] && ok "result status FAILED, not UPDATED" || bad "status '$(jget "$RESULT" status)'"
grep -q 'health unknown' "$RESULT" && ok "detail names the unknown health" || bad "detail missing"
[ ! -e "$LEASE" ] && ok "lease released" || bad "lease left behind"

# ── Case 10: lock released only AFTER node_modules is restored ──────────────
echo "Case 10: abort in the node_modules window -> restore first, release last"
INST="$WORK/install-10"; new_install "$INST"; rm -f "$LEASE" "$RESULT" "$WORK/order.log"
mkdir -p "$INST/node_modules" && echo marker > "$INST/node_modules/marker" && echo node_modules >> "$INST/.git/info/exclude"
run_updater "$INST" "$WORK/out-10.txt" $(lock_env) NPM_CI_FAIL=1 ORDER_LOG="$WORK/order.log"; RC10=$?
[ "$RC10" -ne 0 ] && ok "failed npm ci fails the run" || bad "run succeeded despite npm ci failure"
[ -f "$INST/node_modules/marker" ] && ok "previous node_modules restored" || bad "node_modules not restored"
if [ -n "${ONB_LOCK_LIB:-}" ]; then ok "release-order log skipped (real helper has no hook); restore and lease checks cover it"; elif grep -q 'node_modules.prev=gone' "$WORK/order.log" 2>/dev/null; then ok "lock was released after the restore (no .prev left at release)"; else bad "release order: $(cat "$WORK/order.log" 2>/dev/null)"; fi
[ "$(jget "$RESULT" status)" = "FAILED" ] && ok "result FAILED" || bad "status '$(jget "$RESULT" status)'"
[ ! -e "$LEASE" ] && ok "lease released" || bad "lease left behind"

# ── Case 7: the ask-first flow is gone, docs match the new schedule ─────────
echo "Case 7: ask flow removed, DEPLOYMENT.md documents Tue/Fri/Sun"
[ ! -e "$REPO_ROOT/cron-prompt.txt" ] && ok "cron-prompt.txt is gone" || bad "cron-prompt.txt still shipped"
if grep -rIl "cron-prompt.txt" "$REPO_ROOT/update.sh" "$REPO_ROOT/check-updates.sh" "$REPO_ROOT/config" "$REPO_ROOT/scripts/install" 2>/dev/null | grep -q .; then
  bad "something still references cron-prompt.txt"; else ok "no script or config references cron-prompt.txt"; fi
D="$REPO_ROOT/DEPLOYMENT.md"
grep -q 'Automated Update Path (Tuesday, Friday, Sunday 2:30 AM Eastern)' "$D" && ok "DEPLOYMENT.md section retitled" || bad "section title missing"
grep -q '2:15 AM Eastern' "$D" && grep -q 'cancel' "$D" && ok "DEPLOYMENT.md documents the 2:15 notice and cancel" || bad "notice/cancel undocumented"
grep -q 'Automated Sunday Update Path' "$D" && bad "old Sunday-only title remains" || ok "old Sunday-only title gone"
grep -q 'exits \*\*75\*\*' "$D" && ok "DEPLOYMENT.md documents exit 75" || bad "exit 75 undocumented"
grep -q 'cron agent' "$REPO_ROOT/check-updates.sh" && bad "check-updates.sh still describes a cron agent" || ok "check-updates.sh no longer describes a cron agent"

echo ""
echo "update-lock-and-report: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
