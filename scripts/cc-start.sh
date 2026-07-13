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
#                           71,551 restarts. Works on Mac (lsof), Linux (lsof or
#                           fuser), AND the Hostinger VPS container which ships
#                           neither — there it falls back to a pure-python3
#                           /proc/net parser so the orphan is still found+killed.
#   3. CLEAN EXEC         — uses exec so PM2's PID tracking stays correct (the
#                           bash wrapper never hides the real node child).
#   4. NON-4000 DRIFT ACK GUARD (P1-02) — if the resolved port is anything
#                          other than the canonical 4000, print a LOUD warning
#                          naming the drift's source and refuse to start
#                          unless CC_PORT_OVERRIDE_ACK=1 is set. Nobody drifts
#                          off :4000 silently again.
#
# Usage:
#   bash scripts/cc-start.sh [--port PORT]
#   CC_PORT=4000 bash scripts/cc-start.sh
#   CC_PORT=3000 CC_PORT_OVERRIDE_ACK=1 bash scripts/cc-start.sh   # deliberate override
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
# Capture the RAW inbound env CC_PORT (before we overwrite it below) so the
# 1b. NON-4000 DRIFT ACK GUARD can name the exact source of a drift.
_CC_PORT_ENV_ORIG="${CC_PORT:-}"
CC_PORT="${ARG_PORT:-${CC_PORT:-4000}}"

# Unset ambient PORT before setting ours; also clear HOSTNAME stray if present.
unset PORT 2>/dev/null || true
export PORT="$CC_PORT"
export CC_PORT="$CC_PORT"
# Preserve NODE_ENV (default to production if unset).
export NODE_ENV="${NODE_ENV:-production}"

printf '[cc-start] ENV-BLEED GUARD: pinned PORT=%s (NODE_ENV=%s)\n' "$CC_PORT" "$NODE_ENV" >&2

# ── 1b. NON-4000 DRIFT ACK GUARD (P1-02 Unit B, item 4) ───────────────────────
# Port 4000 is the ONE canonical CC port fleet-wide — the Cloudflare tunnel
# ingress → cloudflared → localhost:PORT → pm2 → Next.js chain only holds
# together when every hop agrees on :4000 (P1-02). This is belt-and-suspenders
# alongside the ingress-side repair (Unit A): nothing here stops a human or
# agent from exporting CC_PORT=3000 or passing --port 3000 — the operator can
# still deliberately run elsewhere — but nobody drifts there SILENTLY. Runs
# BEFORE the orphan-port killer and BEFORE the build check so a refused start
# has zero side effects on whatever the requested port happens to be running.
if [[ "$CC_PORT" != "4000" ]]; then
  _cc_port_source="unknown source"
  if [[ -n "$ARG_PORT" ]]; then
    _cc_port_source="--port CLI flag (value: $ARG_PORT)"
  elif [[ -n "$_CC_PORT_ENV_ORIG" ]]; then
    _cc_port_source="CC_PORT environment variable (value: $_CC_PORT_ENV_ORIG)"
  fi
  printf '[cc-start] ==================================================================\n' >&2
  printf '[cc-start] LOUD WARNING: CC_PORT resolved to %s, NOT the canonical port 4000.\n' "$CC_PORT" >&2
  printf '[cc-start] Source of the drift: %s\n' "$_cc_port_source" >&2
  printf '[cc-start] Port 4000 is the universal fleet decision (P1-02). Starting elsewhere\n' >&2
  printf "[cc-start] breaks this box's Cloudflare tunnel -> localhost link for the client.\n" >&2
  printf '[cc-start] ==================================================================\n' >&2
  if [[ "${CC_PORT_OVERRIDE_ACK:-0}" != "1" ]]; then
    printf '[cc-start] FATAL: refusing to start on a non-canonical port without an explicit ACK.\n' >&2
    printf '[cc-start] If this is truly deliberate, re-run with CC_PORT_OVERRIDE_ACK=1.\n' >&2
    exit 1
  fi
  printf '[cc-start] CC_PORT_OVERRIDE_ACK=1 set — proceeding on port %s deliberately.\n' "$CC_PORT" >&2
fi

# ── 2. ORPHAN-PORT KILLER ─────────────────────────────────────────────────────
# Find any process currently LISTENing on the CC port and kill it before next
# tries to bind.  Enumerates the holder via lsof (Mac + most Linux), then fuser
# (Linux), then a pure-python3 /proc/net/tcp parser (the Hostinger VPS container
# ships python3 but NOT lsof/fuser — without this fallback the killer was a
# FATAL exit on every VPS box, taking the CC down instead of freeing the port).
# ONLY when none of those three methods is available (no lsof, no fuser, and no
# readable /proc) does it degrade to a LOUD warning + skip — never a silent skip
# and never a fatal exit — leaving PM2's circuit-breaker as the documented net.
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

# _cc_port_probe_method — echo the best available way to enumerate the pid(s)
# LISTENing on a TCP port: "lsof" | "fuser" | "python3" | "none". python3 is the
# container fallback (the Hostinger image has python3 but no lsof/fuser) and needs
# a readable /proc/net/tcp to parse.
_cc_port_probe_method() {
  if command -v lsof >/dev/null 2>&1; then
    printf 'lsof'
  elif command -v fuser >/dev/null 2>&1; then
    printf 'fuser'
  elif command -v python3 >/dev/null 2>&1 && [[ -r /proc/net/tcp ]]; then
    printf 'python3'
  else
    printf 'none'
  fi
}

# _cc_listeners_on_port <port> — echo the pid(s) LISTENing on the given TCP port,
# one per line (empty if none / no probe method). Tries lsof, then fuser, then a
# pure-python3 parser of /proc/net/tcp{,6} that maps the LISTEN socket's inode to
# the owning pid via /proc/<pid>/fd — so the orphan is still found on a container
# with no lsof/fuser. Always returns 0 (never trips `set -e`); callers gate the
# no-method case on _cc_port_probe_method.
_cc_listeners_on_port() {
  local port="$1"
  case "$(_cc_port_probe_method)" in
    lsof)
      lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true
      ;;
    fuser)
      fuser "${port}/tcp" 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+$' || true
      ;;
    python3)
      python3 - "$port" <<'PYPORT' 2>/dev/null || true
import os, sys, glob
port = int(sys.argv[1])
port_hex = '%04X' % port          # /proc/net local port is 4-hex-digit uppercase
LISTEN = '0A'                     # TCP_LISTEN state
inodes = set()
for path in ('/proc/net/tcp', '/proc/net/tcp6'):
    try:
        with open(path) as fh:
            next(fh)              # skip header row
            for line in fh:
                parts = line.split()
                if len(parts) < 10 or parts[3] != LISTEN:
                    continue
                if parts[1].rsplit(':', 1)[-1].upper() == port_hex:
                    inodes.add(parts[9])
    except OSError:
        continue
if inodes:
    pids = set()
    for fd in glob.glob('/proc/[0-9]*/fd/*'):
        try:
            link = os.readlink(fd)
        except OSError:
            continue
        if link.startswith('socket:[') and link[8:-1] in inodes:
            pids.add(fd.split('/')[2])
    for pid in sorted(pids, key=int):
        print(pid)
PYPORT
      ;;
    *)
      : ;;  # no probe method available — caller emits the LOUD warning
  esac
}

free_port() {
  local port="$1"
  local pids=""
  local self_pid=$$
  local parent_pid="${PPID:-0}"

  local probe_method
  probe_method="$(_cc_port_probe_method)"
  if [[ "$probe_method" == "none" ]]; then
    # No lsof, no fuser, and /proc/net/tcp is unreadable: we genuinely cannot
    # enumerate the port holder on this host. Do NOT fatal-exit (that would take
    # the CC down on a missing-tool box) and do NOT silently skip. Warn LOUDLY
    # and continue: if a real orphan holds the port, `next start` EADDRINUSEs and
    # PM2's circuit-breaker (min_uptime + max_restarts) surfaces it — the
    # documented fallback, not an infinite crash loop.
    printf '[cc-start] LOUD WARNING: no lsof, no fuser, and /proc/net/tcp is unreadable —\n' >&2
    printf '[cc-start] cannot enumerate the holder of port %s. SKIPPING the orphan-port kill.\n' "$port" >&2
    printf '[cc-start] Install lsof (apt-get install -y lsof) so the orphan killer works here.\n' >&2
    printf '[cc-start] If an orphan holds the port, PM2 max_restarts (not an infinite loop) will bite.\n' >&2
    return 0
  fi
  pids="$(_cc_listeners_on_port "$port")"

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
    remaining="$(_cc_listeners_on_port "$port")"
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
  final_check="$(_cc_listeners_on_port "$port")"
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
