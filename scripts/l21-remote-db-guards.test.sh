#!/usr/bin/env bash
# Regression checks for findings 34, 35 and 36.
#
#   34 — the remote guard compared only the repository BASENAME, so a checkout
#        whose origin was <foreign host>/<foreign owner>/blackceo-command-center
#        validated (and was fetched/deployed from). The guard must compare
#        normalized host + owner + repository everywhere: update.sh,
#        check-updates.sh and the flag-less path in scripts/atomic-deploy.sh.
#   35 — the pre-deploy backup ran a best-effort WAL checkpoint (whose BUSY
#        status was a result row, not an exception, and was ignored) and then
#        copied only the main file while the server was live. Committed rows
#        still in -wal could be missing. It must use SQLite's online backup and
#        fail when the snapshot cannot complete.
#   36 — the updater's departments sync ran without --db, so the resolver took
#        the first EXISTING layout candidate instead of the server's configured
#        database. resolve_db.py must read the server configuration
#        (.env.local, else <install>/../data/mission-control.db), update.sh
#        must pass --db, and parity must be enforced before opening.
#
# Every check drives the REAL shipped code: functions are extracted from the
# scripts they live in, and the online-backup heredoc is run as the deploy runs
# it. No live box, no network, no deploy.
#
# Run:  bash scripts/l21-remote-db-guards.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UPDATE="$ROOT/update.sh"
CHECK="$ROOT/check-updates.sh"
DEPLOY="$ROOT/scripts/atomic-deploy.sh"
RESOLVER="$ROOT/shared-utils/resolve_db.py"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/l21-guards.XXXXXX")"
WORK="$(cd "$WORK" && pwd -P)"   # physical: mirrors what the scripts compare
FIXTURE_PID=""
cleanup() {
  [ -n "$FIXTURE_PID" ] && kill "$FIXTURE_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

canonical="github.com/trevorotts1/blackceo-command-center"

# ── 34a. the normalizer: same id for every spelling of THIS repo ────────────
for f in "$UPDATE" "$CHECK" "$DEPLOY"; do
  name="$(basename "$f")"
  sed -n '/^_cc_repo_id() {/,/^}/p' "$f" > "$WORK/fn.$$.sh"
  if [ ! -s "$WORK/fn.$$.sh" ]; then
    bad "$name: _cc_repo_id() is missing — the guard still compares basenames"
    continue
  fi
  all_ok=1
  for u in \
      "https://github.com/trevorotts1/blackceo-command-center.git" \
      "https://user:secrettoken@github.com/trevorotts1/blackceo-command-center" \
      "git@github.com:trevorotts1/blackceo-command-center.git" \
      "ssh://git@github.com/trevorotts1/blackceo-command-center.git" \
      "https://github.com/trevorotts1/blackceo-command-center/"; do
    got="$(bash -c 'source "$1"; _cc_repo_id "$2"' _ "$WORK/fn.$$.sh" "$u")"
    [ "$got" = "$canonical" ] || { all_ok=0; bad "$name: '$u' normalized to '$got', expected '$canonical'"; }
  done
  [ "$all_ok" -eq 1 ] && ok "$name: host+owner+repo identity, all URL spellings"

  for u in \
      "https://evil.example/attacker/blackceo-command-center.git" \
      "git@gitlab.example:attacker/blackceo-command-center.git" \
      "https://gitlab.com/trevorotts1/blackceo-command-center.git" \
      "/tmp/decoy/trevorotts1/blackceo-command-center"; do
    got="$(bash -c 'source "$1"; _cc_repo_id "$2"' _ "$WORK/fn.$$.sh" "$u")"
    if [ "$got" = "$canonical" ] || [ -z "$got" ]; then
      bad "$name: foreign remote '$u' collapsed to '$got' — guard would accept it"
    else
      ok "$name: foreign remote rejected by identity ('$u' -> '$got')"
    fi
  done
done

# ── 34b. update.sh's actual checkout validator on a foreign-host fixture ────
make_checkout() {  # $1 dir, $2 origin url
  mkdir -p "$1/src" "$1/scripts"
  git init -q -b main "$1" >/dev/null 2>&1
  git -C "$1" config user.email "fixture@test.invalid"
  git -C "$1" config user.name "Fixture"
  printf '{"name":"mission-control","version":"1.0.0"}\n' > "$1/package.json"
  : > "$1/next.config.mjs"; : > "$1/ecosystem.config.cjs"
  : > "$1/src/.gitkeep";   : > "$1/scripts/atomic-deploy.sh"
  git -C "$1" remote add origin "$2"
}
if sed -n '/^_cc_validate_checkout() {/,/^}/p' "$UPDATE" > "$WORK/validate.sh"; [ -s "$WORK/validate.sh" ]; then
  cat > "$WORK/harness.sh" <<'HARNESS'
set -uo pipefail
CC_PKG_NAME="mission-control"
CC_REQUIRED_MARKERS=("package.json" "next.config.mjs" "ecosystem.config.cjs" "src" "scripts/atomic-deploy.sh")
CC_CANDIDATE_PATH=""; CC_CANDIDATE_REASON=""
source "$1"      # _cc_repo_id
source "$2"      # _cc_validate_checkout
CC_EXPECTED_REPO_ID="$(_cc_repo_id "$3")"
if _cc_validate_checkout "$4"; then echo "ACCEPT"; else echo "REJECT: $CC_CANDIDATE_REASON"; fi
HARNESS
  mkdir -p "$WORK/fn"
  sed -n '/^_cc_repo_id() {/,/^}/p' "$UPDATE" > "$WORK/fn/id.sh"
  foreign="$WORK/foreign"
  make_checkout "$foreign" "https://gitlab.example/attacker/blackceo-command-center.git"
  out="$(bash "$WORK/harness.sh" "$WORK/fn/id.sh" "$WORK/validate.sh" \
        "https://github.com/trevorotts1/blackceo-command-center.git" "$foreign")"
  case "$out" in
    REJECT*) ok "update.sh validator REJECTS foreign host+owner: $out" ;;
    *)       bad "update.sh validator ACCEPTED a foreign host+owner checkout ($out)" ;;
  esac

  canonical_dir="$WORK/canonical"
  make_checkout "$canonical_dir" "git@github.com:trevorotts1/blackceo-command-center.git"
  out="$(bash "$WORK/harness.sh" "$WORK/fn/id.sh" "$WORK/validate.sh" \
        "https://github.com/trevorotts1/blackceo-command-center.git" "$canonical_dir")"
  [ "$out" = "ACCEPT" ] && ok "update.sh validator still accepts the canonical checkout" \
                        || bad "update.sh validator rejected the canonical checkout ($out)"

  # atomic-deploy.sh: the flag-less guard must use the identity, not a substring.
  grep -q '\[\[ "\$_cc_id" == "\$CC_EXPECTED_REPO_ID" \]\]' "$DEPLOY" \
    && ok "atomic-deploy.sh flag-less guard compares the normalized identity" \
    || bad "atomic-deploy.sh flag-less guard does not compare the normalized identity"
  grep -q "grep -q 'blackceo-command-center'" "$DEPLOY" \
    && bad "atomic-deploy.sh still accepts any URL containing the repo name" \
    || ok "atomic-deploy.sh no longer matches the repo name by substring"
else
  bad "update.sh: _cc_validate_checkout() not found"
fi

# ── 35. the deploy backup must capture committed rows held in -wal ──────────
if awk "/<<'PYBACKUP'/{f=1;next} /^PYBACKUP\$/{f=0} f" "$DEPLOY" > "$WORK/pybackup.py"; [ -s "$WORK/pybackup.py" ]; then
  ok "atomic-deploy.sh performs the backup through the SQLite online API"
else
  bad "atomic-deploy.sh has no PYBACKUP online-backup block"
fi
grep -q 'cp "\$DB_FILE" "\$DB_BACKUP"' "$DEPLOY" \
  && bad "atomic-deploy.sh still copies the live DB with cp" \
  || ok "atomic-deploy.sh no longer copies a live WAL DB with cp"
grep -q 'DB_BACKUP_RC' "$DEPLOY" && grep -q 'could not be completed by SQLite.s online backup' "$DEPLOY" \
  && ok "atomic-deploy.sh fails closed when the snapshot cannot complete" \
  || bad "atomic-deploy.sh ignores a failed snapshot"

if [ -s "$WORK/pybackup.py" ]; then
  # Fixture: a committed row that lives ONLY in -wal because another reader
  # pinned a snapshot before it was written. That is the live server's shape,
  # and it is exactly what the old checkpoint-then-cp missed.
  cat > "$WORK/fixture.py" <<'FIXTURE'
import sqlite3, sys, time, pathlib
db, ready = sys.argv[1], sys.argv[2]
w = sqlite3.connect(db, timeout=5)
w.execute("PRAGMA journal_mode=WAL")
w.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
w.execute("INSERT INTO t (v) VALUES ('base')")
w.commit()
r = sqlite3.connect(db, timeout=5)
r.execute("BEGIN")
r.execute("SELECT count(*) FROM t").fetchone()      # snapshot pinned here
w.execute("INSERT INTO t (v) VALUES ('after-reader')")
w.commit()
res = w.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
pathlib.Path(ready).write_text("checkpoint=%r\n" % (res,))
time.sleep(60)
FIXTURE
  python3 "$WORK/fixture.py" "$WORK/live.db" "$WORK/ready" &
  FIXTURE_PID=$!
  for _ in $(seq 1 100); do [ -f "$WORK/ready" ] && break; sleep 0.1; done
  if [ ! -f "$WORK/ready" ]; then
    bad "35: WAL fixture did not come up"
  else
    cp "$WORK/live.db" "$WORK/old.backup"
    old_rows="$(python3 - "$WORK/old.backup" <<'PY' 2>&1
import sqlite3, sys
try:
    c = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
    print(c.execute("SELECT count(*) FROM t").fetchone()[0])
except sqlite3.DatabaseError as e:
    print("unreadable:%s" % e)
PY
)"
    [ "$old_rows" = "2" ] \
      && bad "35: control failed — the old cp path captured every row, so the fixture does not reproduce the loss" \
      || ok "35: reproducing the old defect (checkpoint $(cat "$WORK/ready")); cp backup rows=$old_rows"

    rc=0
    python3 "$WORK/pybackup.py" "$WORK/live.db" "$WORK/new.backup" || rc=$?
    rows="$(python3 - "$WORK/new.backup" <<'PY' 2>&1
import sqlite3, sys
c = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
print(c.execute("SELECT count(*) FROM t").fetchone()[0])
print(c.execute("PRAGMA integrity_check").fetchone()[0])
PY
)"
    if [ "$rc" -eq 0 ] && [ "$rows" = "$(printf '2\nok')" ]; then
      ok "35: online backup captured the WAL-resident committed row (rows=2, integrity_check=ok)"
    else
      bad "35: online backup lost data or failed (rc=$rc, output=$(printf '%s' "$rows" | tr '\n' ' '))"
    fi
  fi
  kill "$FIXTURE_PID" 2>/dev/null; wait "$FIXTURE_PID" 2>/dev/null; FIXTURE_PID=""
fi

# ── 36. the updater must seed the database the SERVER is configured to read ──
grep -q 'cc_resolve_live_db' "$UPDATE" \
  && ok "update.sh resolves the served database once" \
  || bad "update.sh does not resolve the served database"
grep -q -- '--db "\$live_db"' "$UPDATE" \
  && ok "update.sh passes --db to the departments sync" \
  || bad "update.sh still syncs without --db"

mkdir -p "$WORK/app/workspace" "$WORK/home/projects/command-center"
: > "$WORK/app/workspace/live.db"
: > "$WORK/home/projects/command-center/mission-control.db"   # decoy layout candidate
printf 'DATABASE_PATH=workspace/live.db\n' > "$WORK/app/.env.local"
resolved="$(HOME="$WORK/home" CC_INSTALL_DIR="$WORK/app" python3 -I "$RESOLVER" 2>&1)"
case "$resolved" in
  *"$WORK/app/workspace/live.db"*) ok "resolve_db.py opens the server-configured DB, not the decoy candidate" ;;
  *) bad "resolve_db.py resolved '${resolved}' instead of the configured $WORK/app/workspace/live.db" ;;
esac
HOME="$WORK/home" CC_INSTALL_DIR="$WORK/app" python3 -I "$RESOLVER" \
  --verify-parity --app-db "$WORK/app/workspace/live.db" >/dev/null 2>&1
[ "$?" -eq 0 ] && ok "resolve_db.py path parity PASSES against the served DB" \
               || bad "resolve_db.py path parity FAILED against the served DB"
HOME="$WORK/home" CC_INSTALL_DIR="$WORK/app" python3 -I "$RESOLVER" \
  --verify-parity --app-db "$WORK/home/projects/command-center/mission-control.db" >/dev/null 2>&1
[ "$?" -eq 2 ] && ok "resolve_db.py path parity REFUSES a mismatched DB (rc 2)" \
               || bad "resolve_db.py path parity did not refuse the decoy DB"

# 36b. the updater resolves that path and HANDS it to the sync as --db.
mkdir -p "$WORK/app/scripts" "$WORK/app/shared-utils"
cp "$RESOLVER" "$WORK/app/shared-utils/resolve_db.py"
cat > "$WORK/app/scripts/sync-departments-from-build-state.py" <<'STUB'
import sys, pathlib
pathlib.Path(__file__).with_suffix(".args").write_text("\n".join(sys.argv[1:]))
STUB
if sed -n '/^cc_resolve_live_db() {/,/^}/p' "$UPDATE" > "$WORK/resolve_live.sh" && [ -s "$WORK/resolve_live.sh" ] \
   && sed -n '/^cc_sync_departments() {/,/^}/p' "$UPDATE" > "$WORK/sync_fn.sh" && [ -s "$WORK/sync_fn.sh" ]; then
  resolved_live="$(env -u DATABASE_PATH INSTALL_DIR="$WORK/app" bash -c 'source "$1"; cc_resolve_live_db' _ "$WORK/resolve_live.sh" 2>/dev/null)"
  [ "$resolved_live" = "$WORK/app/workspace/live.db" ] \
    && ok "cc_resolve_live_db resolves the server-configured path ($resolved_live)" \
    || bad "cc_resolve_live_db resolved '$resolved_live', expected $WORK/app/workspace/live.db"
  cat > "$WORK/sync_harness.sh" <<'HARNESS'
set -uo pipefail
INSTALL_DIR="$1"
step() { :; }; success() { :; }; warn() { printf '%s\n' "$1" >&2; }; fatal() { exit 1; }
source "$3"   # cc_resolve_live_db
source "$2"   # cc_sync_departments
cc_sync_departments
HARNESS
  sync_out="$(env -u DATABASE_PATH bash "$WORK/sync_harness.sh" "$WORK/app" \
              "$WORK/sync_fn.sh" "$WORK/resolve_live.sh" 2>&1)"
  args_file="$WORK/app/scripts/sync-departments-from-build-state.args"
  if [ -f "$args_file" ] && [ "$(tr '\n' ' ' < "$args_file")" = "--merge --db $WORK/app/workspace/live.db" ]; then
    ok "the departments sync is handed the served DB explicitly: $(tr '\n' ' ' < "$args_file")"
  else
    bad "the departments sync was NOT handed --db for the served DB (output: ${sync_out})"
  fi
else
  bad "update.sh: cc_resolve_live_db() / cc_sync_departments() not extractable"
fi

printf '\n[l21-remote-db-guards] %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
