#!/usr/bin/env bash
# archive-bak-files.sh  (FIX-RESCUE-12 part i)
#
# Operator-box hygiene: move the ~60 stray .bak / .orig / .rej copies out of the
# live deploy path into scripts/_archive/ (kept on disk, out of git via the
# fleet-heartbeat .gitignore), and retire the confirmed-superseded legacy paths.
# This declutters the live rescue path and shrinks the plaintext-secret blast
# radius (old backups can carry pre-rotation secrets).
#
# SAFE BY DEFAULT: dry-run. It prints exactly what it WOULD move/remove and
# changes nothing until you pass --apply. Never touches the live scripts, only
# their backups. Run it from the operator box (not from a subagent worktree).
#
#   ./archive-bak-files.sh            # dry-run (default)
#   ./archive-bak-files.sh --apply    # actually move/remove
set -uo pipefail

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ARCHIVE_DIR="$SCRIPTS_DIR/_archive"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

say() { printf '%s\n' "$*"; }
act() { # act "<description>" "<cmd> ..."
  local desc="$1"; shift
  if [ "$APPLY" = "1" ]; then
    say "APPLY : $desc"
    "$@" || say "  (warn) command failed: $*"
  else
    say "DRYRUN: $desc"
  fi
}

say "== fleet-heartbeat backup hygiene =="
say "scripts dir : $SCRIPTS_DIR"
say "archive dir : $ARCHIVE_DIR"
[ "$APPLY" = "1" ] && say "mode        : APPLY" || say "mode        : DRY-RUN (pass --apply to execute)"
say ""

# 1) Move backup/patch artifacts into _archive/.
count=0
shopt -s nullglob
for f in "$SCRIPTS_DIR"/*.bak "$SCRIPTS_DIR"/*.bak-* "$SCRIPTS_DIR"/*.orig "$SCRIPTS_DIR"/*.rej; do
  [ -e "$f" ] || continue
  base="$(basename "$f")"
  if [ "$APPLY" = "1" ]; then mkdir -p "$ARCHIVE_DIR"; fi
  act "move $base -> _archive/" mv "$f" "$ARCHIVE_DIR/$base"
  count=$((count + 1))
done
say "backup artifacts found: $count"
say ""

# 2) Retire the legacy rescue-rangers bridge (superseded per heartbeat.sh:510-528
#    -- RR-room delivery now goes through the OpenClaw gateway, not this raw
#    forwarder). Archive rather than hard-delete so nothing is lost.
for legacy in rescue-rangers-bridge.py; do
  if [ -e "$SCRIPTS_DIR/$legacy" ]; then
    if [ "$APPLY" = "1" ]; then mkdir -p "$ARCHIVE_DIR"; fi
    act "retire legacy $legacy -> _archive/" mv "$SCRIPTS_DIR/$legacy" "$ARCHIVE_DIR/$legacy"
  else
    say "legacy $legacy: not present (nothing to do)"
  fi
done

# 3) Retire the vestigial remote-rescue/ tree if it still exists.
if [ -d "$SCRIPTS_DIR/remote-rescue" ]; then
  act "retire remote-rescue/ -> _archive/remote-rescue" mv "$SCRIPTS_DIR/remote-rescue" "$ARCHIVE_DIR/remote-rescue"
else
  say "remote-rescue/: not present (nothing to do)"
fi

say ""
if [ "$APPLY" = "1" ]; then
  say "Done. Archived artifacts now live under _archive/ (git-ignored)."
else
  say "Dry-run complete. Re-run with --apply to perform the moves above."
fi
