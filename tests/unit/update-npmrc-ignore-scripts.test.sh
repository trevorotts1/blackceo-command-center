#!/usr/bin/env bash
# An operator npmrc must not be able to suppress the native build (2026-09-21,
# operator canary box).
#
# `~/.npmrc` carried `ignore-scripts=true`, an operator hardening. update.sh's
# `npm ci` then WIPED node_modules and never ran better-sqlite3's postinstall
# build, so the app had no binding at all: the live process kept serving only
# because it held the deleted files open, and any restart would have
# crash-looped. Worse, `npm rebuild better-sqlite3` printed "rebuilt
# dependencies successfully" and built nothing; only
# `npm rebuild better-sqlite3 --ignore-scripts=false` produced the binding.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

# ── 1. the flag is on every install/rebuild path ──────────────────────────
grep -qE 'npm ci [^|]*--ignore-scripts=false' update.sh \
  && ok "update.sh runs npm ci with --ignore-scripts=false" || bad "update.sh npm ci lacks --ignore-scripts=false"
grep -qE 'npm ci [^|]*--ignore-scripts=false' scripts/atomic-deploy.sh \
  && ok "atomic-deploy keeps --ignore-scripts=false" || bad "atomic-deploy npm ci lacks --ignore-scripts=false"
grep -qE 'npm rebuild better-sqlite3 --ignore-scripts=false|rebuild better-sqlite3 --ignore-scripts=false' scripts/repair-command-center.sh \
  && ok "repair-command-center rebuilds with --ignore-scripts=false" || bad "repair rebuild lacks --ignore-scripts=false"
grep -q 'npm rebuild better-sqlite3 --ignore-scripts=false' package.json \
  && ok "package.json postinstall rebuild carries the flag" || bad "postinstall rebuild lacks the flag"
printf 'npm ci --no-audit --no-fund\n' | grep -qE 'npm ci [^|]*--ignore-scripts=false' \
  && bad "control: the pattern matched a line without the flag" || ok "control: the pattern requires the flag"

# ── 2. the native guard runs BEFORE migrations, build and restart ─────────
guard_line=$(grep -n '^_cc_assert_native_module_usable better-sqlite3' update.sh | head -1 | cut -d: -f1)
deploy_line=$(grep -n '^ATOMIC_DEPLOY=' update.sh | head -1 | cut -d: -f1)
step5_line=$(grep -n 'Step 5: Database migrations' update.sh | head -1 | cut -d: -f1)
if [[ -n "$guard_line" && -n "$step5_line" && "$guard_line" -lt "$step5_line" ]]; then
  ok "the native-module guard runs before the migrations step"
else bad "guard ($guard_line) does not precede migrations ($step5_line)"; fi
if [[ -n "$guard_line" && -n "$deploy_line" && "$guard_line" -lt "$deploy_line" ]]; then
  ok "the native-module guard runs before the build/restart"
else bad "guard ($guard_line) does not precede atomic-deploy ($deploy_line)"; fi
grep -q 'fatal "npm ci completed but \$mod has no compiled binary' update.sh \
  && ok "a missing binding is fatal, not a warning" || bad "missing binding is not fatal"

# ── 3. a failed install never leaves node_modules wiped ───────────────────
grep -q 'trap _cc_restore_node_modules EXIT' update.sh \
  && ok "the restore is armed before npm ci" || bad "no EXIT trap arming the restore"
grep -q 'mv node_modules node_modules.prev' update.sh \
  && ok "the previous node_modules is moved aside, not deleted" || bad "no rename-swap before npm ci"
grep -q '_cc_nm_prev="node_modules.prev"' update.sh \
  && ok "the swap is ARMED — a successful mv records the path to restore" || bad "mv succeeds but nothing records the path, so restore would no-op"

# The shipped restore function itself, extracted from update.sh and run.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
awk '/^_cc_restore_node_modules\(\) \{/,/^\}/' update.sh > "$TMP/fn.sh"
[[ -s "$TMP/fn.sh" ]] || bad "could not extract _cc_restore_node_modules from update.sh"
(
  set -u
  # The shipped restore uses paths relative to the install directory, which is
  # the working directory at that point in update.sh.
  mkdir -p "$TMP/box" && cd "$TMP/box" || exit 9
  mkdir -p node_modules.prev/better-sqlite3
  echo old > node_modules.prev/better-sqlite3/marker
  mkdir -p node_modules                         # the half-written new tree
  _cc_nm_prev="node_modules.prev"
  # shellcheck disable=SC1090
  . "$TMP/fn.sh"
  _cc_restore_node_modules
  [[ -f node_modules/better-sqlite3/marker ]] || exit 1
  [[ -d node_modules.prev ]] && exit 2
  # a second call is a no-op, not a second restore
  _cc_restore_node_modules
  [[ -f node_modules/better-sqlite3/marker ]] || exit 3
  exit 0
)
case $? in
  0) ok "the failure path restores the previous node_modules and is idempotent" ;;
  1) bad "restore did not put the previous node_modules back" ;;
  2) bad "restore left node_modules.prev behind" ;;
  *) bad "restore misbehaved on a second call" ;;
esac

# ── 4. the behaviour itself, against real npm ─────────────────────────────
# A package whose postinstall writes a marker, installed under a HOME whose
# npmrc says ignore-scripts=true. This is the canary box's exact configuration.
if command -v npm >/dev/null 2>&1; then
  FX="$TMP/fx"; HOMEDIR="$TMP/home"; mkdir -p "$FX" "$HOMEDIR"
  printf 'ignore-scripts=true\n' > "$HOMEDIR/.npmrc"
  cat > "$FX/package.json" <<'PJ'
{ "name":"marker-probe","version":"1.0.0","private":true,
  "scripts":{"postinstall":"node -e \"require('fs').writeFileSync('postinstall.marker','ran')\""} }
PJ
  printf '{"name":"marker-probe","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"marker-probe","version":"1.0.0"}}}\n' > "$FX/package-lock.json"
  ( cd "$FX" && HOME="$HOMEDIR" npm ci --no-audit --no-fund >/dev/null 2>&1 )
  if [[ -f "$FX/postinstall.marker" ]]; then
    bad "control: a bare npm ci ran postinstall despite ignore-scripts=true — this npm cannot prove the defect"
  else
    ok "control: a bare npm ci under ignore-scripts=true skips postinstall (the defect)"
  fi
  rm -f "$FX/postinstall.marker"
  ( cd "$FX" && HOME="$HOMEDIR" npm ci --no-audit --no-fund --ignore-scripts=false >/dev/null 2>&1 )
  [[ -f "$FX/postinstall.marker" ]] \
    && ok "--ignore-scripts=false runs postinstall anyway (the fix)" \
    || bad "--ignore-scripts=false did NOT run postinstall"
else
  ok "npm not on PATH — behavioural fixture skipped"
fi

printf '[update-npmrc-ignore-scripts] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
