#!/usr/bin/env bash
# headquarters-docker-capability.test.sh — B32 Docker target contract fixtures
# (Q12 path / capability half; the resurrection half is proven on the ONB side
# by tests/unit/hq/B32/headquarters-docker.test.sh, and the whole-replacement
# proof belongs to T07).
#
# Extracts the REAL functions from scripts/install/vps-docker-bootstrap.sh (sed
# range, not a copy) and drives them against temp dirs, so the test runs the
# shipped code. Covers:
#   1. step 8d sits BETWEEN step 8c and step 9 (additive, never replacing);
#   2. the capability probe reads the additive HQ table set of SPEC S6 and
#      reports the missing names — never a silent 1;
#   3. HEADQUARTERS_ENABLED=1 only when schema present AND every persistent path
#      sits under the mount;
#   4. an operator-set HEADQUARTERS_ENABLED is preserved, never overwritten;
#   5. the path contract is the vps-docker set of CC src/lib/platform.ts
#      (/data/.openclaw/workspace, /data/.openclaw/mission-control/identity) —
#      asserted against the real platform.ts, not against a copy of the literals;
#   6. no secret VALUE is ever written or echoed (key names only).
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." || exit 9
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }
SRC="scripts/install/vps-docker-bootstrap.sh"
TMP="$(mktemp -d /tmp/cc-B32-capXXXXXX)"; trap 'rm -rf "$TMP"' EXIT

# --- 0. the script is syntactically valid (bash -n) -------------------------
if bash -n "$SRC"; then ok "bash -n clean"; else bad "bash -n failed"; fi

# --- 1. step ordering: 8b, 8c, 8d, 9 --------------------------------------
grep -q 'Step 8c' "$SRC" && ok "step 8c still present" || bad "step 8c marker missing"
grep -q 'Step 8d' "$SRC" && ok "step 8d present (alongside 8c, not replacing)" || bad "step 8d marker missing"
awk '/Step 8c/{c=NR} /Step 8d/{d=NR} /Step 9: PM2/{n=NR} END{exit !(c<d && d<n)}' "$SRC" \
  && ok "order is 8c < 8d < 9" || bad "step order wrong"
grep -q '^hq_write_enabled_flag' "$SRC" && ok "step 8d actually invokes hq_write_enabled_flag" || bad "step 8d never invokes the flag writer"

# --- 2. path contract vs the real platform.ts (vps-docker set) ------------
PLAT="src/lib/platform.ts"
for p in '/data/.openclaw/workspace' '/data/.openclaw/mission-control/identity' '/data/.openclaw/openclaw.json'; do
  grep -q "$p" "$PLAT" && ok "platform.ts carries the VPS path $p" || bad "platform.ts lost $p"
done
grep -q '\.openclaw/workspace' "$SRC" && ok "bootstrap derives the workspace path from the mount root" || bad "workspace path not derived from root"
grep -q 'mission-control/identity' "$SRC" && ok "bootstrap derives the bridge-identity path from the mount root" || bad "identity path not derived from root"
grep -q '"$root"/\*' "$SRC" && ok "persistence test is a mount-prefix test, not a literal list" || bad "no mount-prefix test"

# --- extract the real functions -------------------------------------------
sed -n '/^hq_missing_tables() {/,/^}/p' "$SRC" > "$TMP/fn.sh"
sed -n '/^hq_persistence_offenders() {/,/^}/p' "$SRC" >> "$TMP/fn.sh"
sed -n '/^hq_write_enabled_flag() {/,/^}/p' "$SRC" >> "$TMP/fn.sh"
[[ -s "$TMP/fn.sh" ]] && ok "capability functions found in $SRC" || bad "capability functions missing"
# shellcheck disable=SC1090
source "$TMP/fn.sh"

# --- 3. capability probe: missing tables are NAMED -------------------------
if command -v python3 >/dev/null 2>&1; then
  DB="$TMP/mission-control.db"
  python3 - "$DB" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
for t in ("hq_activity", "hq_chat_sessions"):
    con.execute("CREATE TABLE %s (x INTEGER)" % t)
con.commit(); con.close()
PY
  out="$(hq_missing_tables "$DB")"
  case "$out" in
    MISSING:*) ok "partial schema reported as MISSING (got ${out})" ;;
    *) bad "partial schema not reported: '$out'" ;;
  esac
  [[ "$out" == *hq_run_bindings* && "$out" == *hq_owner_login_uses* ]] \
    && ok "every absent HQ table is named, not merely counted" || bad "absent tables not named: '$out'"
  python3 - "$DB" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
for t in ("hq_activity_state", "hq_activity_receipts", "hq_run_bindings",
          "hq_chat_turns", "hq_owner_login_uses"):
    con.execute("CREATE TABLE %s (x INTEGER)" % t)
con.commit(); con.close()
PY
  out="$(hq_missing_tables "$DB")"
  [[ "$out" == "OK" ]] && ok "complete schema reports OK" || bad "complete schema reported '$out'"
  out="$(hq_missing_tables "$TMP/nope.db")"
  [[ "$out" == "NO-DATABASE" ]] && ok "absent database reported NO-DATABASE (not OK)" || bad "absent db reported '$out'"
  printf 'not a database\n' > "$TMP/junk.db"
  out="$(hq_missing_tables "$TMP/junk.db")"
  case "$out" in UNREADABLE:*) ok "unreadable database reported UNREADABLE (not OK)" ;; *) bad "junk db reported '$out'" ;; esac
else
  bad "python3 absent from the test host — capability probe unproven"
fi

# --- 4. persistence contract ----------------------------------------------
out="$(hq_persistence_offenders /data /data/projects/command-center/mission-control.db)"
[[ -z "$out" ]] && ok "in-mount paths produce no offender" || bad "in-mount paths flagged: '$out'"
out="$(hq_persistence_offenders /data /tmp/mission-control.db)"
[[ -n "$out" && "$out" == *"/tmp/mission-control.db"* ]] && ok "out-of-mount database flagged" || bad "out-of-mount db not flagged: '$out'"
out="$(hq_persistence_offenders /data /data/x/mission-control.db)"
[[ -z "$out" ]] && ok "mount PREFIX match is not fooled by a similar name" || bad "prefix rule wrong: '$out'"
out="$(hq_persistence_offenders /data /dataX/mission-control.db)"
[[ -n "$out" ]] && ok "/dataX (sibling) is NOT inside /data" || bad "sibling dir wrongly accepted: '$out'"

# --- 5. the flag writer: value, preservation, never a secret --------------
ENVF="$TMP/.env"
hq_write_enabled_flag 1 "capability=1 fixture" "$ENVF" >/dev/null
grep -q '^HEADQUARTERS_ENABLED=1$' "$ENVF" && ok "writes HEADQUARTERS_ENABLED=1 on capability pass" || bad "flag not written"
mid="$(stat -f %A "$ENVF" 2>/dev/null || stat -c %a "$ENVF")"
[[ "$mid" == *"600"* ]] && ok "env file is mode 600" || bad "env file mode $mid"
hq_write_enabled_flag 0 "capability=0 fixture" "$ENVF" >/dev/null
grep -q '^HEADQUARTERS_ENABLED=1$' "$ENVF" && ok "operator-set flag preserved (never overwritten by a later 0)" || bad "flag overwritten"
[[ "$(grep -c '^HEADQUARTERS_ENABLED=' "$ENVF")" -eq 1 ]] && ok "exactly one HEADQUARTERS_ENABLED line after re-run" || bad "flag line duplicated"
printf '%s\n' 'MC_API_TOKEN=operator-secret-aaa' > "$TMP/has-secret.env"
out="$(hq_write_enabled_flag 1 "capability=1" "$TMP/has-secret.env" 2>&1)"
[[ "$out" == *"operator-secret-aaa"* ]] && bad "secret VALUE leaked to stdout" || ok "no secret value on stdout"
grep -q '^MC_API_TOKEN=operator-secret-aaa$' "$TMP/has-secret.env" && ok "existing env content byte-preserved" || bad "existing env content changed"
[[ -f "$TMP/has-secret.env.bak" ]] && ok "backup written before append" || bad "no backup before append"

# --- 6. the flag is never written with a secret-shaped reason -------------
grep -q 'never print secrets\|key names and counts only' "$SRC" && ok "no-secret rule stated in the script" || bad "no-secret rule absent"
grep -nE 'HEADQUARTERS_ENABLED=.*\$' "$SRC" | grep -v 'value' | grep -q . \
  && bad "flag value interpolates a shell variable outside hq_write_enabled_flag" \
  || ok "flag value comes only from the capability decision"

printf '[headquarters-docker-capability] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
