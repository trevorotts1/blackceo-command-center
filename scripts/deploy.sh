#!/usr/bin/env bash
# scripts/deploy.sh — DEPRECATED (BUILD-04). Superseded by scripts/atomic-deploy.sh.
#
# WHY DEPRECATED
# --------------
# The old deploy.sh did a NON-ATOMIC `rm -rf .next` BEFORE building (a window
# where the server had no build to serve) and targeted a legacy APP_DIR. Its
# rollback also depended on that self-managed `.next-backup` copy.
#
# scripts/atomic-deploy.sh supersedes it end-to-end:
#   • builds into a TEMP dir (never deletes the live .next up front),
#   • gates on a FRESH .next/BUILD_ID (mtime > build start) so a stale artifact
#     is never accepted as a successful build,
#   • ATOMICALLY swaps .next via a single rename (no missing-.next window),
#   • restarts pm2 onto the fresh build, and
#   • runs cc-health-check.sh with exit-contract-aware AUTO-ROLLBACK.
#
# This file is now a thin shim that FORWARDS to atomic-deploy.sh so any existing
# caller (cron, runbook, muscle memory) keeps working while getting the safe
# path. Override the target with --app-dir / --pm2-app or the CC_APP_DIR /
# CC_PM2_APP_NAME env vars (see atomic-deploy.sh --help for the full flag set).
#
# NEW CALLERS: invoke scripts/atomic-deploy.sh directly.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ATOMIC="$SCRIPT_DIR/atomic-deploy.sh"

echo "WARNING: scripts/deploy.sh is DEPRECATED — forwarding to scripts/atomic-deploy.sh" >&2
echo "         (atomic build into temp dir + fresh-BUILD_ID gate + atomic swap + health-gated auto-rollback)." >&2

if [ ! -f "$ATOMIC" ]; then
  echo "ERROR: atomic-deploy.sh not found at $ATOMIC — cannot deploy. Update this checkout." >&2
  exit 2
fi

# atomic-deploy.sh requires bash 4+ (macOS system bash is 3.2). Resolve one.
BASH4=""
for _cand in /opt/homebrew/bin/bash /usr/local/bin/bash bash; do
  if command -v "$_cand" >/dev/null 2>&1 && \
     [ "$("$_cand" -c 'echo "${BASH_VERSINFO[0]:-0}"' 2>/dev/null || echo 0)" -ge 4 ]; then
    BASH4="$_cand"; break
  fi
done
if [ -z "$BASH4" ]; then
  echo "ERROR: atomic-deploy.sh requires bash 4+, none found (try: brew install bash)." >&2
  exit 2
fi

# Preserve deploy.sh's historical defaults unless the caller overrides them.
# atomic-deploy.sh parses args left-to-right (last wins), so a caller-supplied
# --app-dir / --pm2-app in "$@" overrides the defaults we inject here.
APP_DIR_DEFAULT="${CC_APP_DIR:-$HOME/projects/mission-control}"
PM2_DEFAULT="${CC_PM2_APP_NAME:-blackceo-command-center}"

exec "$BASH4" "$ATOMIC" --app-dir "$APP_DIR_DEFAULT" --pm2-app "$PM2_DEFAULT" "$@"
