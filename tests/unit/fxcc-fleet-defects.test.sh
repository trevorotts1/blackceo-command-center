#!/usr/bin/env bash
#
# fxcc-fleet-defects.test.sh  (FXCC-1: D14, D21, D22)
#
#   D14  pm2 analyzer + zombie lib ignore pm2 modules (pm2-logrotate inherits PORT)
#        P1 jlist = CC on 4000 + pm2-logrotate module with env PORT=4000 -> app_count 1
#        P2 control: the same fixture WITHOUT the pmx_module flag -> app_count 2
#        P3 pm2-port-zombies.py does not name the module a zombie / the CC app
#   D21  watchdog self-heal reads the PRETTY-PRINTED health JSON
#        H1 indented app_count 2        -> zombie trigger + pm2 delete/start
#        H2 indented crash_loopers list -> crash_looper trigger
#        H3 control: app_count 1, no loopers -> no heal, no pm2 delete
#        H4 order: analyzer output for CC + pm2-logrotate (D14) -> NO heal
#   D22  update backups go to the persistent OpenClaw root when it is a mount
#        and $HOME is not (Contabo); unchanged elsewhere
#        B1 Contabo (root mount, HOME not)     -> <root>/backups/...
#        B2 Mac (no mountpoint command)        -> empty (caller keeps its path)
#        B3 Hostinger (root not a mount)       -> empty
#        B4 HOME is itself a mount             -> empty
#        B5 update.sh and weekly-cleanup.sh use it (weekly log really lands in the root)
#
# Fixture-only: fake pm2 / mountpoint on PATH, temp dirs. Nothing is started.
# Run: bash tests/unit/fxcc-fleet-defects.test.sh

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fxcc.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
ANALYZE="$REPO_ROOT/scripts/pm2-analyze-cc.py"
ZOMBIES="$REPO_ROOT/scripts/lib/pm2-port-zombies.py"

# ── D14 ─────────────────────────────────────────────────────────────────────
mkjlist() { # $1 = pmx_module value for the logrotate entry (true|false)
  python3 -s - "$1" <<'PYEOF'
import json, sys
mod = sys.argv[1] == 'true'
cc = {"name": "blackceo-command-center", "pid": 111, "pm2_env": {
    "name": "blackceo-command-center", "status": "online", "pm_cwd": "/cc",
    "args": ["start"], "env": {"CC_PORT": "4000"}}}
lr = {"name": "pm2-logrotate", "pid": 222, "pm2_env": {
    "name": "pm2-logrotate", "status": "online", "pm_cwd": "/root/.pm2/modules/pm2-logrotate",
    "pmx_module": mod, "env": {"PORT": "4000"}}}
print(json.dumps([cc, lr]))
PYEOF
}
topo() { mkjlist "$1" | python3 -s "$ANALYZE" --port 4000 --canonical-dir /cc --app-name blackceo-command-center; }
count() { python3 -s -c 'import json,sys; print(json.load(sys.stdin)["app_count"])'; }

[[ "$(topo true | count)" == "1" ]] && ok "P1: pm2-logrotate module is not a second Command Center (app_count 1)" || bad "P1: app_count $(topo true | count)"
[[ "$(topo false | count)" == "2" ]] && ok "P2: control: same env without the module flag still counts 2" || bad "P2: control broke"
Z="$(mkjlist true | CC_ZOMBIE_PS_TABLE='' python3 -s "$ZOMBIES" blackceo-command-center 4000)"
R="$(mkjlist true | python3 -s "$ZOMBIES" --resolve-name 4000 blackceo-command-center)"
[[ -z "$Z" && "$R" == "blackceo-command-center" ]] && ok "P3: zombie lib names no module a zombie and resolves the real app" || bad "P3: zombies='$Z' resolve='$R'"

# ── D21 ─────────────────────────────────────────────────────────────────────
mkdir -p "$WORK/bin" "$WORK/cc/scripts" "$WORK/state"
cat > "$WORK/bin/pm2" <<'FAKEPM2'
#!/usr/bin/env bash
echo "$*" >> "$PM2_CALLS"
exit 0
FAKEPM2
chmod +x "$WORK/bin/pm2"
cp "$REPO_ROOT/scripts/watchdog-cc.sh" "$WORK/cc/scripts/watchdog-cc.sh"
: > "$WORK/cc/ecosystem.config.cjs"
cat > "$WORK/cc/scripts/cc-health-check.sh" <<'FAKEHC'
#!/usr/bin/env bash
printf '%s\n' "$FAKE_HEALTH_JSON"
exit 1
FAKEHC
chmod +x "$WORK/cc/scripts/cc-health-check.sh"
export PM2_CALLS="$WORK/pm2.calls" PATH="$WORK/bin:$PATH" PM2_HOME="$WORK/pm2home"
export WATCHDOG_STATE_DIR="$WORK/state" WATCHDOG_ALERT_LOG="$WORK/alerts.log" \
       WATCHDOG_PORT=4000 WATCHDOG_CANONICAL_DIR="$WORK/cc" WATCHDOG_SELF_HEAL=1

# run_wd <health-json-as-cc-health-check-prints-it> -> stderr in $WORK/wd.out, pm2 calls in $PM2_CALLS
run_wd() {
  rm -rf "$WORK/state"/* "$WORK/alerts.log" "$PM2_CALLS" "$WORK/pm2home"; : > "$PM2_CALLS"
  FAKE_HEALTH_JSON="$1" bash "$WORK/cc/scripts/watchdog-cc.sh" >"$WORK/wd.out" 2>&1
}
# The health script prints json.dumps(d, indent=2): reproduce that, not compact JSON.
indented() { python3 -s -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1]), indent=2))' "$1"; }

run_wd "$(indented '{"pass":false,"indeterminate":false,"detail":"HTTP 200","pm2_topology":{"app_count":2,"crash_loopers":[]}}')"
grep -q 'SELF-HEAL trigger: zombie' "$WORK/wd.out" && grep -q '^delete blackceo-command-center' "$PM2_CALLS" \
  && ok "H1: indented app_count 2 triggers the zombie heal (pm2 delete + start)" || { bad "H1: no heal"; cat "$WORK/wd.out"; }

run_wd "$(indented '{"pass":false,"indeterminate":false,"detail":"HTTP 200","pm2_topology":{"app_count":1,"crash_loopers":[{"name":"blackceo-command-center","reason":"status=errored"}]}}')"
grep -q 'SELF-HEAL trigger: crash_looper' "$WORK/wd.out" && grep -q '^delete blackceo-command-center' "$PM2_CALLS" \
  && ok "H2: indented crash_loopers list triggers the crash-loop heal" || { bad "H2: no heal"; cat "$WORK/wd.out"; }

run_wd "$(indented '{"pass":false,"indeterminate":false,"detail":"HTTP 200","pm2_topology":{"app_count":1,"crash_loopers":[]}}')"
if grep -q 'not self-healing' "$WORK/wd.out" && ! grep -q '^delete' "$PM2_CALLS"; then ok "H3: control: one healthy app, no heal, no pm2 delete"; else bad "H3: control healed"; cat "$WORK/wd.out"; fi

TOPO="$(mkjlist true | python3 -s "$ANALYZE" --port 4000 --canonical-dir /cc --app-name blackceo-command-center)"
run_wd "$(python3 -s -c 'import json,sys; print(json.dumps({"pass":False,"indeterminate":False,"detail":"HTTP 200","pm2_topology":json.loads(sys.argv[1])}, indent=2))' "$TOPO")"
if ! grep -q 'SELF-HEAL trigger' "$WORK/wd.out" && ! grep -q '^delete' "$PM2_CALLS"; then ok "H4: analyzer output for CC + pm2-logrotate (D14) never heals (order D14 before D21)"; else bad "H4: logrotate false positive healed"; cat "$WORK/wd.out"; fi

# ── D22 ─────────────────────────────────────────────────────────────────────
# Pull the real function text out of update.sh so the test cannot drift from it.
sed -n '/^# >>> cc_persist_root/,/^# <<< cc_persist_root/p' "$REPO_ROOT/update.sh" > "$WORK/persist-fn.sh"
[[ -s "$WORK/persist-fn.sh" ]] || bad "B0: cc_persist_root not found in update.sh"
mkdir -p "$WORK/mp"
cat > "$WORK/mp/mountpoint" <<'FAKEMP'
#!/usr/bin/env bash
# FAKE_MOUNTS = space-separated list of paths that are mount points
p="${2:-$1}"
for m in $FAKE_MOUNTS; do [ "$m" = "$p" ] && exit 0; done
exit 1
FAKEMP
chmod +x "$WORK/mp/mountpoint"
# persist_for <FAKE_MOUNTS> <with-mountpoint-cmd yes|no>
persist_for() {
  local home="$WORK/home" root="$WORK/home/.openclaw" path_extra="$WORK/mp"
  mkdir -p "$root"
  [[ "$2" == "no" ]] && path_extra="$WORK/nomp"
  mkdir -p "$WORK/nomp"
  # a PATH with only the fake dir + coreutils dirs; /usr/bin may hold a real mountpoint on Linux
  # so the "no" case must not see it: build a sandbox bin with just what the function needs.
  local sb="$WORK/sb-$2"; mkdir -p "$sb"
  for t in bash sh printf; do ln -sf "$(command -v $t)" "$sb/$t" 2>/dev/null; done
  [[ "$2" == "yes" ]] && ln -sf "$WORK/mp/mountpoint" "$sb/mountpoint"
  env -i HOME="$home" OPENCLAW_ROOT="$root" FAKE_MOUNTS="$1" PATH="$sb" \
    "$(command -v bash)" -c ". '$WORK/persist-fn.sh'; cc_persist_root"
}
OCROOT="$WORK/home/.openclaw"
[[ "$(persist_for "$OCROOT" yes)" == "$OCROOT" ]] && ok "B1: Contabo (root mount, HOME not) -> persistent root" || bad "B1: '$(persist_for "$OCROOT" yes)'"
[[ -z "$(persist_for "$OCROOT" no)" ]] && ok "B2: Mac (no mountpoint command) -> unchanged" || bad "B2"
[[ -z "$(persist_for "" yes)" ]] && ok "B3: Hostinger (root not a mount) -> unchanged" || bad "B3"
[[ -z "$(persist_for "$OCROOT $WORK/home" yes)" ]] && ok "B4: HOME is itself a mount -> unchanged" || bad "B4"

grep -q 'cc_persist_root)"' "$REPO_ROOT/update.sh" && grep -q 'blackceo-cc-backups"$' "$REPO_ROOT/update.sh" \
  && ok "B5a: update.sh sends the backup base through cc_persist_root" || bad "B5a: update.sh not wired"
# weekly-cleanup.sh for real: stub mountpoint on PATH, HOME + OPENCLAW_ROOT in temp, memory dirs absent.
mkdir -p "$WORK/wh/.openclaw"
PATH="$WORK/mp:$PATH" HOME="$WORK/wh" OPENCLAW_ROOT="$WORK/wh/.openclaw" FAKE_MOUNTS="$WORK/wh/.openclaw" \
  bash "$REPO_ROOT/scripts/weekly-cleanup.sh" --dry-run >/dev/null 2>&1
[[ -f "$WORK/wh/.openclaw/backups/cleanup-log.txt" && ! -e "$WORK/wh/Downloads" ]] \
  && ok "B5b: weekly-cleanup.sh log lands in the persistent root, not \$HOME/Downloads" || bad "B5b: log not in persistent root"
mkdir -p "$WORK/wm/.openclaw"
PATH="$WORK/mp:$PATH" HOME="$WORK/wm" OPENCLAW_ROOT="$WORK/wm/.openclaw" FAKE_MOUNTS="" \
  bash "$REPO_ROOT/scripts/weekly-cleanup.sh" --dry-run >/dev/null 2>&1
[[ -f "$WORK/wm/Downloads/openclaw-backups/cleanup-log.txt" ]] \
  && ok "B5c: control: Mac/Hostinger shape keeps \$HOME/Downloads/openclaw-backups" || bad "B5c: control path changed"

printf '\nfxcc-fleet-defects: %d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
