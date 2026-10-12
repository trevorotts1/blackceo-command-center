#!/usr/bin/env bash
#
# watchdog-cc-pm2-save-race.test.sh
#
# THE DEFECT (measured 2026-10-12, Contabo box): at gateway-up the watchdog
# starts the pm2 daemon and the Command Center and runs `pm2 save` BEFORE the
# box's own startup has run `pm2 resurrect`. The save rewrote dump.pm2 with the
# Command Center alone, resurrect then restored nothing, and every other pm2
# app (ghl-community-mcp) silently vanished at boot.
#
# REPRODUCES IT: dump.pm2 lists TWO apps, the pm2 daemon has ONE running. The
# fake `pm2 save` behaves like the real one - it overwrites dump.pm2 with the
# running list. Unfixed script -> dump shrinks to one app. Fixed script -> the
# dump is left intact and the skip is logged.
#
#   R1  start path (no CC in pm2, dump has an app that is not running): the
#       dump still lists both apps, no `save` ran, the log says why.
#   R2  self-heal path (zombie CC pattern): same guarantee.
#   R3  control: dump equals the running list -> the save DOES run.
#   R4  control: no dump yet -> the save DOES run (first-ever save).
#   R5  control: the dump's only extra name is a Command Center alias the
#       watchdog manages itself -> the save DOES run (aliases must not block).
#   R6  pm2 prints a banner before the JSON -> still parsed, still guarded.
#   R7  unreadable running list -> the save is skipped, not guessed.
#
# Fixture-only: fake pm2 on PATH, PM2_HOME in a temp dir. Nothing is started.
#
# Run: bash tests/unit/watchdog-cc-pm2-save-race.test.sh
# WATCHDOG_SCRIPT=<path> runs the same cases against another copy of the script.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WD_SRC="${WATCHDOG_SCRIPT:-$REPO_ROOT/scripts/watchdog-cc.sh}"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wd-race.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/cc/scripts" "$WORK/state" "$WORK/pm2home"

# fake pm2: `jlist` prints $FAKE_PM2_JLIST; `describe` succeeds for names in
# $FAKE_PM2_KNOWN; `save` OVERWRITES dump.pm2 with $FAKE_PM2_RUNNING (names),
# exactly like the real command; every call is logged.
cat > "$WORK/bin/pm2" <<'FAKEPM2'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${PM2_CALL_LOG:-/dev/null}"
case "${1:-}" in
  jlist)    printf '%s\n' "${FAKE_PM2_JLIST:-[]}" ;;
  ls)       printf '%s' "${FAKE_PM2_LS:-}" ;;
  describe) for k in ${FAKE_PM2_KNOWN:-}; do [[ "$k" == "${2:-}" ]] && exit 0; done; exit 1 ;;
  save)     python3 -c 'import json,os,sys
n=os.environ.get("FAKE_PM2_RUNNING","").split()
json.dump([{"name":x} for x in n], open(os.environ["PM2_HOME"]+"/dump.pm2","w"))' ;;
esac
exit 0
FAKEPM2
chmod +x "$WORK/bin/pm2"
export PATH="$WORK/bin:$PATH"
export PM2_CALL_LOG="$WORK/pm2.log" PM2_HOME="$WORK/pm2home"

cp "$WD_SRC" "$WORK/cc/scripts/watchdog-cc.sh"
: > "$WORK/cc/ecosystem.config.cjs"
cat > "$WORK/cc/scripts/cc-health-check.sh" <<'FAKEHC'
#!/usr/bin/env bash
printf '%s\n' "${FAKE_HEALTH_JSON:-{\}}"
exit "${FAKE_HEALTH_EXIT:-0}"
FAKEHC
chmod +x "$WORK/cc/scripts/cc-health-check.sh"
export WATCHDOG_STATE_DIR="$WORK/state" WATCHDOG_ALERT_LOG="$WORK/alerts.log"
export WATCHDOG_PORT=4000 WATCHDOG_CANONICAL_DIR="$WORK/cc" WATCHDOG_SELF_HEAL=1

ABSENT='{"pass":false,"indeterminate":false,"detail":"server unreachable: no Command Center app in pm2","service_status":"absent"}'
ZOMBIE='{"pass":false,"indeterminate":false,"detail":"x","service_status":"online","crash_looper":true}'
CC_ONLY='[{"name":"blackceo-command-center","pm_id":0}]'

dump()  { python3 -c 'import json,sys;print(" ".join(sorted(a["name"] for a in json.load(open(sys.argv[1])))))' "$PM2_HOME/dump.pm2"; }
seed()  { python3 -c 'import json,sys;json.dump([{"name":n} for n in sys.argv[2:]],open(sys.argv[1],"w"))' "$PM2_HOME/dump.pm2" "$@"; }
# run <health-json> <running-names> ; the start path only runs when pm2 has no CC app
run() {
  rm -f "$WORK/state/incidents.json"; : > "$PM2_CALL_LOG"
  FAKE_HEALTH_JSON="$1" FAKE_HEALTH_EXIT=1 FAKE_PM2_RUNNING="$2" bash "$WORK/cc/scripts/watchdog-cc.sh" >"$WORK/wd.out" 2>&1
}
saved() { grep -qx 'save' "$PM2_CALL_LOG"; }

# R1 start path: the exact production race.
seed ghl-community-mcp blackceo-command-center
export FAKE_PM2_JLIST='[]' FAKE_PM2_KNOWN="" FAKE_PM2_LS=""
run "$ABSENT" "blackceo-command-center"
[[ "$(dump)" == "blackceo-command-center ghl-community-mcp" ]] && ok "R1: dump.pm2 still lists both apps" || bad "R1: dump shrank to: $(dump)"
saved && bad "R1: pm2 save ran against a smaller list" || ok "R1: pm2 save did not run"
grep -q 'pm2 save SKIPPED.*ghl-community-mcp' "$WORK/wd.out" && ok "R1: the log names the app and why" || bad "R1: no skip log: $(tr '\n' ';' < "$WORK/wd.out")"

# R2 self-heal path: zombie pattern, CC deleted and restarted, other app not up yet.
seed ghl-community-mcp blackceo-command-center
export FAKE_PM2_JLIST="$CC_ONLY"
run "$ZOMBIE" "blackceo-command-center"
[[ "$(dump)" == "blackceo-command-center ghl-community-mcp" ]] && ok "R2: self-heal path leaves the dump intact" || bad "R2: dump shrank to: $(dump)"
saved && bad "R2: pm2 save ran" || ok "R2: pm2 save did not run"

# R3 control: dump == running -> save runs.
seed ghl-community-mcp blackceo-command-center
export FAKE_PM2_JLIST='[{"name":"blackceo-command-center"},{"name":"ghl-community-mcp"}]'
run "$ABSENT" "blackceo-command-center ghl-community-mcp"
saved && ok "R3 control: equal lists are saved" || bad "R3: save did not run"

# R4 control: no dump -> save runs.
rm -f "$PM2_HOME/dump.pm2"; export FAKE_PM2_JLIST="$CC_ONLY"
run "$ABSENT" "blackceo-command-center"
saved && ok "R4 control: first-ever save still happens" || bad "R4: save did not run"

# R5 control: the dump's extra name is a CC alias the watchdog manages itself.
seed mission-control blackceo-command-center
export FAKE_PM2_JLIST="$CC_ONLY"
run "$ABSENT" "blackceo-command-center"
saved && ok "R5 control: a stale CC alias in the dump does not block the save" || bad "R5: save blocked by a CC alias"

# R6 banner before the JSON.
seed ghl-community-mcp blackceo-command-center
export FAKE_PM2_JLIST="[PM2] Spawning PM2 daemon with pm2_home=/x
[PM2] PM2 Successfully daemonized
$CC_ONLY"
run "$ABSENT" "blackceo-command-center"
saved && bad "R6: save ran despite a missing app" || ok "R6: banner before the JSON is parsed and still guarded"

# R7 unreadable list.
seed ghl-community-mcp blackceo-command-center
export FAKE_PM2_JLIST='not json at all'
run "$ABSENT" "blackceo-command-center"
saved && bad "R7: save ran on an unreadable list" || ok "R7: unreadable running list -> save skipped"

echo ""
printf '[watchdog-cc-pm2-save-race] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
