#!/usr/bin/env bash
# cc-start.sh — Canonical hardened launcher for the BlackCEO Command Center.
#
# Every start path (ecosystem.config.cjs, bootstrap, atomic-deploy, onboarding
# Phase 6) MUST invoke this script rather than calling `next start` directly.
# It provides three critical guarantees:
#
#   1. ENV-BLEED GUARD   — pins CC_PORT and strips any inherited PORT from the
#                          shell env so an OpenClaw gateway PORT (or a
#                          Hostinger-injected random PORT) can never override the
#                          CC's listen port.
#   2. ORPHAN-PORT KILLER — frees the CC port before next binds it, breaking the
#                           EADDRINUSE crash-loop that caused a client box's
#                           71,551 restarts. Works on Mac (lsof) and Linux (lsof/fuser).
#   3. CLEAN EXEC         — uses exec so PM2's PID tracking stays correct (the
#                           bash wrapper never hides the real node child).
#
# Usage:
#   bash scripts/cc-start.sh [--port PORT]
#   CC_PORT=4000 bash scripts/cc-start.sh
#
# The script is meant to run as the PM2 `script` + `args` target (see
# ecosystem.config.cjs).  Under PM2: PM2 passes CC_PORT via the env block.
#
# NOTE: Never call `openclaw gateway restart` from this script — it manages
# ONLY the Next.js CC process, not the OpenClaw gateway (Mac launchd rule).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── CLI flag parsing ───────────────────────────────────────────────────────────
ARG_PORT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      ARG_PORT="$2"; shift 2 ;;
    --port=*)
      ARG_PORT="${1#--port=}"; shift ;;
    *)
      shift ;;
  esac
done

# ── 1. ENV-BLEED GUARD ────────────────────────────────────────────────────────
# Resolve the canonical CC port: CLI flag → CC_PORT env var → default 4000.
# Then strip the inherited PORT entirely and re-export only our own port so no
# ambient OpenClaw gateway PORT or Hostinger injected PORT can reach next start.
CC_PORT="${ARG_PORT:-${CC_PORT:-4000}}"

# Unset ambient PORT before setting ours; also clear HOSTNAME stray if present.
unset PORT 2>/dev/null || true
export PORT="$CC_PORT"
export CC_PORT="$CC_PORT"
# Preserve NODE_ENV (default to production if unset).
export NODE_ENV="${NODE_ENV:-production}"

printf '[cc-start] ENV-BLEED GUARD: pinned PORT=%s (NODE_ENV=%s)\n' "$CC_PORT" "$NODE_ENV" >&2

# ── 2. ORPHAN-PORT KILLER ─────────────────────────────────────────────────────
# Find any process currently LISTENing on the CC port and kill it before next
# tries to bind.  Uses lsof (Mac + most Linux); falls back to fuser (Linux).
# If neither tool is available, fails loudly so the PM2 circuit-breaker (not an
# infinite EADDRINUSE loop) takes over.
#
# Safety: only LISTEN sockets on the exact port are targeted — never a kill-by-name.
#
# SELF-PID SAFETY (v4.55.3): now that the whole fleet runs the CC under ONE
# canonical pm2 app name ("blackceo-command-center" — see ecosystem.config.cjs
# and the onboarding installer's Phase 6 reconcile), there is no sibling CC to
# mutually kill, so this killer can no longer cause the two-process fight that
# amplified the :4000 crash loop. As defence-in-depth we ALSO hard-exclude this
# launcher's own pid ($$) and its pm2/npm supervisor ($PPID) from the kill list
# so cc-start.sh can never SIGTERM the very process tree supervising the
# canonical CC. Any LISTENer that remains after that exclusion is, by
# definition, a stale orphan from a prior boot/restart and is safe to reclaim.

# _cc_strip_protected — echo the input pid list ($3) with the protected pids
# (self $1, parent $2) removed.
_cc_strip_protected() {
  local self="$1" parent="$2" list="$3" out="" p
  for p in $list; do
    [[ "$p" == "$self" || "$p" == "$parent" ]] && continue
    out="${out:+$out }$p"
  done
  printf '%s' "$out"
}

free_port() {
  local port="$1"
  local pids=""
  local self_pid=$$
  local parent_pid="${PPID:-0}"

  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    pids="$(fuser "${port}/tcp" 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+$' || true)"
  else
    printf '[cc-start] FATAL: neither lsof nor fuser found — cannot check port %s for orphans\n' "$port" >&2
    printf '[cc-start] Install lsof (apt install lsof / brew install lsof) and retry\n' >&2
    exit 1
  fi

  # Never signal ourselves or our pm2/npm supervisor.
  pids="$(_cc_strip_protected "$self_pid" "$parent_pid" "$pids")"

  if [[ -z "$pids" ]]; then
    printf '[cc-start] ORPHAN-PORT KILLER: port %s is free\n' "$port" >&2
    return 0
  fi

  printf '[cc-start] ORPHAN-PORT KILLER: port %s held by pid(s): %s\n' "$port" "$pids" >&2
  for pid in $pids; do
    # Print cmdline so the log shows WHAT process was killed.
    local cmd
    cmd="$(ps -p "$pid" -o comm= 2>/dev/null || echo '<unknown>')"
    printf '[cc-start]   TERM -> pid %s (%s)\n' "$pid" "$cmd" >&2
    kill -TERM "$pid" 2>/dev/null || true
  done

  # Wait up to 5s for the port to be freed.
  local waited=0
  while [[ $waited -lt 5 ]]; do
    sleep 1
    waited=$((waited+1))
    local remaining=""
    if command -v lsof >/dev/null 2>&1; then
      remaining="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
    else
      remaining="$(fuser "${port}/tcp" 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+$' || true)"
    fi
    remaining="$(_cc_strip_protected "$self_pid" "$parent_pid" "$remaining")"
    if [[ -z "$remaining" ]]; then
      printf '[cc-start]   port %s freed after %ss\n' "$port" "$waited" >&2
      return 0
    fi
    # Force-kill after 3s of TERM
    if [[ $waited -ge 3 ]]; then
      for pid in $remaining; do
        printf '[cc-start]   KILL -> pid %s (still holding port after TERM)\n' "$pid" >&2
        kill -KILL "$pid" 2>/dev/null || true
      done
    fi
  done

  # Final re-probe — if still occupied, abort to let the PM2 circuit-breaker handle it.
  local final_check=""
  if command -v lsof >/dev/null 2>&1; then
    final_check="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
  else
    final_check="$(fuser "${port}/tcp" 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+$' || true)"
  fi
  final_check="$(_cc_strip_protected "$self_pid" "$parent_pid" "$final_check")"
  if [[ -n "$final_check" ]]; then
    printf '[cc-start] FATAL: port %s still occupied after TERM+KILL — pid(s): %s\n' "$port" "$final_check" >&2
    printf '[cc-start] Aborting so the PM2 circuit-breaker (not an infinite EADDRINUSE loop) takes over\n' >&2
    exit 1
  fi
}

free_port "$CC_PORT"

# ── 2b. BUILD-ID FRESHNESS GUARD ──────────────────────────────────────────────
# BUILD-06: `next start` will happily boot onto a MISSING or STALE `.next` build.
# When an updater pulls new code but never recompiles (BUILD-05 class), the
# server keeps serving the OLD build — the dead client Kanban. This guard runs
# on EVERY start path (ecosystem.config.cjs invokes this launcher) and:
#
#   1. FAIL-LOUD if `.next/BUILD_ID` is absent — there is no production build.
#   2. FAIL-LOUD if the build is STALE — any file under src/ (or package.json /
#      next.config.*) is NEWER than `.next/BUILD_ID`, meaning the code was
#      updated after the last compile. `git reset --hard` (the updater's pull)
#      re-stamps source mtimes, so an un-rebuilt update trips this cleanly.
#
# Exiting non-zero here makes PM2's circuit-breaker (min_uptime + max_restarts)
# surface the problem LOUDLY (errored state + watchdog alert) instead of quietly
# serving stale bytes. Rebuild with `bash scripts/atomic-deploy.sh` (preferred)
# or `npm run build`, then the next restart clears the guard.
#
# Escape hatch (NOT recommended): CC_ALLOW_STALE_BUILD=1 downgrades the staleness
# failure to a warning. The MISSING-build failure is never bypassable — there is
# nothing to serve.
_assert_fresh_build() {
  local next_dir="$CC_DIR/.next"
  local build_id="$next_dir/BUILD_ID"

  if [[ ! -f "$build_id" ]]; then
    printf '[cc-start] FATAL: no production build found (%s missing).\n' "$build_id" >&2
    printf '[cc-start] `next start` requires a compiled build. Run `bash scripts/atomic-deploy.sh` (preferred)\n' >&2
    printf '[cc-start] or `npm run build` first. Refusing to start onto a missing build so the PM2\n' >&2
    printf '[cc-start] circuit-breaker surfaces this loudly instead of an opaque crash-loop.\n' >&2
    exit 1
  fi

  # Staleness: is any source input NEWER than the compiled BUILD_ID?
  local newer=""
  local _src
  for _src in "$CC_DIR/src" "$CC_DIR/package.json" \
              "$CC_DIR/next.config.js" "$CC_DIR/next.config.mjs" "$CC_DIR/next.config.ts"; do
    [[ -e "$_src" ]] || continue
    if [[ -n "$(find "$_src" -newer "$build_id" -print -quit 2>/dev/null)" ]]; then
      newer="$_src"; break
    fi
  done

  if [[ -n "$newer" ]]; then
    if [[ "${CC_ALLOW_STALE_BUILD:-0}" == "1" ]]; then
      printf '[cc-start] WARN: STALE build (%s is newer than .next/BUILD_ID) — starting anyway because CC_ALLOW_STALE_BUILD=1.\n' "$newer" >&2
    else
      printf '[cc-start] FATAL: STALE build — %s is newer than .next/BUILD_ID.\n' "$newer" >&2
      printf '[cc-start] The running code was updated but never recompiled (BUILD-05/BUILD-06 dead-Kanban class).\n' >&2
      printf '[cc-start] Rebuild before start: `bash scripts/atomic-deploy.sh` (preferred) or `npm run build`.\n' >&2
      printf '[cc-start] To bypass for a single start (NOT recommended): CC_ALLOW_STALE_BUILD=1.\n' >&2
      exit 1
    fi
  fi

  printf '[cc-start] BUILD-ID freshness guard: .next/BUILD_ID present and fresh.\n' >&2
}

_assert_fresh_build

# ── 3. EXEC next start ────────────────────────────────────────────────────────
# exec replaces this bash process so PM2's PID tracking points at the real node
# child — cc-health-check.sh pm2-analyze-cc.py regex `(--port|-p)\s+PORT` still
# matches because we pass --port explicitly.
printf '[cc-start] Launching: next start -p %s -H 0.0.0.0 (cwd: %s)\n' "$CC_PORT" "$CC_DIR" >&2

cd "$CC_DIR"
exec npx next start -p "$CC_PORT" -H 0.0.0.0
