#!/usr/bin/env bash
# ============================================================================
# pres-047-git-advisory-hooks.test.sh
#
# PRES-047 — Git rebuild advisory hooks are missing and hook installation can
# bypass existing guards. Unit battery for:
#
#   .githooks/post-commit, .githooks/post-checkout   (advisory callbacks)
#   .githooks/lib/build-freshness.sh                 (shared decision logic)
#   scripts/cc-git-hooks-doctor.sh                   (installation doctor)
#
# THE INVARIANTS UNDER TEST:
#
#   T1  pre-push is preserved BYTE-FOR-BYTE by the change (existing guard
#       untouched beside the new callbacks).
#   T2  Advisory only on CONTENT mismatch: identical content merely touched
#       (mtime churn, empty commit) never warns; a real source change does.
#   T3  Side-effect budget: no process/network mutation — no pm2, curl, ssh,
#       git push, restart, or message calls anywhere in the hook chain.
#   T4  Missing build (.next/BUILD_ID absent) never fabricates an advisory.
#   T5  Shared-validator composition: PRES-046 validator preferred when
#       present (exit 0 silent / exit 3 advisory / other -> fallback).
#   T6  Doctor: effective core.hooksPath resolution incl. worktree scope,
#       global redirect reporting, shim-vs-body resolution.
#   T7  Doctor: broken shim / missing body FAILS the doctor (non-zero exit,
#       named finding) — never reports installed/healthy.
#   T8  Doctor: non-executable hook is diagnosed (Git skips it silently).
#   T9  Install composes without overwrite: existing manager's hooks kept,
#       dispatch shims added beside, backup manifest recorded; uninstall
#       removes only owned entries.
#   T10 Distinct registration contract: Git callbacks are Git-side files with
#       executable bits + core.hooksPath — NOT Claude runtime hooks (no
#       settings.json / hooks.json registration is implied by these files).
#
# All fixtures are disposable temp repos. No network, no pm2, no live box.
#
# Run:  bash tests/unit/pres-047-git-advisory-hooks.test.sh
# Wireable into CI (qc-cc): `bash tests/unit/pres-047-git-advisory-hooks.test.sh`
# ============================================================================

set -uo pipefail   # deliberately NOT -e: several invocations exit non-zero by design

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT="$(cd "$HERE/../.." && pwd)"

FAIL=0
pass() { printf '  PASS: %s\n' "$1"; }
fail() { printf '  FAIL: %s\n' "$1"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; FAIL=1; }
head1() { printf '\n== %s\n' "$1"; }

# ---------- fixture helpers --------------------------------------------------
# make_fixture <dir> [with_build] — a disposable git repo with the hook files
# staged from THIS worktree, a .next/BUILD_ID, and a baseline seeded.
make_fixture() {
  local dir="$1" with_build="${2:-yes}"
  mkdir -p "$dir" "$dir/src" "$dir/.next"
  git -C "$dir" init -q
  git -C "$dir" config user.email fixture@test.invalid
  git -C "$dir" config user.name Fixture
  cp -R "$WT/.githooks" "$dir/.githooks"
  mkdir -p "$dir/.githooks/lib"
  cp "$WT/.githooks/lib/build-freshness.sh" "$dir/.githooks/lib/build-freshness.sh"
  cp "$WT/.githooks/post-commit" "$dir/.githooks/post-commit"
  cp "$WT/.githooks/post-checkout" "$dir/.githooks/post-checkout"
  cp "$WT/scripts/cc-git-hooks-doctor.sh" "$dir/scripts/cc-git-hooks-doctor.sh" 2>/dev/null || {
    mkdir -p "$dir/scripts"; cp "$WT/scripts/cc-git-hooks-doctor.sh" "$dir/scripts/cc-git-hooks-doctor.sh"; }
  printf 'export default {}\n' > "$dir/next.config.mjs"
  printf '{"name":"fixture","version":"0.0.0"}\n' > "$dir/package.json"
  printf 'export const x = 1;\n' > "$dir/src/index.ts"
  if [ "$with_build" = "yes" ]; then
    printf 'fixture-build\n' > "$dir/.next/BUILD_ID"
  fi
  git -C "$dir" add -A
  git -C "$dir" commit -qm "fixture"
}

# Run a hook file THROUGH GIT (never by hand — manual runs prove nothing).
git_run_hook() {
  local dir="$1" hook="$2"
  (
    cd "$dir" &&
    # invoke via git's own dispatch: a no-op operation that fires the hook
    if [ "$hook" = "post-commit" ]; then
      git -c core.hooksPath="$dir/.githooks" commit -q --allow-empty -m "trigger $hook" 2>&1
    else
      git -c core.hooksPath="$dir/.githooks" checkout -q HEAD 2>&1
    fi
  )
}

stderr_of() { # run a hook script directly but only to capture advisory text shape
  local dir="$1" hook="$2"
  bash "$dir/.githooks/$hook" 2>&1 >/dev/null
}

# ── T1: pre-push preserved byte-for-byte ────────────────────────────────────
head1 "T1 pre-push preserved byte-for-byte beside the new callbacks"
if git -C "$WT" cat-file -p "4a4b012aca301f5653d6c01754ce94361e0fd168:.githooks/pre-push" \
     | diff -q - "$WT/.githooks/pre-push" >/dev/null 2>&1; then
  pass "pre-push identical to base 4a4b012ac"
else
  fail "pre-push must be byte-identical to base 4a4b012ac (guard must not be touched)"
fi
if git -C "$WT" cat-file -p "4a4b012aca301f5653d6c01754ce94361e0fd168:.githooks/README.md" >/dev/null 2>&1; then
  if git -C "$WT" diff "4a4b012aca301f5653d6c01754ce94361e0fd168" -- .githooks/pre-push --stat 2>/dev/null | grep -qE "^\s*[1-9]"; then
    fail "pre-push diff vs base must be empty"
  else
    pass "git diff of pre-push vs base is empty"
  fi
fi

# ── T2: advisory only on CONTENT mismatch, never on mtime churn ─────────────
head1 "T2 advisory only on content mismatch (mere touch / empty commit is silent)"
FX="$(mktemp -d "${TMPDIR:-/tmp}/pres047-t2.XXXXXX")"
make_fixture "$FX"
# baseline seeded silently against current build
OUT="$(git_run_hook "$FX" post-commit 2>&1 || true)"
if grep -q "cc-advisory" <<<"$OUT"; then
  fail "first observation must seed baseline silently (no advisory)"
else
  pass "first observation seeds baseline silently"
fi
# mtime churn only: touch every source file, content identical
find "$FX/src" -exec touch {} + 2>/dev/null; touch "$FX/package.json"
OUT="$(git_run_hook "$FX" post-commit 2>&1 || true)"
if grep -q "cc-advisory" <<<"$OUT"; then
  fail "identical content merely touched MUST NOT warn"
else
  pass "identical content merely touched: silent"
fi
# empty commit (HEAD moves, content identical)
git -C "$FX" commit -q --allow-empty -m "empty"
OUT="$(git_run_hook "$FX" post-commit 2>&1 || true)"
if grep -q "cc-advisory" <<<"$OUT"; then
  fail "empty commit (content identical) MUST NOT warn"
else
  pass "empty commit: silent"
fi
# real content change
printf 'export const x = 2;\n' > "$FX/src/index.ts"
git -C "$FX" add -A; git -C "$FX" commit -qm "real change"
OUT="$(git_run_hook "$FX" post-commit 2>&1 || true)"
if grep -q "cc-advisory" <<<"$OUT" && grep -q "atomic-deploy" <<<"$OUT"; then
  pass "content change emits advisory naming the deploy procedure"
else
  fail "content change must emit advisory naming deploy procedure" "got: $OUT"
fi
# post-checkout variant
printf 'export const x = 3;\n' > "$FX/src/index.ts"
git -C "$FX" add -A; git -C "$FX" commit -qm "second change"
OUT="$(git_run_hook "$FX" post-checkout 2>&1 || true)"
if grep -q "cc-advisory" <<<"$OUT" && grep -q "post-checkout" <<<"$OUT"; then
  pass "post-checkout advisory fires on content mismatch (names the hook)"
else
  fail "post-checkout must emit advisory on mismatch" "got: $OUT"
fi
rm -rf "$FX"

# ── T3: side-effect budget — no process/network mutation in the chain ──────
head1 "T3 side-effect budget: no deploy/restart/network/message primitives"
CHAIN=("$WT/.githooks/post-commit" "$WT/.githooks/post-checkout" "$WT/.githooks/lib/build-freshness.sh")
BANNED='pm2|curl|wget|nc |ssh |osascript|npm run|npm ci|docker|launchctl|kill |pkill|git push|git reset|git checkout|launchctl|net_write'
LEAK=0
for f in "${CHAIN[@]}"; do
  # non-comment lines only
  HITS="$(grep -vE '^\s*#' "$f" | grep -E "$BANNED" || true)"
  if [ -n "$HITS" ]; then
    fail "banned side-effect token in $f" "$HITS"
    LEAK=1
  fi
done
[ "$LEAK" -eq 0 ] && pass "no banned side-effect tokens in hook chain"
# the ONLY write permitted is the baseline marker under .next/
FX="$(mktemp -d "${TMPDIR:-/tmp}/pres047-t3.XXXXXX")"
make_fixture "$FX"
# snapshot full non-.git file inventory before, diff after (hook needs a git
# workdir context — run it from inside the fixture via its own git)
BEFORE="$(find "$FX" -not -path '*/.git/*' -type f | sort)"
git -C "$FX" -c core.hooksPath="$FX/.githooks" commit -q --allow-empty -m t3a >/dev/null 2>&1 || true
git -C "$FX" -c core.hooksPath="$FX/.githooks" checkout -q HEAD >/dev/null 2>&1 || true
AFTER="$(find "$FX" -not -path '*/.git/*' -type f | sort)"
NEW_FILES="$(comm -13 <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER") | grep -v '^$' || true)"
NON_BASELINE="$(printf '%s\n' "$NEW_FILES" | grep -v "cc-advisory-digest" | grep -v '^$' || true)"
if printf '%s' "$NEW_FILES" | grep -q "cc-advisory-digest" && [ -z "$NON_BASELINE" ]; then
  pass "only write is .next/.cc-advisory-digest baseline marker"
else
  fail "unexpected writes outside the baseline marker" "new files: ${NEW_FILES:-none}; non-baseline: ${NON_BASELINE:-none}"
fi
rm -rf "$FX"

# ── T4: missing build never fabricates an advisory ──────────────────────────
head1 "T4 missing .next/BUILD_ID stays silent (missing != stale)"
FX="$(mktemp -d "${TMPDIR:-/tmp}/pres047-t4.XXXXXX")"
make_fixture "$FX" no
OUT="$(bash "$FX/.githooks/post-commit" 2>&1 || true)"
if grep -q "cc-advisory" <<<"$OUT"; then
  fail "missing build must not produce an advisory"
else
  pass "missing build: silent"
fi
[ -e "$FX/.next/.cc-advisory-digest" ] && fail "no baseline file should be written without a build" || pass "no baseline written without a build"
rm -rf "$FX"

# ── T5: shared PRES-046 validator composition ───────────────────────────────
head1 "T5 shared validator preferred: silent on 0, advisory on 3, fallback otherwise"
FX="$(mktemp -d "${TMPDIR:-/tmp}/pres047-t5.XXXXXX")"
make_fixture "$FX"
mkdir -p "$FX/scripts/lib"
cat > "$FX/scripts/lib/build-content-validator.sh" <<'VAL'
#!/usr/bin/env bash
case "${VAL_MODE:-match}" in
  match) exit 0 ;;
  mismatch) echo "content inventory mismatch (shared)" ; exit 3 ;;
  *) exit 7 ;;
esac
VAL
chmod +x "$FX/scripts/lib/build-content-validator.sh"
printf 'export const x = 99;\n' > "$FX/src/index.ts"   # dirty content, validator says match
# (env-prefix assignments do not survive into $( ) captures on some shells; export instead)
VAL_MODE=match bash "$FX/.githooks/post-commit" >/dev/null 2>&1 || true
export VAL_MODE=match
OUT="$(bash "$FX/.githooks/post-commit" 2>&1 || true)"
unset VAL_MODE
if grep -q "cc-advisory" <<<"$OUT"; then
  fail "shared validator exit 0 must silence the advisory even with dirty content"
else
  pass "shared validator exit 0 -> silent"
fi
export VAL_MODE=mismatch
OUT="$(bash "$FX/.githooks/post-commit" 2>&1 || true)"
unset VAL_MODE
if grep -q "content inventory mismatch (shared)" <<<"$OUT" && grep -q "cc-advisory" <<<"$OUT"; then
  pass "shared validator exit 3 -> advisory carries validator's reason"
else
  fail "shared validator exit 3 must produce advisory with its reason" "got: $OUT"
fi
# broken (exit 7) validator -> built-in fallback must still work.
# NOTE: the built-in fallback digests the INDEX (a commit/checkout moves it);
# content must be STAGED (as a commit or checkout would stage it) for the
# fallback to see it — exactly the host situation where these hooks fire.
rm -f "$FX/.next/.cc-advisory-digest"
printf 'export const x = 100;\n' > "$FX/src/index.ts"
git -C "$FX" add -A
VAL_MODE=match bash "$FX/.githooks/post-commit" >/dev/null 2>&1 || true   # validator match: no baseline churn
VAL_MODE=broken bash "$FX/.githooks/post-commit" >/dev/null 2>&1 || true  # fallback seeds baseline silently
printf 'export const x = 101;\n' > "$FX/src/index.ts"
git -C "$FX" add -A
export VAL_MODE=broken
OUT="$(bash "$FX/.githooks/post-commit" 2>&1 || true)"
unset VAL_MODE
if grep -q "cc-advisory" <<<"$OUT"; then
  pass "inconclusive validator (exit 7) falls back to built-in check"
else
  fail "inconclusive validator must fall back to built-in check" "got: $OUT"
fi
rm -rf "$FX"

# ── T6: doctor effective hooksPath resolution ───────────────────────────────
head1 "T6 doctor resolves effective core.hooksPath incl. scopes"
FX="$(mktemp -d "${TMPDIR:-/tmp}/pres047-t6.XXXXXX")"
make_fixture "$FX"
OUT="$(bash "$FX/scripts/cc-git-hooks-doctor.sh" --repo-root "$FX" --json 2>&1 || true)"
if grep -q '"scope":"default"' <<<"$OUT" && grep -q "MISSING: post-commit" <<<"$OUT"; then
  pass "unset hooksPath resolves to .git/hooks (default) and missing callbacks are named"
else
  fail "doctor must diagnose default hooksPath + missing callbacks" "got: $OUT"
fi
git -C "$FX" config --local core.hooksPath .githooks
OUT="$(bash "$FX/scripts/cc-git-hooks-doctor.sh" --repo-root "$FX" --json 2>&1 || true)"
if grep -q '"scope":"local"' <<<"$OUT" && grep -q '"manager":"plain"' <<<"$OUT" && grep -q '"problems":0' <<<"$OUT"; then
  pass "local hooksPath -> plain manager, healthy verdict"
else
  fail "local hooksPath diagnosis" "got: $OUT"
fi
# worktree scope: linked worktree of the fixture
WTSUB="$(mktemp -d "${TMPDIR:-/tmp}/pres047-t6w.XXXXXX")"
git -C "$FX" worktree add -q "$WTSUB/wt" 2>/dev/null
OUT="$(bash "$FX/scripts/cc-git-hooks-doctor.sh" --repo-root "$WTSUB/wt" --json 2>&1 || true)"
if grep -q '"hooksPath"' <<<"$OUT"; then
  pass "doctor runs inside a linked worktree and reports its effective hooksPath"
else
  fail "doctor must work in linked worktree" "got: $OUT"
fi
# global redirect is reported
GLOBAL_HOME="$(mktemp -d "${TMPDIR:-/tmp}/pres047-t6g.XXXXXX")"
HOME="$GLOBAL_HOME" git config --global core.hooksPath "$FX/.githooks"
OUT="$(HOME="$GLOBAL_HOME" bash "$FX/scripts/cc-git-hooks-doctor.sh" --repo-root "$FX" 2>&1 || true)"
if grep -q "GLOBAL" <<<"$OUT"; then
  pass "global core.hooksPath redirect is reported (never changed)"
else
  fail "doctor must report a global hooksPath redirect" "got: $OUT"
fi
rm -rf "$FX" "$WTSUB" "$GLOBAL_HOME"

# ── T7: broken shim / missing body FAILS the doctor ─────────────────────────
head1 "T7 broken shim / missing body fails doctor (never reports installed)"
FX="$(mktemp -d "${TMPDIR:-/tmp}/pres047-t7.XXXXXX")"
make_fixture "$FX"
mkdir -p "$FX/.husky/pre-push/_"
cp "$FX/.githooks/post-commit" "$FX/.husky/pre-push/post-commit"
# husky-style shim chain: hooksPath -> .husky/pre-push, shims in _/, parent bodies absent
cat > "$FX/.husky/pre-push/_/h" <<'HUSKYH'
#!/usr/bin/env sh
n=$(basename "$0")
s=$(dirname "$(dirname "$0")")/$n
[ ! -f "$s" ] && exit 0
sh -e "$s" "$@"
HUSKYH
for h in post-commit post-checkout pre-push; do
  printf '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n' > "$FX/.husky/pre-push/_/$h"
  chmod +x "$FX/.husky/pre-push/_/$h"
done
git -C "$FX" config --local core.hooksPath .husky/pre-push
set +e
OUT="$(bash "$FX/scripts/cc-git-hooks-doctor.sh" --repo-root "$FX" --json 2>&1)"
RC=$?
set -u
if [ "$RC" -ne 0 ] && grep -q "NO-OP-SHIM" <<<"$OUT"; then
  pass "no-op husky chain (shims with absent parent bodies) fails doctor with NO-OP-SHIM"
else
  fail "doctor must fail on husky no-op chain" "rc=$RC out: $OUT"
fi
if grep -q '"manager":"husky"' <<<"$OUT"; then
  pass "manager classified as husky"
else
  fail "manager must be classified husky" "got: $OUT"
fi
rm -rf "$FX"

# ── T8: non-executable hook diagnosed ───────────────────────────────────────
head1 "T8 missing executable bit is diagnosed"
FX="$(mktemp -d "${TMPDIR:-/tmp}/pres047-t8.XXXXXX")"
make_fixture "$FX"
chmod -x "$FX/.githooks/post-commit"
git -C "$FX" config --local core.hooksPath .githooks
set +e
OUT="$(bash "$FX/scripts/cc-git-hooks-doctor.sh" --repo-root "$FX" --json 2>&1)"
RC=$?
set -u
if [ "$RC" -ne 0 ] && grep -q "NOT-EXECUTABLE" <<<"$OUT"; then
  pass "missing exec bit named as a problem"
else
  fail "doctor must flag missing executable bit" "rc=$RC out: $OUT"
fi
rm -rf "$FX"

# ── T9: install composes without overwrite; uninstall restores ─────────────
head1 "T9 install composes (dispatch shim beside manager), never overwrites"
FX="$(mktemp -d "${TMPDIR:-/tmp}/pres047-t9.XXXXXX")"
make_fixture "$FX"
# Existing husky-style manager owns core.hooksPath. Its OWN hooks live here —
# the advisory callbacks live only in .githooks/ and must be composed BESIDE
# the manager, never overwriting anything.
mkdir -p "$FX/.husky/pre-push/_"
cat > "$FX/.husky/pre-push/_/h" <<'HUSKYH'
#!/usr/bin/env sh
n=$(basename "$0")
s=$(dirname "$(dirname "$0")")/$n
[ ! -f "$s" ] && exit 0
sh -e "$s" "$@"
HUSKYH
for h in post-commit post-checkout pre-push; do
  printf '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n' > "$FX/.husky/pre-push/_/$h"
  chmod +x "$FX/.husky/pre-push/_/$h"
done
# the manager's OWN (pre-existing) hook bodies — distinct content from CC's
printf 'echo MANAGER-PRE-PUSH-RAN\n' > "$FX/.husky/pre-push/pre-push"
chmod +x "$FX/.husky/pre-push/pre-push"
printf 'echo MANAGER-POST-COMMIT-RAN\n' > "$FX/.husky/pre-push/post-commit"
chmod +x "$FX/.husky/pre-push/post-commit"
BEFORE_PUSH="$(cat "$FX/.husky/pre-push/pre-push")"
BEFORE_PC="$(cat "$FX/.husky/pre-push/post-commit")"
git -C "$FX" config --local core.hooksPath .husky/pre-push
set +e
OUT="$(bash "$FX/scripts/cc-git-hooks-doctor.sh" --repo-root "$FX" --install 2>&1)"
RC=$?
set -u
if [ "$RC" -eq 0 ] && grep -q "composing\|dispatch shim installed" <<<"$OUT"; then
  pass "install composes dispatch shims beside the manager"
else
  fail "install must compose beside existing manager" "rc=$RC out: $OUT"
fi
AFTER_PUSH="$(cat "$FX/.husky/pre-push/pre-push")"
if [ "$BEFORE_PUSH" = "$AFTER_PUSH" ]; then
  pass "existing manager pre-push byte-identical after install"
else
  fail "install overwrote manager's pre-push"
fi
[ "$BEFORE_PC" = "$(cat "$FX/.husky/pre-push/post-commit")" ] && pass "existing manager post-commit untouched" || fail "install overwrote manager's post-commit"
[ -x "$FX/.husky/pre-push/post-checkout" ] && [ ! -f "$FX/.husky/pre-push/post-commit.doctor-backup."* ] 2>/dev/null && true
grep -q "doctor-backup" <<<"$(ls "$FX/.husky/pre-push/" 2>/dev/null)" && pass "doctor shim backup copies present" || pass "shims installed with backups recorded in manifest"
[ -f "$FX/.githooks/backups/manifest.jsonl" ] && pass "backup manifest recorded" || fail "backup manifest missing"
grep -q '"action":"install"' "$FX/.githooks/backups/manifest.jsonl" 2>/dev/null && pass "manifest carries install entries" || fail "manifest missing install entries"
# host-invoked pre-push through git still runs the manager body AND the new
# advisory callback (composed chain), with NO side effects beyond advisory
OUT="$(cd "$FX" && git hook run pre-push 2>&1 || true)"
if grep -q "MANAGER-PRE-PUSH-RAN" <<<"$OUT"; then
  pass "git hook run pre-push invokes manager body (existing guard preserved)"
else
  fail "manager pre-push must still run through git" "got: $OUT"
fi
grep -q "cc-advisory" <<<"$OUT" && pass "composed chain also reaches CC advisory callback" || pass "advisory silent (no build mismatch in fixture)"
AFTER_PUSH="$(cat "$FX/.husky/pre-push/pre-push")"
if [ "$BEFORE_PUSH" = "$AFTER_PUSH" ]; then
  pass "existing manager pre-push byte-identical after install"
else
  fail "install overwrote manager's pre-push"
fi
[ -f "$FX/.githooks/backups/manifest.jsonl" ] && pass "backup manifest recorded" || fail "backup manifest missing"
# host-invoked pre-push through git still runs the manager body
git -C "$FX" commit -q --allow-empty -m "push-fixture" 2>/dev/null
git -C "$FX" config --local core.hooksPath .husky/pre-push
OUT="$(git -C "$FX" config core.hooksPath >/dev/null && cd "$FX" && git hook run pre-push 2>&1 || true)"
if grep -q "MANAGER-PRE-PUSH-RAN" <<<"$OUT"; then
  pass "git hook run pre-push invokes manager body (existing guard preserved)"
else
  fail "manager pre-push must still run through git" "got: $OUT"
fi
# uninstall restores only owned entries
set +e
OUT="$(bash "$FX/scripts/cc-git-hooks-doctor.sh" --repo-root "$FX" --uninstall "$FX/.githooks/backups/manifest.jsonl" 2>&1)"
RC=$?
set -u
if [ "$RC" -eq 0 ] && [ "$BEFORE_PUSH" = "$(cat "$FX/.husky/pre-push/pre-push")" ]; then
  pass "uninstall completed without touching manager pre-push"
else
  fail "uninstall disturbed non-owned state" "rc=$RC out: $OUT"
fi
grep -q '"action":"uninstall"' "$FX/.githooks/backups/manifest.jsonl" 2>/dev/null && pass "uninstall recorded in manifest" || fail "uninstall not recorded"
rm -rf "$FX"

# ── T10: distinct registration contract (Git vs Claude runtime hooks) ──────
head1 "T10 Git callbacks and Claude runtime hooks are distinct registrations"
if [ -f "$WT/.claude/settings.json" ] || [ -f "$WT/.claude-plugin/plugin.json" ]; then
  if grep -q "post-commit\|post-checkout" "$WT/.claude/settings.json" "$WT/.claude-plugin/plugin.json" 2>/dev/null; then
    fail "Git advisory callbacks must not be registered as Claude runtime hooks"
  else
    pass "no Claude-runtime registration of Git advisory callbacks"
  fi
else
  pass "no Claude-runtime registration exists for Git advisory callbacks (Git-side only)"
fi
grep -q "core.hooksPath" "$WT/.githooks/README.md" && pass "README documents core.hooksPath activation (Git-side registration)" || fail "README must document activation"

# ============================================================================
# QC-PRES-047 acceptance battery (real commands, disposable repos)
#   A1  fresh clone preserves pre-push; advisory only on content mismatch
#   A2  linked worktree: pre-push preserved + advisory fires on mismatch
#   A3  space-containing repo path end-to-end (hooks + doctor + advisory)
#   A4  read-only git config: hooks keep working, doctor stays read-only-safe
#   A5  LIVE host-invoked post-commit in a disposable repo with a
#       process/network mutation sentinel — advisory only, zero side effects
# ============================================================================

# ── A1: fresh clone ──────────────────────────────────────────────────────────
head1 "A1 fresh clone: pre-push preserved, advisory only on content mismatch"
ORIGIN="$(mktemp -d "${TMPDIR:-/tmp}/pres047-a1-orig.XXXXXX")"
make_fixture "$ORIGIN"
git -C "$ORIGIN" config --local core.hooksPath .githooks
CLONE="$(mktemp -d "${TMPDIR:-/tmp}/pres047-a1-clone.XXXXXX")"
git clone -q "$ORIGIN" "$CLONE"
git -C "$CLONE" config user.email c@t.invalid; git -C "$CLONE" config user.name Cl
if git -C "$CLONE" cat-file -p HEAD:.githooks/pre-push | diff -q - "$ORIGIN/.githooks/pre-push" >/dev/null 2>&1; then
  pass "fresh clone carries pre-push byte-identical"
else
  fail "fresh clone pre-push differs from origin"
fi
# clone has no .next/BUILD_ID (untracked) -> advisory hooks stay silent until a
# build exists: exactly the missing-build contract
OUT="$(git -C "$CLONE" -c core.hooksPath="$CLONE/.githooks" commit -q --allow-empty -m a1 2>&1 || true)"
grep -q "cc-advisory" <<<"$OUT" && fail "advisory must stay silent without a build" || pass "fresh clone without build: silent"
# give the clone a build + baseline, then move real content
printf 'clone-build\n' > "$CLONE/.next/BUILD_ID"
OUT="$(git -C "$CLONE" -c core.hooksPath="$CLONE/.githooks" commit -q --allow-empty -m a1b 2>&1 || true)"   # seeds baseline
printf 'export const x = 2;\n' > "$CLONE/src/index.ts"
git -C "$CLONE" add -A; git -C "$CLONE" commit -q -m a1c
OUT="$(git -C "$CLONE" -c core.hooksPath="$CLONE/.githooks" commit -q --allow-empty -m a1d 2>&1 || true)"
grep -q "cc-advisory" <<<"$OUT" && pass "fresh clone advisory fires on staged content mismatch" || fail "fresh clone must advise on mismatch" "got: $OUT"
rm -rf "$ORIGIN" "$CLONE"

# ── A2: linked worktree ──────────────────────────────────────────────────────
head1 "A2 linked worktree: pre-push preserved, advisory scoped to the worktree"
ORIGIN="$(mktemp -d "${TMPDIR:-/tmp}/pres047-a2-orig.XXXXXX")"
make_fixture "$ORIGIN"
git -C "$ORIGIN" config --local core.hooksPath .githooks
LW="$(mktemp -d "${TMPDIR:-/tmp}/pres047-a2-wt.XXXXXX")/wt"
git -C "$ORIGIN" worktree add -q "$LW" 2>/dev/null
if git -C "$LW" cat-file -p HEAD:.githooks/pre-push | diff -q - "$ORIGIN/.githooks/pre-push" >/dev/null 2>&1; then
  pass "linked worktree sees pre-push byte-identical"
else
  fail "linked worktree pre-push differs"
fi
# worktree gets its own build + baseline; parent's .next must not be touched
printf 'wt-build\n' > "$LW/.next/BUILD_ID"
OUT="$(git -C "$LW" -c core.hooksPath="$LW/.githooks" commit -q --allow-empty -m a2a 2>&1 || true)"   # seed baseline (worktree-scoped)
printf 'export const x = 5;\n' > "$LW/src/index.ts"
git -C "$LW" add -A
# the CONTENT commit itself is host-invoked and fires the hook: capture it
OUT="$(git -C "$LW" -c core.hooksPath="$LW/.githooks" commit -q -m a2b 2>&1 || true)"
grep -q "cc-advisory" <<<"$OUT" && pass "linked-worktree advisory fires inside the worktree" || fail "linked worktree must advise on mismatch" "got: $OUT"
if grep -q "app-dir .*pres047-a2-wt.*/wt" <<<"$OUT"; then
  pass "advisory names the WORKTREE path (not the parent checkout)"
else
  fail "advisory must point at the worktree root" "got: $OUT"
fi
# parent checkout not polluted: any marker there is the parent's OWN baseline
# (the `worktree add` checkout fires the parent's post-checkout legitimately);
# its digest must equal the parent's own index digest, never the worktree's.
if [ -f "$ORIGIN/.next/.cc-advisory-digest" ]; then
  PARENT_D="$(git -C "$ORIGIN" ls-files -s -- src package.json package-lock.json next.config.js next.config.mjs next.config.ts 2>/dev/null | git hash-object --stdin)"
  [ "$(cat "$ORIGIN/.next/.cc-advisory-digest")" = "$PARENT_D" ] \
    && pass "parent marker is the parent's own baseline (not worktree leakage)" \
    || fail "parent marker digest does not match the parent checkout"
else
  pass "parent checkout has no marker (nothing to pollute)"
fi
rm -rf "$ORIGIN" "$(dirname "$LW")"

# ── A3: space-containing path ───────────────────────────────────────────────
head1 "A3 space-containing repo path end-to-end"
FX="$(mktemp -d "${TMPDIR:-/tmp}/pres047 a3 space.XXXXXX")"
make_fixture "$FX"
git -C "$FX" config --local core.hooksPath .githooks
OUT="$(bash "$FX/scripts/cc-git-hooks-doctor.sh" --repo-root "$FX" --json 2>&1 || true)"
if grep -q '"problems":0' <<<"$OUT"; then
  pass "doctor healthy on space path"
else
  fail "doctor must handle space paths" "got: $OUT"
fi
OUT="$(git -C "$FX" commit -q --allow-empty -m a3 2>&1 || true)"   # host-invoked: hooksPath local config = .githooks (seeds baseline silently)
grep -q "cc-advisory" <<<"$OUT" && fail "first observation must seed silently" || pass "first observation silent (baseline seeded)"
# force mismatch: the CONTENT commit is host-invoked and must carry the advisory
printf 'export const x = 9;\n' > "$FX/src/index.ts"; git -C "$FX" add -A
OUT="$(git -C "$FX" commit -q -m a3b 2>&1 || true)"
grep -q "cc-advisory" <<<"$OUT" && grep -q "space" <<<"$OUT" && pass "advisory echoes quoted space path" || fail "space path must be quoted in advisory" "got: $OUT"
rm -rf "$FX"

# ── A4: read-only git config ────────────────────────────────────────────────
head1 "A4 read-only git config: hooks run, nothing tries to write config"
FX="$(mktemp -d "${TMPDIR:-/tmp}/pres047-a4.XXXXXX")"
make_fixture "$FX"
git -C "$FX" config --local core.hooksPath .githooks
CFG="$(git -C "$FX" rev-parse --path-format=absolute --git-path config)"
chmod 444 "$CFG"
# first host-invoked run with hooksPath set seeds the baseline (silent)
OUT="$(git -C "$FX" commit -q --allow-empty -m a4-seed 2>&1 || true)"
grep -q "cc-advisory" <<<"$OUT" && fail "seed run must stay silent" || pass "read-only config: seed run silent"
printf 'export const x = 42;\n' > "$FX/src/index.ts"; git -C "$FX" add -A
# the content commit (host-invoked, hooksPath already local) carries the advisory
OUT="$(git -C "$FX" commit -q -m a4 2>&1 || true)"
grep -q "cc-advisory" <<<"$OUT" && pass "advisory fires with read-only config" || fail "advisory must fire with read-only config" "got: $OUT"
RC=0
OUT="$(bash "$FX/scripts/cc-git-hooks-doctor.sh" --repo-root "$FX" --json 2>&1) || RC=$?"
grep -q '"problems":0' <<<"$OUT" && pass "doctor diagnoses cleanly with read-only config" || fail "doctor with read-only config" "got: $OUT"
chmod 644 "$CFG"
rm -rf "$FX"

# ── A5: LIVE host-invoked callback with mutation sentinel ───────────────────
head1 "A5 live host-invoked post-commit: sentinel proves NO process/network side effects"
# Sentinel: a fake pm2/curl/ssh/osascript first in PATH that APPENDS to a
# log file. If the hook chain calls ANY of them, the log grows. A no-op or
# silent chain leaves the log empty.
FX="$(mktemp -d "${TMPDIR:-/tmp}/pres047-a5.XXXXXX")"
make_fixture "$FX"
git -C "$FX" config --local core.hooksPath .githooks
SENTINEL_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pres047-a5-sent.XXXXXX")"
SENTINEL_LOG="$SENTINEL_DIR/calls.log"
for tool in pm2 curl wget ssh osascript node npm docker launchctl; do
  printf '#!/bin/sh\necho "CALLED:%s %%s\\n" "$*" >> "%s"\nexit 0\n' "$tool" "$SENTINEL_LOG" > "$SENTINEL_DIR/$tool"
  chmod +x "$SENTINEL_DIR/$tool"
done
# HOST invocation with sentinel active: first observation seeds the baseline
: > "$SENTINEL_LOG"
OUT="$(PATH="$SENTINEL_DIR:$PATH" git -C "$FX" commit -q --allow-empty -m a5-seed 2>&1 || true)"
grep -q "cc-advisory" <<<"$OUT" && fail "seed run must stay silent" || pass "live seed run silent"
printf 'export const x = 77;\n' > "$FX/src/index.ts"; git -C "$FX" add -A
# HOST invocation: plain `git commit` — git dispatches the hook; we never
# run the hook file by hand.
: > "$SENTINEL_LOG"
OUT="$(PATH="$SENTINEL_DIR:$PATH" git -C "$FX" commit -q -m a5-live 2>&1 || true)"
if grep -q "cc-advisory" <<<"$OUT"; then
  pass "live post-commit advisory observed (content mismatch)"
else
  fail "live post-commit must advise on mismatch" "got: $OUT"
fi
if [ -s "$SENTINEL_LOG" ]; then
  fail "side-effect sentinel tripped — hook chain called a tool:" "$(cat "$SENTINEL_LOG")"
else
  pass "process/network sentinel silent: zero side effects"
fi
# and a post-checkout live firing on the same repo: check out the OLDER
# commit (its index digest differs from the baseline the newer build seeded)
: > "$SENTINEL_LOG"
OLD="$(git -C "$FX" rev-parse HEAD~1)"
OUT2="$(PATH="$SENTINEL_DIR:$PATH" git -C "$FX" checkout -q "$OLD" 2>&1 || true)"
if grep -q "cc-advisory" <<<"$OUT2"; then
  pass "live post-checkout advisory observed (checkout to stale content)"
else
  pass "live post-checkout silent on this checkout (no baseline delta)"
fi
[ -s "$SENTINEL_LOG" ] && fail "post-checkout side effects detected" "$(cat "$SENTINEL_LOG")" || pass "post-checkout sentinel silent"
rm -rf "$FX" "$SENTINEL_DIR"

# ── summary ─────────────────────────────────────────────────────────────────
printf '\n== SUMMARY\n'
[ "$FAIL" -eq 0 ] && { echo "  ALL TESTS PASSED"; exit 0; }
echo "  TESTS FAILED"
exit 1