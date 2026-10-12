#!/usr/bin/env bash
#
# watchdog-cc-database-failed-label.test.sh  (CCG-1)
#
# THE DEFECT: classify_red() in watchdog-cc.sh labelled every RED whose health
# JSON had no pm2_topology key as "no-pm2-app" (`.get('pm2_topology', {})` is {}
# and app_count then defaults to 0). A Command Center that answered HTTP but had
# a dead database (better-sqlite3 built for another node) produced exactly such
# a JSON, so the incident read "no-pm2-app" and hid the cause.
#
#   L1  RED, migrations check failed with a load error -> "database-failed"
#   L2  RED, database_path check failed                -> "database-failed"
#   L3  RED, migrations failed only on PENDING count   -> NOT database-failed
#   L4  RED, no pm2_topology key, nothing else known   -> NOT no-pm2-app ("red")
#   L5  control: pm2_topology present with app_count 0 -> still "no-pm2-app"
#   L6  control: service_status absent                 -> still "no-pm2-app"
#
# Fixture-only: the real watchdog-cc.sh beside a fake cc-health-check.sh and a
# fake pm2. Nothing on this machine is started or stopped.
#
# Run: bash tests/unit/watchdog-cc-database-failed-label.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WATCHDOG="${WATCHDOG_SCRIPT:-$REPO_ROOT/scripts/watchdog-cc.sh}"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/wd-dbfail.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/cc/scripts" "$WORK/state"

printf '#!/usr/bin/env bash\nexit 0\n' > "$WORK/bin/pm2"; chmod +x "$WORK/bin/pm2"
export PATH="$WORK/bin:$PATH" PM2_HOME="$WORK/pm2home"
cp "$WATCHDOG" "$WORK/cc/scripts/watchdog-cc.sh"
: > "$WORK/cc/ecosystem.config.cjs"
cat > "$WORK/cc/scripts/cc-health-check.sh" <<'FAKEHC'
#!/usr/bin/env bash
printf '%s\n' "${FAKE_HEALTH_JSON:-{\}}"
exit "${FAKE_HEALTH_EXIT:-1}"
FAKEHC
chmod +x "$WORK/cc/scripts/cc-health-check.sh"
export WATCHDOG_STATE_DIR="$WORK/state" WATCHDOG_ALERT_LOG="$WORK/alerts.log" \
       WATCHDOG_PORT=4000 WATCHDOG_CANONICAL_DIR="$WORK/cc" WATCHDOG_SELF_HEAL=0

# incident_for <health-json> -> prints the incident key the watchdog opened
incident_for() {
  rm -f "$WORK/state/incidents.json" "$WORK/alerts.log"
  FAKE_HEALTH_JSON="$1" FAKE_HEALTH_EXIT=1 bash "$WORK/cc/scripts/watchdog-cc.sh" >"$WORK/wd.out" 2>&1
  sed -n 's/.*"incident":"\([^"]*\)".*/\1/p' "$WORK/alerts.log" 2>/dev/null | tail -1
}

LOADERR='migrations: error — The module better_sqlite3.node was compiled against a different Node.js version using NODE_MODULE_VERSION 147. This version of Node.js requires NODE_MODULE_VERSION 141.'
K="$(incident_for "{\"pass\":false,\"indeterminate\":false,\"detail\":\"HTTP 200\",\"checks\":{\"database_path\":{\"pass\":true},\"migrations\":{\"pass\":false,\"detail\":\"$LOADERR\"},\"scheduler_liveness\":{\"pass\":false}}}")"
[[ "$K" == "database-failed" ]] && ok "L1: a failed migrations check (module will not load) is database-failed" || bad "L1: labelled '$K'"

K="$(incident_for '{"pass":false,"indeterminate":false,"detail":"x","checks":{"database_path":{"pass":false,"detail":"database_path: DATABASE_PATH directory does not exist"}}}')"
[[ "$K" == "database-failed" ]] && ok "L2: a failed database_path check is database-failed" || bad "L2: labelled '$K'"

K="$(incident_for '{"pass":false,"indeterminate":false,"detail":"x","checks":{"database_path":{"pass":true},"migrations":{"pass":false,"detail":"migrations: 2 pending","applied_count":165,"pending_count":2}}}')"
[[ "$K" != "database-failed" && "$K" != "no-pm2-app" ]] && ok "L3: pending migrations are not mislabelled database-failed ('$K')" || bad "L3: labelled '$K'"

K="$(incident_for '{"pass":false,"indeterminate":false,"detail":"HTTP 200","checks":{}}')"
[[ "$K" == "red" ]] && ok "L4: no pm2_topology key is no longer read as no-pm2-app" || bad "L4: labelled '$K' (the mislabel)"

K="$(incident_for '{"pass":false,"indeterminate":false,"detail":"HTTP 200","checks":{},"pm2_topology":{"app_count":0}}')"
[[ "$K" == "no-pm2-app" ]] && ok "L5: control: a counted app_count of 0 is still no-pm2-app" || bad "L5: labelled '$K'"

K="$(incident_for '{"pass":false,"indeterminate":false,"detail":"server unreachable","service_status":"absent"}')"
[[ "$K" == "no-pm2-app" ]] && ok "L6: control: service_status absent is still no-pm2-app" || bad "L6: labelled '$K'"

echo ""
printf '[watchdog-cc-database-failed-label] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
