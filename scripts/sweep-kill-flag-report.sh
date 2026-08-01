#!/usr/bin/env bash
# ============================================================================
# sweep-kill-flag-report.sh — source census for BOTH rescue-sweep kill-flags.  [U039]
#
# READ-ONLY. Prints SET / NOT-SET / NO-FILE for every source in the table below.
# Prints NO VALUE, no length, no prefix, no masked form — only the literal words
# SET, NOT-SET, NO-FILE, or NOT-A-SOURCE.
#
# WHY THIS EXISTS
# ---------------
# The two rescue sweeps (stale-task-sweep and stuck-in-progress-sweep) were
# disabled by operator kill-flags. This script is the Named Stop's before/after
# artifact — it makes the flag state visible in one command so that a re-enable
# can be verified, and so that a relapse (a .env.local.bak-* restore that
# silently puts the flags back) is detectable.
#
# EXIT: always 0 (it is a report, not a gate — Rule 3.5).
#
# RUN: bash scripts/sweep-kill-flag-report.sh [--root <dir>]
#   --root <dir>  env-file root dir (default: PWD / current directory)
# ============================================================================
set -euo pipefail

# ── probe() — grep -aqE inside an if; prints ONLY SET / NOT-SET / NO-FILE ─────
probe() {  # $1 = file, $2 = key
  if [ ! -e "$1" ]; then echo "NO-FILE"; return; fi
  if /usr/bin/grep -aqE "^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*=" "$1"; then
    echo "SET"
  else
    echo "NOT-SET"
  fi
}

# ── resolve root ──────────────────────────────────────────────────────────────
ROOT="${PWD:-$(pwd)}"
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# ── environment file candidates (Next.js load order) ───────────────────────────
ENV_FILES=(
  ".env"
  ".env.local"
  ".env.production"
  ".env.production.local"
)

# ── flag constants ────────────────────────────────────────────────────────────
STALE="DISABLE_STALE_TASK_SWEEP"
STUCK="DISABLE_STUCK_IN_PROGRESS_SWEEP"

echo ""
echo "=== sweep-kill-flag source census ==="
echo "    root: $ROOT"
echo ""

# ── part 1: env-file sources ──────────────────────────────────────────────────
echo "── env-file sources (Next.js load order) ──"
for fname in "${ENV_FILES[@]}"; do
  ff="$ROOT/$fname"
  if [ -f "$ff" ] || [ -L "$ff" ]; then
    state="$(_probe_out="$(probe "$ff" "$STALE" 2>/dev/null || true)"; echo "$_probe_out")"
    printf "  %-40s %-35s %s\n" "$fname" "$STALE" "$state"
    state="$(_probe_out="$(probe "$ff" "$STUCK" 2>/dev/null || true)"; echo "$_probe_out")"
    printf "  %-40s %-35s %s\n" "$fname" "$STUCK" "$state"
  fi
done

# ── part 1b: .env*.bak* siblings (relapse hazard) ─────────────────────────────
echo ""
echo "── backup env files (HAZARD: one restore away from being a source) ──"
printed_bak=0
for candidate in "$ROOT"/.env*.bak*; do
  # When no files match, the glob expands to itself — skip that.
  if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then
    continue
  fi
  bf="$(basename "$candidate")"
  state="$(_probe_out="$(probe "$candidate" "$STALE" 2>/dev/null || true)"; echo "$_probe_out")"
  printf "  HAZARD: %-34s %-35s %s\n" "$bf" "$STALE" "$state"
  state="$(_probe_out="$(probe "$candidate" "$STUCK" 2>/dev/null || true)"; echo "$_probe_out")"
  printf "  HAZARD: %-34s %-35s %s\n" "$bf" "$STUCK" "$state"
  printed_bak=1
done
if [ "$printed_bak" -eq 0 ]; then
  echo "  (none)"
fi

# ── part 2: durable-file candidates ───────────────────────────────────────────
echo ""
echo "── durable-file candidates ──"

# 2a: CC_OPERATOR_OVERRIDES_FILE pin
if [ -n "${CC_OPERATOR_OVERRIDES_FILE:-}" ]; then
  pinned="$CC_OPERATOR_OVERRIDES_FILE"
  if [ "$pinned" = "" ]; then
    echo "  CC_OPERATOR_OVERRIDES_FILE is set to empty string — durable-file lookup DISABLED"
  else
    echo "  CC_OPERATOR_OVERRIDES_FILE pin: $pinned"
    if [ -f "$pinned" ] || [ -L "$pinned" ]; then
      state="$(_probe_out="$(probe "$pinned" "$STALE" 2>/dev/null || true)"; echo "$_probe_out")"
      printf "    %-35s %s\n" "$STALE" "$state"
      # Stuck flag: NOT-A-SOURCE from the durable file
      printf "    %-35s %s\n" "$STUCK" "NOT-A-SOURCE (not in HONORED_FLAGS)"
    fi
  fi
else
  echo "  CC_OPERATOR_OVERRIDES_FILE: NOT-SET"
fi

# 2b–2c: default candidate paths (when pin not set)
if [ -z "${CC_OPERATOR_OVERRIDES_FILE:-}" ] || [ -n "${CC_OPERATOR_OVERRIDES_FILE:-}" -a "${CC_OPERATOR_OVERRIDES_FILE:-}" != "" ]; then
  HOME_CANDIDATE="${HOME:-$HOME}/.blackceo/command-center/operator-overrides.env"
  DATA_CANDIDATE="/data/.blackceo/command-center/operator-overrides.env"

  echo "  durable candidate: $HOME_CANDIDATE"
  if [ -f "$HOME_CANDIDATE" ] || [ -L "$HOME_CANDIDATE" ]; then
    state="$(_probe_out="$(probe "$HOME_CANDIDATE" "$STALE" 2>/dev/null || true)"; echo "$_probe_out")"
    printf "    %-35s %s\n" "$STALE" "$state"
    printf "    %-35s %s\n" "$STUCK" "NOT-A-SOURCE (not in HONORED_FLAGS)"
  else
    echo "    (does not exist)"
  fi

  echo "  durable candidate: $DATA_CANDIDATE"
  if [ -f "$DATA_CANDIDATE" ] || [ -L "$DATA_CANDIDATE" ]; then
    state="$(_probe_out="$(probe "$DATA_CANDIDATE" "$STALE" 2>/dev/null || true)"; echo "$_probe_out")"
    printf "    %-35s %s\n" "$STALE" "$state"
    printf "    %-35s %s\n" "$STUCK" "NOT-A-SOURCE (not in HONORED_FLAGS)"
  else
    echo "    (does not exist)"
  fi
fi

# ── part 3: cron expressions and entry points ─────────────────────────────────
echo ""
echo "── sweep schedule & entry points ──"
echo "  stale-task-sweep cron:     */10 * * * *  (every 10 minutes)"
echo "  stale-task-sweep entry:    runStaleTaskSweep() in src/lib/jobs/stale-task-sweep.ts"
echo "  stuck-in-progress-sweep cron: */5 * * * *   (every 5 minutes)"
echo "  stuck-in-progress-sweep entry: runStuckInProgressSweep() in src/lib/jobs/stuck-in-progress-sweep.ts"

# ── part 4: SUMMARY — machine-greppable, no values ────────────────────────────
echo ""

# Determine stale status
stale_held=""
if [ -n "${!STALE:-}" ] && { [ "${!STALE}" = "1" ] || [ "${!STALE}" = "true" ] || [ "${!STALE}" = "yes" ] || [ "${!STALE}" = "on" ]; }; then
  stale_held="HELD-BY: env(DISABLE_STALE_TASK_SWEEP)"
fi
# Check env files (in order, first set wins for reporting)
if [ -z "$stale_held" ]; then
  for fname in "${ENV_FILES[@]}"; do
    ff="$ROOT/$fname"
    if [ -f "$ff" ] || [ -L "$ff" ]; then
      if /usr/bin/grep -aqE "^[[:space:]]*(export[[:space:]]+)?DISABLE_STALE_TASK_SWEEP[[:space:]]*=" "$ff"; then
        stale_held="HELD-BY: env-file($fname)"
        break
      fi
    fi
  done
fi
# Check durable file candidates for stale
if [ -z "$stale_held" ]; then
  for cand in "${HOME:-$HOME}/.blackceo/command-center/operator-overrides.env" "/data/.blackceo/command-center/operator-overrides.env"; do
    if [ -f "$cand" ] || [ -L "$cand" ]; then
      if /usr/bin/grep -aqE "^[[:space:]]*(export[[:space:]]+)?DISABLE_STALE_TASK_SWEEP[[:space:]]*=" "$cand"; then
        stale_held="HELD-BY: durable-file($cand)"
        break
      fi
    fi
  done
fi
if [ -z "$stale_held" ]; then
  stale_held="CLEAR"
fi

# Determine stuck status
stuck_held=""
if [ -n "${!STUCK:-}" ] && { [ "${!STUCK}" = "1" ] || [ "${!STUCK}" = "true" ]; }; then
  stuck_held="HELD-BY: env(DISABLE_STUCK_IN_PROGRESS_SWEEP)"
fi
if [ -z "$stuck_held" ]; then
  for fname in "${ENV_FILES[@]}"; do
    ff="$ROOT/$fname"
    if [ -f "$ff" ] || [ -L "$ff" ]; then
      if /usr/bin/grep -aqE "^[[:space:]]*(export[[:space:]]+)?DISABLE_STUCK_IN_PROGRESS_SWEEP[[:space:]]*=" "$ff"; then
        stuck_held="HELD-BY: env-file($fname)"
        break
      fi
    fi
  done
fi
if [ -z "$stuck_held" ]; then
  stuck_held="CLEAR"
fi

echo "SUMMARY: stale=$stale_held stuck=$stuck_held"
