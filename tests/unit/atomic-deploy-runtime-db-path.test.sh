#!/usr/bin/env bash
# atomic-deploy must pin DATABASE_PATH for the pm2 restart. `pm2 restart
# --update-env` keeps a stale baked-in value whenever the deploy shell does not
# export the variable; measured 2026-09-18 on a VPS box whose app pointed at a
# directory that never existed while the real DB sat in the checkout root.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# Extract the resolver function verbatim from the script so the test runs the
# real code, not a copy.
sed -n '/^_configured_db_path() {/,/^}/p' scripts/atomic-deploy.sh > "$TMP/fn.sh"
sed -n '/^_resolve_runtime_db_path() {/,/^}/p' scripts/atomic-deploy.sh >> "$TMP/fn.sh"
[[ -s "$TMP/fn.sh" ]] && ok "resolver function found in scripts/atomic-deploy.sh" || bad "resolver function missing"
_warn() { :; }
# shellcheck disable=SC1090
source "$TMP/fn.sh"
APP_DIR="$TMP/app"; mkdir -p "$APP_DIR"; printf 'x' > "$APP_DIR/mission-control.db"
DB_FILE="$APP_DIR/mission-control.db"
# 1. --db-path wins over everything
DB_PATH_OVERRIDE="/o/verride.db"; DATABASE_PATH="/nope/x.db"
[[ "$(_resolve_runtime_db_path)" == "/o/verride.db" ]] && ok "--db-path wins" || bad "--db-path did not win"
# 2. shell DATABASE_PATH with an EXISTING directory is kept
DB_PATH_OVERRIDE=""; DATABASE_PATH="$TMP/live.db"
[[ "$(_resolve_runtime_db_path)" == "$TMP/live.db" ]] && ok "shell DATABASE_PATH with existing dir is kept" || bad "existing-dir shell value not kept"
# 3. shell DATABASE_PATH whose directory does NOT exist is ignored -> DB_FILE
DATABASE_PATH="$TMP/does-not-exist/mission-control.db"
[[ "$(_resolve_runtime_db_path)" == "$DB_FILE" ]] && ok "stale shell DATABASE_PATH (missing dir) falls through to the 1b DB" || bad "stale shell value was not ignored"
# 4. .env.local relative value resolves against APP_DIR and beats DB_FILE
unset DATABASE_PATH; printf 'DATABASE_PATH="../data/mission-control.db"\n' > "$APP_DIR/.env.local"
[[ "$(_resolve_runtime_db_path)" == "$APP_DIR/../data/mission-control.db" ]] && ok ".env.local relative value resolves under APP_DIR" || bad ".env.local relative value wrong: $(_resolve_runtime_db_path)"
# 5. nothing usable -> non-zero, empty
rm -f "$APP_DIR/.env.local"; DB_FILE=""
if out="$(_resolve_runtime_db_path)"; then bad "returned success with nothing to resolve"; else [[ -z "$out" ]] && ok "returns non-zero and empty with nothing to resolve" || bad "non-empty output with nothing to resolve"; fi
# 6. the script exports the result before Phase 1c
grep -q 'export DATABASE_PATH="\$RUNTIME_DB_PATH"' scripts/atomic-deploy.sh && ok "script exports the pinned path" || bad "script does not export the pinned path"
# 7. the configured path is the FIRST backup candidate (Contabo boxes had no backups)
grep -q '"\$(_configured_db_path || true)" \\' scripts/atomic-deploy.sh && ok "configured DB path is the first backup candidate" || bad "configured DB path is not a backup candidate"
# 8. definitions precede the backup section that uses them
d=$(grep -n '^_configured_db_path() {' scripts/atomic-deploy.sh | cut -d: -f1); b=$(grep -n '^# ── 1b\. DB backup' scripts/atomic-deploy.sh | cut -d: -f1)
[[ -n "$d" && -n "$b" && "$d" -lt "$b" ]] && ok "resolver is defined before the backup section" || bad "resolver defined after the backup section (d=$d b=$b)"
printf '[atomic-deploy-runtime-db-path] %s passed, %s failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
