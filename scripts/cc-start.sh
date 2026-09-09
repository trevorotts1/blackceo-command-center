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

# ── 2b. BUILD CONTENT FRESHNESS GUARD (PRES-046) ─────────────────────────────
# BUILD-06: `next start` will happily boot onto a MISSING or STALE `.next` build.
# When an updater pulls new code but never recompiles (BUILD-05 class), the
# server keeps serving the OLD build — the dead client Kanban. This guard runs
# on EVERY start path (ecosystem.config.cjs invokes this launcher) and:
#
#   1. FAIL-LOUD if `.next/BUILD_ID` is absent — there is no production build.
#   2. Verify the served build's CONTENT INVENTORY (PRES-046) against the
#      current source tree. The old mtime heuristic is GONE: `git pull`
#      re-stamps source mtimes and `cp -r` rollback re-stamps artifact mtimes,
#      so mtimes could both FALSE-ALARM (fresh old code flagged stale) and
#      FALSE-CLEAR (stale old code looks current). Content, never mtime, is
#      the oracle: the artifact carries an immutable build-inventory.json
#      manifest (written by atomic-deploy.sh pre-swap) whose inventory_digest
#      must equal the digest of the live source tree.
#
#   3. On MISMATCH, the mismatch is refused UNLESS a transaction-bound
#      rollback receipt ($CC_DIR/.deploy-rollback-state.json) binds EXACTLY
#      this pair: its rolled_back_to digest == the served artifact's manifest
#      digest AND its failed_target digest == the current source digest.
#      That is the legitimate "health check failed on the new build, we
#      deliberately restored the prior artifact" state — the box then serves
#      AVAILABLE BUT DEGRADED with pending repair, never target-current.
#      Any stale/tampered/foreign receipt is REFUSED (RECEIPT_INVALID /
#      RECEIPT_STALE). There is NO loose stale-bypass flag: the old
#      CC_ALLOW_STALE_BUILD=1 escape hatch is REMOVED — content identity
#      cannot be waived by an environment variable, only by a matching
#      receipt or a rebuild.
#
# EXIT CODE CONTRACT (consumes the PRES-045 deterministic-refusal contract):
# every refusal class below is DETERMINISTIC — restarting cannot fix a content
# mismatch, so a plain exit 1 would restart-loop exactly like the PRES-045
# stale-build loop (2,590 restarts measured on 2026-09-06). All content
# refusals therefore exit 78 (EX_CONFIG) and write the SAME durable refusal
# receipt PRES-045 defined ($CC_DIR/.cc-state/cc-start-refused.json, schema
# cc-start-refusal/1) so health/watchdog consumers see a CURRENT refusal with
# the content verdict as the reason. A transient crash still exits non-78
# elsewhere in this launcher.
#
# MERGE NOTE (PRES-046 ↔ PRES-045): WF17's lane rewrites this same guard with
# mtime staleness + exit 78 + _cc_refusal_receipt + _cc_delayed_self_stop +
# stop_exit_codes in both ecosystem files. PRES-046 SUPERSEDES the mtime scan
# with content verification (that is this unit's defect class). Compose at
# merge time by keeping PRES-045's receipt writer / self-stop /
# stop_exit_codes and replacing ONLY the staleness decision with the _ccbi
# verification below. Until that merge lands on one branch, the duplicate
# receipt writer here uses the identical schema and path, so consumers behave
# the same either way.
_assert_fresh_build() {
  local next_dir="$CC_DIR/.next"
  local build_id="$next_dir/BUILD_ID"

  # _ccbi_content_refusal_receipt <reason> <detail> — durable refusal receipt,
  # REAL JSON via node's encoder (same schema/path as the PRES-045 contract so
  # health/watchdog consumers cannot tell the two refusal classes apart except
  # by reason). Best-effort: a receipt write failure must never swallow the
  # refusal itself.
  _ccbi_content_refusal_receipt() {
    local reason="$1" detail="$2"
    local state_dir="$CC_DIR/.cc-state"
    mkdir -p "$state_dir" 2>/dev/null || return 0
    local tmp
    tmp="$(mktemp "$state_dir/.cc-refusal.XXXXXX" 2>/dev/null)" || return 0
    CCBI_REFUSAL_TMP="$tmp" CCBI_CC_DIR="$CC_DIR" CCBI_REASON="$reason" \
    CCBI_DETAIL="$detail" node -e '
      const fs = require("fs");
      const buildId = (() => { try { return fs.readFileSync(process.env.CCBI_CC_DIR + "/.next/BUILD_ID", "utf8").trim(); } catch { return null; } })();
      const doc = {
        schema: "cc-start-refusal/1",
        app: process.env.pm_id != null
          ? { pm_id: Number(process.env.pm_id), name: process.env.name ?? null }
          : { pm_id: null, name: process.env.name ?? null },
        generation: process.env.pm_uptime != null ? { started_at_ms: Number(process.env.pm_uptime) } : null,
        reason: process.env.CCBI_REASON,
        detail: process.env.CCBI_DETAIL,
        build_id: buildId,
        exit: 78,
        remedy: "bash scripts/atomic-deploy.sh",
        refused_at: new Date().toISOString()
      };
      fs.writeFileSync(process.env.CCBI_REFUSAL_TMP, JSON.stringify(doc, null, 2) + "\n", { mode: 0o644 });
    ' >/dev/null 2>&1 || { rm -f "$tmp"; return 0; }
    mv -f "$tmp" "$state_dir/cc-start-refused.json" 2>/dev/null || rm -f "$tmp"
    printf '[cc-start] Refusal receipt: %s\n' "$state_dir/cc-start-refused.json" >&2
  }

  _ccbi_refuse_deterministically() {
    local reason="$1" detail="$2"
    printf '[cc-start] FATAL: %s — %s\n' "$reason" "$detail" >&2
    printf '[cc-start] This is a DETERMINISTIC refusal (exit 78): restarting cannot fix it.\n' >&2
    printf '[cc-start] Rebuild before start: `bash scripts/atomic-deploy.sh` (preferred) or `npm run build`.\n' >&2
    _ccbi_content_refusal_receipt "$reason" "$detail"
    exit 78
  }

  # 1. MISSING build — deterministic, terminal (exit 78).
  if [[ ! -f "$build_id" ]]; then
    _ccbi_refuse_deterministically "missing-build" \
      "no production build found ($build_id missing); refusing to start onto a missing build"
  fi

  # PRES-046: content verification against the live source tree.
  local inv_lib="$CC_DIR/scripts/lib/build-inventory.sh"
  if [[ ! -f "$inv_lib" ]]; then
    _ccbi_refuse_deterministically "inventory-lib-missing" \
      "$inv_lib not found — content inventory unavailable (PRES-046); build cannot be verified against source"
  fi
  # shellcheck source=lib/build-inventory.sh
  # shellcheck disable=SC1090
  source "$inv_lib"

  local verify_json verify_rc verdict served_bid
  verify_json="$(bash "$inv_lib" --verify "$CC_DIR" 2>/dev/null)"
  verify_rc=$?
  verdict="$(printf '%s' "$verify_json" | sed -n 's/.*"verdict"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  served_bid="$(printf '%s' "$verify_json" | sed -n 's/.*"build_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

  case "$verify_rc" in
    0)
      # VERIFIED — served artifact is exactly the current source content.
      printf '[cc-start] BUILD freshness guard: content VERIFIED (BUILD_ID: %s).\n' "${served_bid:-unknown}" >&2
      return 0
      ;;
    2)
      # MANIFEST_MISSING: a legacy (pre-PRES-046) artifact legitimately remains
      # servable ONLY via the legacy-prior carve-out — the rollback receipt
      # written by the SAME deploy transaction that restored it binds it as
      # "(unattested)" and names THIS source tree as the failed target.
      local source_inv_missing rb_json_missing rb_rc_missing rb_verdict_missing
      source_inv_missing="$(_ccbi_inventory_digest "$CC_DIR")"
      rb_json_missing="$(bash "$inv_lib" --verify-rollback "$CC_DIR" "$next_dir" "$source_inv_missing" 2>/dev/null)"
      rb_rc_missing=$?
      rb_verdict_missing="$(printf '%s' "$rb_json_missing" | sed -n 's/.*"receipt_verdict"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
      if [[ "$rb_rc_missing" -eq 0 && "$rb_verdict_missing" == "RECEIPT_OK" ]]; then
        printf '[cc-start] DEGRADED (legacy-prior): serving a pre-inventory artifact with NO manifest after a failed deploy.\n' >&2
        printf '[cc-start] Rollback receipt VERIFIED (unattested prior, failed target = this source tree) — PRES-046.\n' >&2
        printf '[cc-start] AVAILABLE BUT DEGRADED: identity unattested, pending repair. NOT a successful upgrade.\n' >&2
        printf '[cc-start] Rebuild to restore content verification: bash scripts/atomic-deploy.sh.\n' >&2
        return 0
      fi
      _ccbi_refuse_deterministically "build-manifest-missing" \
        "$next_dir/build-inventory.json missing and rollback receipt ${rb_verdict_missing:-RECEIPT_INVALID} — nothing vouches for this artifact (PRES-046)"
      ;;
    3)
      _ccbi_refuse_deterministically "build-manifest-invalid" \
        "$next_dir/build-inventory.json truncated/tampered/corrupt — a corrupt manifest never silently downgrades to mtime trust (PRES-046)"
      ;;
    5)
      _ccbi_refuse_deterministically "obsolete-inventory" \
        "manifest was computed over a different compile-affecting input set than this tree has now — recorded inventory no longer covers what compiles (PRES-046)"
      ;;
    1)
      # MISMATCH — the only legitimate path is a transaction-bound rollback receipt
      # binding exactly this pair. Verify it.
      local source_inv rb_json rb_rc rb_verdict
      source_inv="$(_ccbi_inventory_digest "$CC_DIR")"
      rb_json="$(bash "$inv_lib" --verify-rollback "$CC_DIR" "$next_dir" "$source_inv" 2>/dev/null)"
      rb_rc=$?
      rb_verdict="$(printf '%s' "$rb_json" | sed -n 's/.*"receipt_verdict"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
      if [[ "$rb_rc" -eq 0 && "$rb_verdict" == "RECEIPT_OK" ]]; then
        printf '[cc-start] DEGRADED: serving the PRIOR artifact after a failed deploy (content mismatch vs source).\n' >&2
        printf '[cc-start] Rollback receipt VERIFIED — prior artifact and failed target both match (PRES-046).\n' >&2
        printf '[cc-start] AVAILABLE BUT DEGRADED: pending repair. This is NOT a successful upgrade and\n' >&2
        printf '[cc-start] commandCenterLastUpdateVerified must NOT report target-current. Repair by\n' >&2
        printf '[cc-start] rebuilding the failed target: bash scripts/atomic-deploy.sh.\n' >&2
        return 0
      elif [[ "$rb_rc" -eq 1 ]]; then
        _ccbi_refuse_deterministically "content-mismatch-stale-receipt" \
          "build/content MISMATCH vs source and rollback receipt ${rb_verdict:-STALE} — the receipt does not bind the served artifact to THIS source tree and cannot waive the mismatch (PRES-046)"
      else
        _ccbi_refuse_deterministically "content-mismatch-invalid-receipt" \
          "build/content MISMATCH vs source and rollback receipt ${rb_verdict:-RECEIPT_INVALID} — a missing/tampered/foreign marker never authorizes stale code (PRES-046)"
      fi
      ;;
    *)
      _ccbi_refuse_deterministically "content-verification-error" \
        "content verification failed with rc=$verify_rc (PRES-046)"
      ;;
  esac
}

_assert_fresh_build


# ── 3. EXEC next start ────────────────────────────────────────────────────────
# exec replaces this bash process so PM2's PID tracking points at the real node
# child — cc-health-check.sh pm2-analyze-cc.py regex `(--port|-p)\s+PORT` still
# matches because we pass --port explicitly.
printf '[cc-start] Launching: next start -p %s -H 0.0.0.0 (cwd: %s)\n' "$CC_PORT" "$CC_DIR" >&2

cd "$CC_DIR"
exec node "$CC_DIR/scripts/next-service-env.cjs" start -p "$CC_PORT" -H 0.0.0.0
