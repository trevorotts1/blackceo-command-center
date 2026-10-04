#!/usr/bin/env bash
# mac-bootstrap-hq.test.sh — step 10 of scripts/install/mac-mini-bootstrap.sh
# (Headquarters capability + persistence preflight, SPEC S10).
#
# Extracts the REAL hq_* functions from the installer by sed range (never a
# copy) and drives them against temp fixtures: schema-present, each failure
# reason, additive flag writes, persistence preflight. The schema-present case
# is the paired POSITIVE control for the missing-table case — a red without a
# green proves nothing about the probe.
#
# No network, no live database, no fleet touch, no secret value printed.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." || exit 9
REPO_ROOT="$(pwd)"
BOOTSTRAP="$REPO_ROOT/scripts/install/mac-mini-bootstrap.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# ── extract the real functions verbatim ─────────────────────────────────────
{
  sed -n '/^hq_required_tables() {/,/^}/p'     "$BOOTSTRAP"
  sed -n '/^hq_resolve_db_path() {/,/^}/p'     "$BOOTSTRAP"
  sed -n '/^hq_capability_check() {/,/^}/p'    "$BOOTSTRAP"
  sed -n '/^hq_apply_flag() {/,/^}/p'          "$BOOTSTRAP"
  sed -n '/^hq_persistence_preflight() {/,/^}/p' "$BOOTSTRAP"
} > "$TMP/fn.sh"
for f in hq_required_tables hq_resolve_db_path hq_capability_check hq_apply_flag hq_persistence_preflight; do
  grep -q "^$f() {" "$TMP/fn.sh" && ok "real function $f extracted from the installer" || bad "$f missing from $BOOTSTRAP"
done
HQ_SQLITE_BIN="${HQ_SQLITE_BIN:-sqlite3}"
# shellcheck disable=SC1090
source "$TMP/fn.sh"

command -v "$HQ_SQLITE_BIN" >/dev/null 2>&1 || { echo "sqlite3 CLI required for this test"; exit 9; }

# ── fixture: a DB holding the seven S6 tables ───────────────────────────────
# The probe reads sqlite_master only (table presence), so bare columns suffice;
# column shapes are B01's migration's business, not this unit's.
mkdb() { # $1 path, $2... tables to create
  local db="$1"; shift
  rm -f "$db"
  local t
  for t in "$@"; do "$HQ_SQLITE_BIN" "$db" "CREATE TABLE $t(x)" >/dev/null; done
}
ALL="$(hq_required_tables)"
FULL_DB="$TMP/full.db"
mkdb "$FULL_DB" $ALL

# 1. POSITIVE control — the probe must say schema-present when it is.
[[ "$(hq_capability_check "$FULL_DB")" == "1|schema-present" ]] \
  && ok "all S6 tables -> 1|schema-present (positive control)" \
  || bad "probe red on a complete schema: $(hq_capability_check "$FULL_DB")"

# 2. NEGATIVE control — drop one required table, the SAME probe must flip.
PART_DB="$TMP/partial.db"
mkdb "$PART_DB" $(printf '%s\n' $ALL | grep -v '^hq_chat_sessions$')
out="$(hq_capability_check "$PART_DB")"
[[ "$out" == "0|tables-missing:hq_chat_sessions" ]] \
  && ok "one missing table -> 0|tables-missing:<name> (negative control discriminates)" \
  || bad "missing table not detected: $out"

# 3. A non-sqlite file is reported unreadable, never as an empty (passing) set.
echo "not a database" > "$TMP/garbage.db"
[[ "$(hq_capability_check "$TMP/garbage.db")" == "0|database-unreadable" ]] \
  && ok "unreadable file -> 0|database-unreadable (never a silent pass)" \
  || bad "garbage DB mishandled: $(hq_capability_check "$TMP/garbage.db")"

# 4. Absent DB and absent probe binary each get their own named reason.
[[ "$(hq_capability_check "$TMP/does-not-exist.db")" == "0|database-absent" ]] \
  && ok "absent DB -> 0|database-absent" || bad "absent DB mishandled"
[[ "$(HQ_SQLITE_BIN=/nonexistent/sqlite3 hq_capability_check "$FULL_DB")" == "0|sqlite3-cli-absent" ]] \
  && ok "absent probe binary -> 0|sqlite3-cli-absent (UNDETERMINED, said out loud)" \
  || bad "absent probe binary mishandled"

# 5. Read-only: probing a complete schema must not modify the file.
before="$(shasum -a 256 "$FULL_DB" | awk '{print $1}')"
hq_capability_check "$FULL_DB" >/dev/null
[[ "$(shasum -a 256 "$FULL_DB" | awk '{print $1}')" == "$before" ]] \
  && ok "probe is read-only (db bytes unchanged)" || bad "probe modified the database file"

# 6. DB path resolution: exported DATABASE_PATH wins, else the canonical
#    install-dir path (the one step 8b pins in the canonical ecosystem).
[[ "$(DATABASE_PATH=/tmp/x.db hq_resolve_db_path "$TMP/install")" == "/tmp/x.db" ]] \
  && ok "DATABASE_PATH env wins" || bad "DATABASE_PATH env ignored"
[[ "$(hq_resolve_db_path "$TMP/install")" == "$TMP/install/mission-control.db" ]] \
  && ok "default resolves to <install-dir>/mission-control.db" || bad "default DB path wrong"

# 7. Flag writes are additive and idempotent.
ENVF="$TMP/new/.env.local"; mkdir -p "$(dirname "$ENVF")"
[[ "$(hq_apply_flag "$ENVF" 1)" == "written" ]] && ok "fresh env file: flag written" || bad "fresh write failed"
grep -q '^HEADQUARTERS_ENABLED=1$' "$ENVF" && ok "flag line present with the computed value" || bad "flag line missing"
before_lines="$(wc -l < "$ENVF")"
hq_apply_flag "$ENVF" 0 >/dev/null
[[ "$(wc -l < "$ENVF")" == "$before_lines" ]] && ok "second run appends nothing (existing key preserved)" || bad "flag re-appended on re-run"
grep -q '^HEADQUARTERS_ENABLED=1$' "$ENVF" && ok "operator value stayed 1, never rewritten by the installer" || bad "operator value overwritten"

# 8. Pre-existing operator lines are untouched (additive contract).
ENVF2="$TMP/op/.env.local"; mkdir -p "$(dirname "$ENVF2")"
printf '%s\n' 'MC_API_TOKEN=operator-secret-aaa' 'HEADQUARTERS_ENABLED=0' > "$ENVF2"
out="$(hq_apply_flag "$ENVF2" 1)"
[[ "$out" == "operator value preserved" ]] && ok "existing HEADQUARTERS_ENABLED reported preserved" || bad "preserve path not taken: $out"
[[ "$(cat "$ENVF2")" == "$(printf '%s\n' 'MC_API_TOKEN=operator-secret-aaa' 'HEADQUARTERS_ENABLED=0')" ]] \
  && ok "env file byte-identical after preserve path" || bad "preserve path modified the file"

# 9. Persistence preflight creates the two Mac roots under an isolated HOME.
FAKE_HOME="$TMP/home"
hq_persistence_preflight "$FAKE_HOME" && ok "persistence preflight returns 0" || bad "persistence preflight failed"
[[ -d "$FAKE_HOME/clawd/scratch" ]] && ok "~/clawd/scratch created (workspace scratch root)" || bad "scratch root missing"
[[ -d "$FAKE_HOME/.mission-control/identity" ]] && ok "~/.mission-control/identity created (bridge identity)" || bad "identity root missing"

# 10. The installer still satisfies the guards that existed before step 10.
bash -n "$BOOTSTRAP" && ok "installer parses (bash -n)" || bad "installer has a syntax error"
grep -q 'stop_exit_codes: \[78\],' "$BOOTSTRAP" && ok "PRES-045 exit policy still in the canonical template" || bad "exit policy lost"
grep -q 'Change 78 only together with scripts/cc-start.sh' "$BOOTSTRAP" && ok "coupled-change note retained" || bad "coupled-change note lost"
grep -q 'cc-start.sh' "$BOOTSTRAP" && ok "qc-cc 11.11 (cc-start.sh launcher) holds" || bad "launcher reference lost"
grep -q 'DATABASE_PATH: \\"$ECOSYSTEM_DIR/mission-control.db\\"' "$BOOTSTRAP" && ok "B.4 DATABASE_PATH pin intact" || bad "DATABASE_PATH pin changed"

# 11. End-to-end: run the REAL step-10 block FROM ITS FIRST LINE (`HQ_SQLITE_BIN=`)
#     through the summary — that range carries the function definitions AND the
#     wiring, so this covers the block as the installer actually runs it, with an
#     isolated HOME + ECOSYSTEM_DIR.
{
  echo 'set -uo pipefail'
  echo "HOME=\"$TMP/e2e-home\"; mkdir -p \"\$HOME\""
  echo "ECOSYSTEM_DIR=\"$TMP/e2e-install\"; mkdir -p \"\$ECOSYSTEM_DIR\""
  sed -n '/^HQ_SQLITE_BIN=/,/^echo "  flag:           \$HQ_FLAG_ACTION in \$HQ_ENV_FILE"/p' "$BOOTSTRAP"
} > "$TMP/e2e.sh"
grep -q 'database:' "$TMP/e2e.sh" && ok "step-10 summary block extracted end-to-end" || bad "step-10 block not found in installer"
mkdir -p "$TMP/e2e-install"
cp "$FULL_DB" "$TMP/e2e-install/mission-control.db"
bash "$TMP/e2e.sh" > "$TMP/e2e.out" 2>&1; e2e_rc=$?
[[ "$e2e_rc" -eq 0 ]] && ok "step 10 exits 0 on a schema-present box" || bad "step 10 rc=$e2e_rc: $(cat "$TMP/e2e.out")"
grep -q 'schema present — HEADQUARTERS_ENABLED=1' "$TMP/e2e.out" && ok "e2e: capability line reports schema present" || bad "e2e capability line wrong: $(cat "$TMP/e2e.out")"
grep -q 'persistence:.*clawd/scratch' "$TMP/e2e.out" && ok "e2e: persistence row reports the Mac roots" || bad "e2e persistence row missing"
grep -q "^HEADQUARTERS_ENABLED=1$" "$TMP/e2e-install/.env.local" && ok "e2e: flag landed in the install dir's .env.local" || bad "e2e flag not written"
grep -q 'database:.*e2e-install/mission-control.db' "$TMP/e2e.out" && ok "e2e: resolved DB path printed (never guessed)" || bad "e2e DB path not printed"

# 12. Negative control for the wiring: drop a table from the same fixture and
#     the identical block must report DISABLED with the reason, still rc 0.
cp "$PART_DB" "$TMP/e2e-install/mission-control.db"
rm -f "$TMP/e2e-install/.env.local"
bash "$TMP/e2e.sh" > "$TMP/e2e-neg.out" 2>&1; neg_rc=$?
[[ "$neg_rc" -eq 0 ]] && ok "step 10 stays non-fatal (rc 0) with the schema missing" || bad "step 10 hard-failed on a schema-less box (rc=$neg_rc)"
grep -q 'HEADQUARTERS_ENABLED=0 — tables-missing:hq_chat_sessions' "$TMP/e2e-neg.out" \
  && ok "e2e negative control: disabled with the exact missing table named" \
  || bad "e2e negative reason wrong: $(grep capability "$TMP/e2e-neg.out")"
grep -q "^HEADQUARTERS_ENABLED=0$" "$TMP/e2e-install/.env.local" && ok "e2e: disabled flag written (fail-closed availability)" || bad "e2e disabled flag missing"

printf '[mac-bootstrap-hq] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
