#!/usr/bin/env bash
# ============================================================================
# backup-retention.test.sh
#
# Regression guard for scripts/lib/backup-retention.sh
# (OPENCLAW-BACKUP-RETENTION-V1) and its two call sites in this repo.
#
# The ONE property: Command Center backups can never accumulate again, and
# retention can never delete something it did not itself create — least of all
# the backup the current run just took.
#
#   T1  library loads
#   T2  keeps exactly N (default 3); N+2 existing -> N survive
#   T3  the newest is never pruned
#   T4  the current run's backup is never pruned, even sorting oldest
#   T5  unrelated siblings (incl. a prefix-sharing untimestamped dir) untouched
#   T6  unsafe prefixes refused, nothing deleted
#   T7  disk pre-check fails LOUD, naming path and shortfall
#   T8  a failed backup prunes NOTHING
#   T9  OPENCLAW_BACKUP_KEEP honoured; garbage falls back safely
#   T10 both call sites wired — and atomic-deploy.sh no longer mass-deletes
#       every DB backup before taking its own (the original defect)
#
# Local fixtures only: temp dirs and fake backups. No DB, no pm2, no network.
#
# Run:  bash tests/unit/backup-retention.test.sh
# ============================================================================
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
LIB="$REPO_ROOT/scripts/lib/backup-retention.sh"
UPDATE_SH="$REPO_ROOT/update.sh"
ATOMIC="$REPO_ROOT/scripts/atomic-deploy.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$1"; [ $# -ge 2 ] && printf '        %s\n' "$2"; }
head2(){ printf '\n== %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cc-backup-retention.XXXXXX")" || exit 1
trap 'rm -rf "$WORK"' EXIT

head2 "T1 library loads"
if [ -f "$LIB" ]; then
  # shellcheck source=/dev/null
  . "$LIB"
fi
if command -v oc_backup_prune >/dev/null 2>&1 && command -v oc_backup_precheck_disk >/dev/null 2>&1; then
  ok "scripts/lib/backup-retention.sh defines oc_backup_prune + oc_backup_precheck_disk"
else
  bad "scripts/lib/backup-retention.sh defines the retention helpers" "not found or not loadable: $LIB"
  printf '\n== SUMMARY\n  PASS %d\n  FAIL %d\n' "$PASS" "$FAIL"
  exit 1
fi

seed(){ local p="$1"; shift; mkdir -p "$p"; local t; for t in "$@"; do mkdir -p "$p/cc-backup-$t"; done; }
cnt(){ find "$1" -mindepth 1 -maxdepth 1 -name "$2" 2>/dev/null | wc -l | tr -d ' '; }

head2 "T2 keeps exactly N (default 3)"
P="$WORK/t2"; seed "$P" 20260101-000000 20260102-000000 20260103-000000 20260104-000000 20260105-000000
B=$(cnt "$P" 'cc-backup-*')
oc_backup_prune "$P" "cc-backup-" "$P/cc-backup-20260105-000000" > "$WORK/t2.log" 2>&1
A=$(cnt "$P" 'cc-backup-*')
[ "$B" = "5" ] && [ "$A" = "3" ] && ok "5 -> 3 (before=$B after=$A)" || bad "5 -> 3" "before=$B after=$A"
grep -q 'PRUNE:' "$WORK/t2.log" && grep -q 'KEEP' "$WORK/t2.log" && ok "logged kept and pruned (not silent)" || bad "logged kept and pruned" "$(cat "$WORK/t2.log")"

head2 "T3 never prunes the newest"
[ -d "$P/cc-backup-20260105-000000" ] && ok "newest survived" || bad "newest survived" "$(ls -1 "$P" | tr '\n' ' ')"
[ ! -d "$P/cc-backup-20260101-000000" ] && ok "oldest removed" || bad "oldest removed" "$(ls -1 "$P" | tr '\n' ' ')"

head2 "T4 current run's backup is never pruned"
P="$WORK/t4"; seed "$P" 20250101-000000 20260101-000000 20260102-000000 20260103-000000 20260104-000000
oc_backup_prune "$P" "cc-backup-" "$P/cc-backup-20250101-000000" > "$WORK/t4.log" 2>&1
[ -d "$P/cc-backup-20250101-000000" ] && ok "current run's backup survived despite sorting oldest" || bad "current run's backup survived" "$(cat "$WORK/t4.log")"

head2 "T5 unrelated entries untouched"
P="$WORK/t5"; seed "$P" 20260101-000000 20260102-000000 20260103-000000 20260104-000000 20260105-000000
mkdir -p "$P/skills-backup-20260101-000000" "$P/cc-backup-README"; : > "$P/README.txt"
oc_backup_prune "$P" "cc-backup-" "$P/cc-backup-20260105-000000" >/dev/null 2>&1
U=1
for k in skills-backup-20260101-000000 cc-backup-README README.txt; do
  [ -e "$P/$k" ] || { U=0; bad "unrelated entry survived: $k" "deleted"; }
done
[ "$U" = "1" ] && ok "unrelated siblings survived (incl. a prefix-sharing untimestamped dir)"
[ -d "$P/cc-backup-20260103-000000" ] && ok "untimestamped sibling consumed no keep slot" || bad "untimestamped sibling consumed no keep slot" "$(ls -1 "$P" | tr '\n' ' ')"

head2 "T6 unsafe prefixes refused"
for bp in "" "." ".." "ab" "a/b" "cc*"; do
  P="$WORK/t6-$(printf '%s' "$bp" | tr -c 'a-zA-Z0-9' '_')"
  seed "$P" 20260101-000000 20260102-000000 20260103-000000 20260104-000000 20260105-000000
  B=$(cnt "$P" 'cc-backup-*')
  oc_backup_prune "$P" "$bp" "" >/dev/null 2>&1; RC=$?
  A=$(cnt "$P" 'cc-backup-*')
  [ "$RC" != "0" ] && [ "$B" = "$A" ] && ok "prefix '$bp' refused (rc=$RC), deleted nothing ($B -> $A)" || bad "prefix '$bp' refused, deleted nothing" "rc=$RC before=$B after=$A"
done

head2 "T7 disk pre-check fails loudly"
P="$WORK/t7"; mkdir -p "$P"
HUGE=999999999999
if oc_backup_precheck_disk "$P/cc-backup-20260105-000000" "$HUGE" "oversized fixture" > "$WORK/t7.log" 2>&1; then
  bad "pre-check refuses an impossible request" "returned 0"
else
  ok "pre-check refuses an impossible request (nonzero)"
fi
grep -q 'BACKUP ABORTED' "$WORK/t7.log" && ok "failure is LOUD" || bad "failure is LOUD" "$(cat "$WORK/t7.log")"
grep -q "$P/cc-backup-20260105-000000" "$WORK/t7.log" && ok "names the target path" || bad "names the target path" "$(cat "$WORK/t7.log")"
grep -q 'short by' "$WORK/t7.log" && ok "states the shortfall" || bad "states the shortfall" "$(cat "$WORK/t7.log")"
oc_backup_precheck_disk "$P/cc-backup-20260106-000000" 1 "tiny fixture" >/dev/null 2>&1 && ok "allows a request that fits" || bad "allows a request that fits" "returned nonzero"

head2 "T8 a failed backup prunes nothing"
P="$WORK/t8"; seed "$P" 20260101-000000 20260102-000000 20260103-000000 20260104-000000 20260105-000000
B=$(cnt "$P" 'cc-backup-*')
NEW="$P/cc-backup-20260106-000000"
if oc_backup_precheck_disk "$NEW" "$HUGE" "fixture" >/dev/null 2>&1; then
  mkdir -p "$NEW"; oc_backup_prune "$P" "cc-backup-" "$NEW" >/dev/null 2>&1
fi
A=$(cnt "$P" 'cc-backup-*')
[ "$B" = "$A" ] && ok "pre-check refusal left every backup in place ($B -> $A)" || bad "pre-check refusal left every backup in place" "before=$B after=$A"

head2 "T9 OPENCLAW_BACKUP_KEEP"
P="$WORK/t9"; seed "$P" 20260101-000000 20260102-000000 20260103-000000 20260104-000000 20260105-000000
OPENCLAW_BACKUP_KEEP=2 oc_backup_prune "$P" "cc-backup-" "$P/cc-backup-20260105-000000" >/dev/null 2>&1
A=$(cnt "$P" 'cc-backup-*')
[ "$A" = "2" ] && ok "KEEP=2 keeps exactly 2" || bad "KEEP=2 keeps exactly 2" "after=$A"
for junk in "" "abc" "-2" "3.5"; do
  G="$(OPENCLAW_BACKUP_KEEP="$junk" oc_backup_keep)"
  [ "$G" = "3" ] && ok "KEEP='$junk' -> 3 (safe default)" || bad "KEEP='$junk' -> 3" "got $G"
done

head2 "T10 both call sites wired"
grep -q 'oc_backup_prune "\$BACKUP_BASE" "cc-backup-"' "$UPDATE_SH" && ok "update.sh prunes cc-backup-<ts> trees" || bad "update.sh prunes cc-backup-<ts> trees" "needle missing in $UPDATE_SH"
grep -q 'oc_backup_precheck_disk "\$BACKUP_DIR"' "$UPDATE_SH" && ok "update.sh disk pre-checks the backup" || bad "update.sh disk pre-checks the backup" "needle missing in $UPDATE_SH"
grep -q 'oc_backup_prune "\$dir" "mission-control.db.backup."' "$ATOMIC" && ok "atomic-deploy.sh prunes DB backups by retention" || bad "atomic-deploy.sh prunes DB backups by retention" "needle missing in $ATOMIC"
grep -q 'oc_backup_precheck_disk "\$DB_BACKUP"' "$ATOMIC" && ok "atomic-deploy.sh disk pre-checks the DB backup" || bad "atomic-deploy.sh disk pre-checks the DB backup" "needle missing in $ATOMIC"
# THE ORIGINAL DEFECT: an unconditional -delete of every DB backup, running in
# phase 1a BEFORE phase 1b writes this deploy's own. It must be gone.
if grep -q 'name "mission-control.db.backup.\*" -type f -delete' "$ATOMIC"; then
  bad "atomic-deploy.sh no longer mass-deletes every DB backup" "the unconditional -delete is still present"
else
  ok "atomic-deploy.sh no longer mass-deletes every DB backup"
fi

printf '\n== SUMMARY\n  PASS %d\n  FAIL %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
