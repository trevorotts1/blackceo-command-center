#!/opt/homebrew/bin/bash
# rescue-12-cleanup.sh — FIX-RESCUE-12 (i): shrink the live deploy path so the
# real rescue code path is legible and the secret-leak surface is minimised.
#
# Three actions, each idempotent and reversible:
#   (a) ARCHIVE every *.bak* file under the fleet-heartbeat tree into
#       scripts/_archive/ (preserving relative layout). _archive/ sits outside
#       the deploy path's active scripts and is git-ignored, so the ~60 dated
#       backups stop obscuring the live path and can never be committed.
#   (b) RETIRE the legacy rescue-rangers-bridge.py. heartbeat.sh:510-528
#       documents that Rescue Rangers delivery is now handled natively by the
#       OpenClaw gateway's multi-account Telegram polling; the bridge is dead
#       code and (historically) a secret carrier. It is MOVED to _archive/
#       (recoverable) rather than hard-rm'd. No live script *invokes* it — the
#       only reference is a defensive launchctl check in session-health.sh.
#   (c) remote-rescue/ — a separate, vestigial git repo (no commits, no remote,
#       referenced by no live script/cron/launchd). Reported by default; only
#       archived when --remove-remote-rescue is passed (moved, never rm'd).
#
# SAFETY: dry-run by default. Nothing is moved without --apply. Nothing is ever
# deleted — everything is relocated under _archive/ with a manifest, so the
# operator can restore or purge deliberately. Secrets are never printed.
#
# Usage:
#   rescue-12-cleanup.sh                 # dry-run: show what would move
#   rescue-12-cleanup.sh --apply         # archive .bak files + retire bridge
#   rescue-12-cleanup.sh --apply --remove-remote-rescue
#
# Env overrides (for testing against a sandbox copy):
#   FH_ROOT       fleet-heartbeat root (default the operator box path)
#   RR_ROOT       remote-rescue root
set -u

FH_ROOT="${FH_ROOT:-${CLAWD_HOME:-${HOME}/clawd}/fleet-heartbeat}"
RR_ROOT="${RR_ROOT:-${CLAWD_HOME:-${HOME}/clawd}/remote-rescue}"
ARCHIVE="${FH_ROOT}/scripts/_archive"
BRIDGE="${FH_ROOT}/scripts/rescue-rangers-bridge.py"
HEARTBEAT="${FH_ROOT}/scripts/heartbeat.sh"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
MANIFEST="${ARCHIVE}/MANIFEST-${STAMP}.txt"

APPLY=0
REMOVE_RR=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --remove-remote-rescue) REMOVE_RR=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*"; }

if [ ! -d "$FH_ROOT" ]; then
  echo "FATAL: FH_ROOT not found: $FH_ROOT" >&2
  exit 1
fi

MODE="DRY-RUN (no changes)"; [ "$APPLY" -eq 1 ] && MODE="APPLY"
say "== FIX-RESCUE-12 cleanup :: mode=${MODE} =="
say "   FH_ROOT=${FH_ROOT}"
say "   ARCHIVE=${ARCHIVE}"
say ""

# Prepare archive + manifest only when applying.
if [ "$APPLY" -eq 1 ]; then
  mkdir -p "$ARCHIVE"
  {
    echo "# FIX-RESCUE-12 archive manifest ${STAMP}"
    echo "# format: <archived_relpath> <== <original_relpath>"
  } >"$MANIFEST"
fi

# archive_one <absolute-source-path>
# Moves the file under _archive/ preserving its path relative to FH_ROOT.
archive_one() {
  local src="$1"
  case "$src" in
    "$ARCHIVE"/*) return 0 ;;                # never re-archive
  esac
  local rel="${src#"$FH_ROOT"/}"
  local dest="${ARCHIVE}/${rel}"
  if [ "$APPLY" -eq 1 ]; then
    mkdir -p "$(dirname "$dest")"
    if mv "$src" "$dest" 2>/dev/null; then
      printf '%s <== %s\n' "_archive/${rel}" "$rel" >>"$MANIFEST"
      note "archived: $rel"
    else
      note "WARN could not move: $rel"
    fi
  else
    note "would archive: $rel -> _archive/${rel}"
  fi
}

# --- (a) archive *.bak* files ------------------------------------------------
say "-- (a) .bak* backups --"
bak_count=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  bak_count=$((bak_count + 1))
  archive_one "$f"
done < <(find "$FH_ROOT" -type f -name '*.bak*' \
            -not -path "${ARCHIVE}/*" \
            -not -path '*/node_modules/*' 2>/dev/null | sort)
say "   ${bak_count} .bak* file(s) matched."
say ""

# --- (b) retire legacy bridge ------------------------------------------------
say "-- (b) legacy rescue-rangers-bridge.py --"
if [ -f "$BRIDGE" ]; then
  # Guard 1: heartbeat.sh must document the bridge/dispatch path as superseded.
  superseded=0
  if [ -f "$HEARTBEAT" ] && grep -q "no longer needed" "$HEARTBEAT" 2>/dev/null; then
    superseded=1
  fi
  # Guard 2: no live script may actually INVOKE the bridge (python ... bridge.py).
  invoked="$(grep -rIl -e 'python.*rescue-rangers-bridge\.py' \
                       -e 'rescue-rangers-bridge\.py' \
                "$FH_ROOT/scripts" 2>/dev/null \
             | grep -vE '/_archive/|\.bak|session-health\.sh' || true)"
  if [ "$superseded" -ne 1 ]; then
    note "SKIP: heartbeat.sh does not confirm the bridge is superseded; leaving bridge in place."
  elif [ -n "$invoked" ]; then
    note "SKIP: a live script still invokes the bridge:"; printf '    %s\n' $invoked
  else
    note "confirmed superseded (heartbeat.sh) and un-invoked; retiring."
    archive_one "$BRIDGE"
    # Also sweep any bridge .bak siblings (already handled by (a), but explicit).
    while IFS= read -r bf; do [ -n "$bf" ] && archive_one "$bf"; done \
      < <(find "$FH_ROOT/scripts" -maxdepth 1 -type f -name 'rescue-rangers-bridge.py.*' -not -path "${ARCHIVE}/*" 2>/dev/null)
  fi
else
  note "bridge already absent from deploy path — nothing to do."
fi
say ""

# --- (c) vestigial remote-rescue/ -------------------------------------------
say "-- (c) remote-rescue/ --"
if [ -d "$RR_ROOT" ]; then
  # Confirm unused: no commits AND no remote AND not referenced by any live
  # executable / crontab / launchd.
  rr_commits="$(git -C "$RR_ROOT" rev-list --count --all 2>/dev/null || echo '?')"
  rr_remote="$(git -C "$RR_ROOT" remote -v 2>/dev/null | head -1)"
  rr_live_refs="$(grep -rIl 'remote-rescue' "$FH_ROOT/scripts" 2>/dev/null | grep -vE '/_archive/|\.bak' || true)"
  rr_cron="$(crontab -l 2>/dev/null | grep -c 'remote-rescue' || true)"
  say "   commits=${rr_commits} remote='${rr_remote:-<none>}' live-script-refs=$( [ -n "$rr_live_refs" ] && echo yes || echo no ) crontab-refs=${rr_cron}"
  unused=0
  if [ "$rr_commits" = "0" ] && [ -z "$rr_remote" ] && [ -z "$rr_live_refs" ] && [ "${rr_cron:-0}" = "0" ]; then
    unused=1
  fi
  if [ "$unused" -eq 1 ]; then
    if [ "$REMOVE_RR" -eq 1 ]; then
      dest="${ARCHIVE}/remote-rescue"
      if [ "$APPLY" -eq 1 ]; then
        mkdir -p "$ARCHIVE"
        if mv "$RR_ROOT" "$dest" 2>/dev/null; then
          printf '%s <== %s\n' "_archive/remote-rescue/" "${RR_ROOT}" >>"$MANIFEST"
          note "confirmed unused; archived remote-rescue/ -> _archive/remote-rescue/"
        else
          note "WARN could not move remote-rescue/"
        fi
      else
        note "confirmed unused; would archive remote-rescue/ -> _archive/remote-rescue/"
      fi
    else
      note "confirmed unused. Re-run with --remove-remote-rescue to archive it."
    fi
  else
    note "NOT confirmed unused (see counts above) — left untouched."
  fi
else
  note "remote-rescue/ not present — nothing to do."
fi

say ""
if [ "$APPLY" -eq 1 ]; then
  say "== done. manifest: ${MANIFEST}"
else
  say "== dry-run complete. Re-run with --apply to make changes."
fi
