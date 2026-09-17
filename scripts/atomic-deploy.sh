#!/usr/bin/env bash
# scripts/atomic-deploy.sh — B.2 Atomic Self-Verifying Deploy + Auto-Rollback
#
# PRD Addendum B, item B.2 (P0)
#
# USAGE
# -----
#   bash scripts/atomic-deploy.sh [OPTIONS]
#
# OPTIONS
#   --app-dir DIR        Canonical install directory (default: ~/projects/mission-control)
#   --pm2-app NAME       Canonical pm2 app name (default: mission-control)
#   --port PORT          Port the CC listens on (default: 4000)
#   --db-path PATH       Explicit path to mission-control.db (default: resolve from pm2/env)
#   --disk-path PATH     Filesystem path to check disk headroom on (default: $APP_DIR)
#   --disk-min-gb N      Minimum free GB required before build (default: 5)
#   --health-retries N   Number of times to retry after exit-3 UNKNOWN from health check (default: 36)
#   --health-retry-wait  Seconds to wait between exit-3 retries (default: 15)
#   --canonical-dir DIR  Pass-through to cc-health-check.sh --canonical-dir
#   --public-url URL     Pass-through to cc-health-check.sh --public-url
#
# ENVIRONMENT OVERRIDES
#   CC_HEALTH_CHECK_PATH  Override the path to cc-health-check.sh (used by fixture harnesses)
#
# EXIT CODES
#   0 — deploy succeeded; server is green on the new build
#   1 — deploy failed; server was rolled back to prior build (health check confirmed rollback green)
#   2 — pre-flight failure (disk, backup, or build error) — rollback NOT needed, old build untouched
#   3 — UNKNOWN / indeterminate — health check returned 3 after all retries; deploy NOT rolled back
#       (the box is in an unknown state; operator must investigate)
#
# PHASE 5 SELF-MAINTENANCE (best-effort, never changes the deploy's exit code)
#   Every green deploy also (a) installs + pins pm2-logrotate so pm2 logs cannot
#   fill the disk, and (b) installs the */5 schedule for scripts/watchdog-cc.sh
#   via scripts/install-watchdog-cc.sh with WATCHDOG_SELF_HEAL=1. Until this
#   existed, the box watchdog documented a crontab schedule that nothing in the
#   repo ever installed, so on a box where the CC stopped answering there was
#   no out-of-process repair at all. Both steps are idempotent.
#
# INVARIANTS (from B.2 spec)
#   Never partial     — the live .next is replaced by a single atomic rename/move
#   Never unverified  — every deploy is followed by cc-health-check.sh
#   Never silent fail — a non-green result always produces a loud receipt with health-check JSON
#   Never disk-blind  — 5 GB disk gate runs before any build artifacts are written
#   Rollback verified — the rollback itself is health-checked before the script exits
#   Never rollback 3  — exit 3 (UNKNOWN/transient) triggers retry, never rollback
#
# REQUIRES: bash 4+, pm2, npm, python3, curl, df
#           (no sqlite3 CLI: the pre-backup WAL checkpoint uses python3's stdlib
#            sqlite3 module — the Linux/VPS container ships python3 but NOT the
#            sqlite3 command-line binary.)
#           lsof is OPTIONAL: Phase 1d uses it to find who is bound to the
#           canonical port; without it, declared-port matching (pm2 jlist
#           args/env) still works.

set -uo pipefail

###############################################################################
# Bash 4+ guard
###############################################################################
if [[ "${BASH_VERSINFO[0]:-0}" -lt 4 ]]; then
  printf 'ERROR: atomic-deploy.sh requires bash 4+. macOS ships bash 3.2.\n' >&2
  printf 'Install: brew install bash, then invoke with /opt/homebrew/bin/bash\n' >&2
  exit 2
fi

###############################################################################
# Defaults
###############################################################################
APP_DIR="${CC_APP_DIR:-${HOME}/projects/command-center}"
# PM2_APP_NAME defaults to the FLEET-CANONICAL name (PORT-FIX-2). The old
# default resolved to "cc-prod"/"mission-control" — legacy aliases that this
# deploy would target with zero flags, silently restarting a NON-canonical
# process (or spawning a second CC) instead of the board. The canonical name is
# what ecosystem.config.cjs, the onboarding installer Phase 6, the watchdog, and
# every per-box dedup standardize on; a flag-less deploy must default to it.
if [[ -n "${CC_PM2_APP_NAME:-}" ]]; then
  PM2_APP_NAME="${CC_PM2_APP_NAME}"
else
  PM2_APP_NAME="blackceo-command-center"
fi
PORT="${CC_PORT:-4000}"
DB_PATH_OVERRIDE="${CC_DB_PATH:-}"
DISK_PATH_OVERRIDE="${CC_DISK_PATH:-}"
DISK_MIN_GB="${CC_DISK_MIN_GB:-5}"
# HEALTH_RETRIES default: measured evidence, not a guess. teresa-pelham needed
# ~530s of post-restart boot work (WAL replay / DB recovery) on a 319 MB
# mission-control.db before the health check went green — the old default
# (3 retries x (15s probe + 15s wait) = ~95s worst case) reported exit 3
# (UNKNOWN) on a deploy that had actually succeeded. cassandra-henriquez is
# untested at 1.69 GB, >5x teresa's size. 36 retries x (15s probe + 15s wait)
# = ~1080s (18 min), ~2x the one real measured data point, WITHOUT assuming
# boot time scales linearly with DB size (unproven, and a full 5.3x linear
# extrapolation would push this past 2800s). If a larger DB is measured and
# exceeds this window, raise it again from that new data point.
HEALTH_RETRIES="${CC_HEALTH_RETRIES:-36}"
HEALTH_RETRY_WAIT="${CC_HEALTH_RETRY_WAIT:-15}"
CANONICAL_DIR_OVERRIDE="${CC_CANONICAL_DIR:-}"
PUBLIC_URL_PROBE="${CC_PUBLIC_URL:-}"
# Fixture harness override: if set, use this path for cc-health-check.sh instead of SCRIPT_DIR
HEALTH_CHECK_PATH_OVERRIDE="${CC_HEALTH_CHECK_PATH:-}"

###############################################################################
# Argument parsing
###############################################################################
APP_DIR_EXPLICIT=0   # PORT-FIX-2: set when --app-dir is passed on the CLI
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir)           APP_DIR="${2:?--app-dir requires a value}"; APP_DIR_EXPLICIT=1; shift 2 ;;
    --pm2-app)           PM2_APP_NAME="${2:?--pm2-app requires a value}"; shift 2 ;;
    --port)              PORT="${2:?--port requires a value}"; shift 2 ;;
    --db-path)           DB_PATH_OVERRIDE="${2:?--db-path requires a value}"; shift 2 ;;
    --disk-path)         DISK_PATH_OVERRIDE="${2:?--disk-path requires a value}"; shift 2 ;;
    --disk-min-gb)       DISK_MIN_GB="${2:?--disk-min-gb requires a value}"; shift 2 ;;
    --health-retries)    HEALTH_RETRIES="${2:?--health-retries requires a value}"; shift 2 ;;
    --health-retry-wait) HEALTH_RETRY_WAIT="${2:?--health-retry-wait requires a value}"; shift 2 ;;
    --canonical-dir)     CANONICAL_DIR_OVERRIDE="${2:?--canonical-dir requires a value}"; shift 2 ;;
    --public-url)        PUBLIC_URL_PROBE="${2:?--public-url requires a value}"; shift 2 ;;
    *) printf 'ERROR: Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

###############################################################################
# Helpers
###############################################################################
BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
CYAN=$'\033[36m'; RESET=$'\033[0m'

_ts()     { date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null; }
_log()    { printf '%s[atomic-deploy]%s %s\n' "${CYAN}" "${RESET}" "$*" >&2; }
_ok()     { printf '%s[atomic-deploy OK]%s %s\n' "${GREEN}" "${RESET}" "$*" >&2; }
_warn()   { printf '%s[atomic-deploy WARN]%s %s\n' "${YELLOW}" "${RESET}" "$*" >&2; }
_err()    { printf '%s[atomic-deploy ERROR]%s %s\n' "${RED}" "${RESET}" "$*" >&2; }
_banner() { printf '\n%s═══ %s ═══%s\n' "${BOLD}" "$*" "${RESET}" >&2; }

# Resolve the script's own directory so we can call cc-health-check.sh portably
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── ISSUE-09: pin the node this deploy uses ──────────────────────────────────
# The native gate below already takes CCBI_NODE_BIN, but nothing ever set it,
# so it fell through to `command -v node`: the DEPLOY SHELL's node, not the one
# pm2 will exec. A gate that loads better-sqlite3 under a different ABI than
# the runtime proves nothing about the runtime, which is how the
# NODE_MODULE_VERSION crash loop survived every deploy meant to catch it.
#
# scripts/lib/node-runtime.sh is the single place that decides which node the
# Command Center uses. It resolves for CONSISTENCY, not by version: the node
# recorded in the served artifact's manifest, then the node the live pm2
# process runs on, before any pin or PATH. Resolving it here and exporting it
# means the gates, `npm ci`, `npm run build`, every `npm rebuild` and the
# server's own exec all agree, and the manifest lib/build-inventory.sh writes
# records THIS node's path and module ABI, so the next update reuses the same
# binary and cc-start.sh can check the artifact against the runtime.
#
# Non-fatal on failure: an older checkout may not carry the resolver, and this
# script must stay able to deploy it. The fallback is the previous behaviour
# (the deploy shell's node), announced loudly rather than assumed.
if [[ -f "${SCRIPT_DIR}/lib/node-runtime.sh" ]]; then
  if _cc_node_resolved="$(bash "${SCRIPT_DIR}/lib/node-runtime.sh")"; then
    CC_NODE_BIN="$_cc_node_resolved"
    export CC_NODE_BIN
  else
    _warn "lib/node-runtime.sh could not resolve any usable node (see above)."
    _warn "Falling back to the deploy shell's own node. The build and the server may disagree on native ABI."
  fi
else
  _warn "lib/node-runtime.sh not found beside atomic-deploy.sh; using the deploy shell's own node."
fi
CC_NODE_BIN="${CC_NODE_BIN:-$(command -v node 2>/dev/null || printf 'node')}"
CC_NODE_DIR="$(dirname "$CC_NODE_BIN")"
# Feed the existing native-module gate hook, so it stops falling through to
# `command -v node`.
export CCBI_NODE_BIN="${CCBI_NODE_BIN:-$CC_NODE_BIN}"
# Put the runtime directory first ONLY when PATH would otherwise resolve a
# DIFFERENT node, which is the only case where the prepend changes anything.
#
# An unconditional prepend is too blunt and was measured to break things. That
# directory holds an `npm` as well as a `node`, so pushing it to the front also
# overrides whatever npm PATH deliberately pointed at. The B.2 atomic-deploy
# fixtures put a stub npm on PATH (their staged `npm ci` fabricates a fake
# better-sqlite3 rather than installing anything); an unconditional prepend
# shadowed that stub with the runner's real npm, the staging directory got no
# node_modules, and ten deploy tests failed on a promotion step that had nothing
# to do with this change. It passed locally only because this machine's node
# directory happens to contain no npm, so nothing was shadowed.
#
# When the resolved node is already the one PATH finds, PATH is correct as it
# stands and rewriting it can only do harm.
_cc_path_node="$(command -v node 2>/dev/null || printf '')"
if [[ "$_cc_path_node" != "$CC_NODE_BIN" ]]; then
  export PATH="${CC_NODE_DIR}:${PATH}"
  _log "  PATH now leads with ${CC_NODE_DIR} (it previously resolved node to ${_cc_path_node:-<none>})."
fi
_log "Node runtime for this deploy: ${CC_NODE_BIN} ($("$CC_NODE_BIN" --version 2>/dev/null || echo 'version unreadable'), module ABI $("$CC_NODE_BIN" -p process.versions.modules 2>/dev/null || echo unknown))"

# Backup retention + disk pre-check (OPENCLAW-BACKUP-RETENTION-V1). Always
# ships beside this script. If a checkout somehow lacks it, define no-ops so a
# deploy is never blocked by a missing helper — but say so loudly, because a
# run without pruning is exactly how backups accumulated in the first place.
if [[ -f "${SCRIPT_DIR}/lib/backup-retention.sh" ]]; then
  # shellcheck source=lib/backup-retention.sh
  source "${SCRIPT_DIR}/lib/backup-retention.sh"
else
  _warn "lib/backup-retention.sh not found beside atomic-deploy.sh — backups will NOT be pruned this run."
  oc_backup_size_kb() { echo 0; }
  oc_backup_precheck_disk() { return 0; }
  oc_backup_prune() { return 0; }
fi

# pm2 log rotation (Phase 5). Same posture as backup retention above: always
# ships beside this script, and a checkout without it degrades to a no-op with
# a loud warning rather than failing a deploy over log hygiene.
if [[ -f "${SCRIPT_DIR}/lib/pm2-logrotate.sh" ]]; then
  # shellcheck source=lib/pm2-logrotate.sh
  source "${SCRIPT_DIR}/lib/pm2-logrotate.sh"
else
  _warn "lib/pm2-logrotate.sh not found beside atomic-deploy.sh — pm2 logs will NOT be rotated on this box."
  oc_ensure_pm2_logrotate() { return 0; }
fi

# CC_HEALTH_CHECK_PATH env var allows fixture harnesses to inject a stub
# without needing to copy files into SCRIPT_DIR.
if [[ -n "$HEALTH_CHECK_PATH_OVERRIDE" ]]; then
  HEALTH_CHECK="$HEALTH_CHECK_PATH_OVERRIDE"
else
  HEALTH_CHECK="${SCRIPT_DIR}/cc-health-check.sh"
fi

if [[ ! -f "$HEALTH_CHECK" ]]; then
  _err "cc-health-check.sh not found at: $HEALTH_CHECK"
  _err "B.1 must be on main and merged before atomic-deploy.sh can run."
  exit 2
fi

###############################################################################
# Disk free check (portable: handles both Linux and macOS df output)
###############################################################################
_free_gb() {
  local path="$1"
  # df -k gives 1K blocks; $4 is Available on both Linux and macOS
  local kb
  kb=$(df -k "$path" 2>/dev/null | awk 'NR==2 {print $4}') || true
  if [[ -z "$kb" || ! "$kb" =~ ^[0-9]+$ ]]; then
    echo "0"
    return
  fi
  # Convert KB → GB with one decimal; print as float via awk then truncate to integer
  awk -v kb="$kb" 'BEGIN { printf "%d", kb / 1048576 }'
}

###############################################################################
# Disk cleanup
# Removes: old DB backups (*.backup.*), npm cache, Next.js temp/trace files,
# pm2 logs older than 7 days. Runs cleanup BEFORE re-checking disk.
###############################################################################
_disk_cleanup() {
  local dir="$1"
  _log "Running disk cleanup in ${dir} ..."

  # Old DB backups THIS SCRIPT created (mission-control.db.backup.autodeploy.<timestamp>).
  #
  # This used to be an unconditional `-delete` of EVERY mission-control.db.backup.*
  # — and it runs in phase 1a, BEFORE phase 1b writes this deploy's backup. So a
  # disk-pressured deploy destroyed the entire DB backup history, including the
  # last known-good one, and then took its own. That is the exact failure the
  # retention policy exists to prevent. Now it keeps the newest N (default 3,
  # OPENCLAW_BACKUP_KEEP) and prints every decision.
  #
  # BUG-2 FIX: the prefix is scoped to the ".autodeploy." marker this script's
  # OWN backup-creation code path stamps into the filename below (Phase 1b). A
  # bare "mission-control.db.backup." prefix also matches operator/human-made
  # backups (e.g. mission-control.db.backup.20260730-221422, which carries no
  # such marker) — this is exactly the defect that deleted three protected
  # historical backups on this box once. Never widen this back to the bare
  # pattern; retention must only ever prune what it itself created.
  oc_backup_prune "$dir" "mission-control.db.backup.autodeploy." ""

  # npm cache
  npm cache clean --force 2>/dev/null || true

  # Next.js trace and cache files
  rm -rf "${dir}/.next/trace" "${dir}/.next/cache" 2>/dev/null || true

  # pm2 logs older than 7 days
  find "${HOME}/.pm2/logs" -type f -name "*.log" -mtime +7 -delete 2>/dev/null || true

  # Stale .next.tmp build dirs left by interrupted prior deploys
  find "$dir" -maxdepth 1 -type d -name ".next.tmp.*" -mtime +1 -exec rm -rf {} + 2>/dev/null || true

  _log "Disk cleanup done."
}

###############################################################################
# Build cc-health-check.sh arguments from our own config
###############################################################################
_health_check_args() {
  local -a args=()
  args+=(--port "$PORT")
  # Trap-4: tell the health check WHICH app it is gating. Without this the pm2
  # topology check falls back to its default target name and can mistake a
  # co-resident demo/staging CC instance for a duplicate of this one — which
  # failed the gate and auto-rolled back a good deploy on a box that legitimately
  # runs several CC apps on different ports.
  # Version-skew guard: a cc-health-check.sh predating --app-name exits 2 on an
  # unknown flag, and exit 2 is treated as a definitive fail (→ rollback) at the
  # verdict loop below. Only pass the flag when the resolved health check
  # advertises it; otherwise fall back to the old, unscoped behaviour.
  if grep -q -- '--app-name' "$HEALTH_CHECK" 2>/dev/null; then
    args+=(--app-name "$PM2_APP_NAME")
  fi
  args+=(--disk-min-gb 0.5)   # runtime threshold; B.4 build gate uses 5 GB (handled by us)
  args+=(--json-only)
  [[ -n "$DB_PATH_OVERRIDE" ]]    && args+=(--db-path "$DB_PATH_OVERRIDE")
  [[ -n "$CANONICAL_DIR_OVERRIDE" ]] && args+=(--canonical-dir "$CANONICAL_DIR_OVERRIDE")
  [[ -n "$PUBLIC_URL_PROBE" ]]    && args+=(--public-url "$PUBLIC_URL_PROBE")
  printf '%s\n' "${args[@]}"
}

###############################################################################
# Run cc-health-check.sh, capture JSON, return its exit code
# Usage: _run_health_check <json_outvar>
# Sets the named variable to the JSON string.
# Returns the exit code of cc-health-check.sh (0, 1, 2, or 3).
###############################################################################
_run_health_check() {
  local outvar="$1"
  local json_tmp
  # Portable mktemp: GNU coreutils mktemp REQUIRES an XXXXXX template in the
  # trailing path component and fails closed without one ("too few X's in
  # template") on every Linux/VPS box; BSD/macOS is lenient, which is why the
  # old fixed-name form only broke on the container. The value is used purely as
  # an opaque temp path below (redirect target, cat, rm) — nothing depends on a
  # .json extension — so the suffix is dropped to stay portable across GNU/BSD.
  json_tmp=$(mktemp "${TMPDIR:-/tmp}/atomic-cc-health-XXXXXX")
  local hc_exit=0

  # Build args array from helper
  local -a hc_args=()
  while IFS= read -r a; do
    hc_args+=("$a")
  done < <(_health_check_args)

  /opt/homebrew/bin/bash "$HEALTH_CHECK" "${hc_args[@]}" > "$json_tmp" 2>/dev/null || hc_exit=$?

  # Fallback: if Homebrew bash not found, use system bash and let the script's own guard handle it
  if [[ $hc_exit -eq 127 ]]; then
    hc_exit=0
    bash "$HEALTH_CHECK" "${hc_args[@]}" > "$json_tmp" 2>/dev/null || hc_exit=$?
  fi

  local json_content
  json_content=$(cat "$json_tmp" 2>/dev/null || true)
  rm -f "$json_tmp"

  # Assign to caller's variable
  printf -v "$outvar" '%s' "$json_content"
  return "$hc_exit"
}

###############################################################################
# Receipt printers
###############################################################################
_success_receipt() {
  local health_json="$1" build_id="$2"
  printf '\n%s╔══════════════════════════════════════════════════════════╗%s\n' "$GREEN" "$RESET" >&2
  printf '%s║  ATOMIC DEPLOY SUCCESS                                   ║%s\n' "$GREEN" "$RESET" >&2
  printf '%s╚══════════════════════════════════════════════════════════╝%s\n' "$GREEN" "$RESET" >&2
  printf '  Timestamp    : %s\n' "$(_ts)" >&2
  printf '  Build ID     : %s\n' "${build_id:-unknown}" >&2
  printf '  App dir      : %s\n' "$APP_DIR" >&2
  printf '  pm2 app      : %s\n' "$PM2_APP_NAME" >&2
  printf '  Health check : GREEN\n' >&2
  printf '  Health JSON  :\n%s\n\n' "$health_json" >&2
}

_rollback_receipt() {
  local deploy_health_json="$1" rollback_health_json="$2" reason="$3"
  printf '\n%s╔══════════════════════════════════════════════════════════╗%s\n' "$RED" "$RESET" >&2
  printf '%s║  ATOMIC DEPLOY FAILED — AUTO-ROLLBACK EXECUTED           ║%s\n' "$RED" "$RESET" >&2
  printf '%s╚══════════════════════════════════════════════════════════╝%s\n' "$RED" "$RESET" >&2
  printf '  Timestamp        : %s\n' "$(_ts)" >&2
  printf '  App dir          : %s\n' "$APP_DIR" >&2
  printf '  pm2 app          : %s\n' "$PM2_APP_NAME" >&2
  printf '  Failure reason   : %s\n' "$reason" >&2
  printf '  Deploy health JSON (failed build):\n%s\n' "$deploy_health_json" >&2
  printf '  Rollback health JSON (restored build):\n%s\n\n' "$rollback_health_json" >&2
}

_unknown_receipt() {
  local health_json="$1" attempt="$2" max="$3"
  printf '\n%s╔══════════════════════════════════════════════════════════╗%s\n' "$YELLOW" "$RESET" >&2
  printf '%s║  ATOMIC DEPLOY — HEALTH CHECK UNKNOWN (exit 3)           ║%s\n' "$YELLOW" "$RESET" >&2
  printf '%s╚══════════════════════════════════════════════════════════╝%s\n' "$YELLOW" "$RESET" >&2
  printf '  Timestamp    : %s\n' "$(_ts)" >&2
  printf '  Attempt      : %s / %s\n' "$attempt" "$max" >&2
  printf '  Health JSON  :\n%s\n\n' "$health_json" >&2
}

_preflight_abort_receipt() {
  local reason="$1"
  printf '\n%s╔══════════════════════════════════════════════════════════╗%s\n' "$RED" "$RESET" >&2
  printf '%s║  ATOMIC DEPLOY ABORTED — PRE-FLIGHT FAILURE              ║%s\n' "$RED" "$RESET" >&2
  printf '%s╚══════════════════════════════════════════════════════════╝%s\n' "$RED" "$RESET" >&2
  printf '  Timestamp   : %s\n' "$(_ts)" >&2
  printf '  Reason      : %s\n' "$reason" >&2
  printf '  Note        : live .next directory was NOT touched.\n\n' >&2
}

###############################################################################
# Validate required tools
###############################################################################
for _dep in pm2 npm python3 curl df; do
  if ! command -v "$_dep" &>/dev/null; then
    _err "Required dependency missing: $_dep"
    exit 2
  fi
done

###############################################################################
# Validate app dir
###############################################################################
if [[ ! -d "$APP_DIR" ]]; then
  _err "APP_DIR does not exist: $APP_DIR"
  _err "Pass --app-dir or set CC_APP_DIR"
  exit 2
fi

# PORT-FIX-2: a FLAG-LESS invocation must never deploy onto a scratch/non-CC
# directory. The old default (~/projects/mission-control) or a bare
# `bash scripts/atomic-deploy.sh` could target a directory that is NOT a
# validated blackceo-command-center checkout, restarting a stale/foreign app or
# spawning a second CC. Require --app-dir OR CC_APP_DIR OR a directory that
# structurally validates as a blackceo-command-center checkout (git repo whose
# origin names the CC repo, package.json present, and the canonical
# ecosystem.config.cjs present). Any other flag-less run exits non-zero BEFORE
# touching anything.
if [[ "$APP_DIR_EXPLICIT" -eq 0 && -z "${CC_APP_DIR:-}" ]]; then
  _cc_remote="$(git -C "$APP_DIR" remote get-url origin 2>/dev/null || echo "")"
  _cc_valid=0
  if [[ -d "$APP_DIR/.git" ]] \
     && [[ -f "$APP_DIR/package.json" ]] \
     && [[ -f "$APP_DIR/ecosystem.config.cjs" ]] \
     && printf '%s' "$_cc_remote" | grep -q 'blackceo-command-center'; then
    _cc_valid=1
  fi
  if [[ "$_cc_valid" -ne 1 ]]; then
    _err "PORT-FIX-2: flag-less invocation refused — $APP_DIR is not a validated blackceo-command-center checkout."
    _err "Pass --app-dir <path> (or export CC_APP_DIR) pointing at the real CC checkout."
    _err "Refusing to deploy onto a non-canonical/foreign directory (would restart a stale app or spawn a second CC)."
    exit 2
  fi
fi

DISK_CHECK_PATH="${DISK_PATH_OVERRIDE:-$APP_DIR}"

_banner "B.2 Atomic Deploy — ${APP_DIR}"
_log "pm2 app: ${PM2_APP_NAME}  port: ${PORT}  disk-min: ${DISK_MIN_GB}GB"

###############################################################################
# ─── PHASE 1: PRE-FLIGHT ────────────────────────────────────────────────────
###############################################################################
_banner "Phase 1 — Pre-flight"

# ── 1a. Disk gate: check free space; run cleanup first, then re-check ────────
_log "[1a] Disk gate (threshold: ${DISK_MIN_GB} GB)"
FREE_GB_BEFORE=$(_free_gb "$DISK_CHECK_PATH")
_log "  Free disk before cleanup: ${FREE_GB_BEFORE} GB on ${DISK_CHECK_PATH}"

if (( FREE_GB_BEFORE < DISK_MIN_GB )); then
  _warn "  Disk below ${DISK_MIN_GB} GB — running cleanup first ..."
  _disk_cleanup "$APP_DIR"
  FREE_GB_AFTER=$(_free_gb "$DISK_CHECK_PATH")
  _log "  Free disk after cleanup : ${FREE_GB_AFTER} GB"
  if (( FREE_GB_AFTER < DISK_MIN_GB )); then
    _preflight_abort_receipt "Insufficient disk space: ${FREE_GB_AFTER} GB free on ${DISK_CHECK_PATH} (need ${DISK_MIN_GB} GB). Cleanup could not reclaim enough space. Operator action required."
    exit 2
  fi
  _ok "  Disk gate passed after cleanup: ${FREE_GB_AFTER} GB free"
else
  _ok "  Disk gate passed: ${FREE_GB_BEFORE} GB free"
fi

# ── 1b. DB backup ─────────────────────────────────────────────────────────────
_log "[1b] Database backup"
DB_FILE=""
if [[ -n "$DB_PATH_OVERRIDE" ]]; then
  DB_FILE="$DB_PATH_OVERRIDE"
else
  # FIX 34 (presentation rev2): the old candidate order resolved "${APP_DIR}/mission-control.db"
  # FIRST. On the operator box that repo-root file is a 0-byte decoy, so every
  # autodeploy backup was a 0-byte rollback source (see spec FIX 34). Now:
  #   1. LIVEDB (the real ~135MB WAL-mode DB) is tried first;
  #   2. every candidate additionally requires a NON-ZERO size (-s), so a
  #      decoy can never satisfy the match even if it wins the ordering.
  for _candidate in \
    "${HOME}/command-center/data/mission-control.db" \
    "/data/mission-control/mission-control.db" \
    "/data/projects/command-center/mission-control.db" \
    "${APP_DIR}/mission-control.db"; do
    if [[ -f "$_candidate" && -s "$_candidate" ]]; then
      DB_FILE="$_candidate"
      break
    fi
  done
fi

if [[ -z "$DB_FILE" || ! -f "$DB_FILE" ]]; then
  _warn "  DB not found (no non-empty candidate among LIVEDB/APP_DIR/heuristic paths). Skipping DB backup."
  _warn "  Supply --db-path if the DB is at a non-standard location."
  DB_BACKUP=""
else
  # BUG-2 FIX: the ".autodeploy." infix is the marker that scopes retention
  # pruning (below, and in _disk_cleanup above) to backups THIS SCRIPT created.
  # Never drop this marker -- see the prune call below for why.
  DB_BACKUP="${DB_FILE}.backup.autodeploy.$(date +%Y%m%d-%H%M%S)"
  # Best-effort pre-backup WAL flush. The Linux/VPS container ships python3 but
  # NOT the sqlite3 CLI, so use the stdlib sqlite3 module (behaviour-equivalent
  # to `sqlite3 <db> '.timeout 5000' 'PRAGMA wal_checkpoint(TRUNCATE);'`).
  # better-sqlite3 is deliberately NOT used here: this runs BEFORE `npm run
  # build`, so its native binding may be unbuilt/ABI-mismatched at this point.
  # The connection is always closed in a finally and the whole thing is fenced
  # so a checkpoint failure can never fail the deploy — the cp below still runs.
  python3 - "$DB_FILE" <<'PYWAL' 2>/dev/null || true
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1], timeout=5)
try:
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
finally:
    conn.close()
PYWAL
  # Pre-check disk BEFORE the copy. The phase-1a gate above checks the deploy
  # as a whole; this checks that THIS copy specifically fits, so a truncated
  # .backup file can never be produced and then trusted as a rollback source.
  if ! oc_backup_precheck_disk "$DB_BACKUP" "$(oc_backup_size_kb "$DB_FILE")" "DB backup of ${DB_FILE}"; then
    _preflight_abort_receipt "Cannot back up the database at ${DB_FILE} — insufficient free disk (details above). Old build untouched."
    exit 2
  fi
  cp "$DB_FILE" "$DB_BACKUP"
  # FIX 34 (presentation rev2): a 0-byte/truncated backup is not a backup.
  # Fail the deploy before the build replaces the old .next — the pre-backup
  # .next snapshot (1c) has not run yet, so exiting here leaves everything
  # exactly as it was.
  if [[ ! -s "$DB_BACKUP" ]]; then
    _preflight_abort_receipt "DB backup at ${DB_BACKUP} is 0 bytes — refusing to continue (decoy/truncated source would poison the rollback chain). Old build untouched."
    rm -f "$DB_BACKUP"
    exit 2
  fi
  _ok "  DB backed up: ${DB_BACKUP} ($(oc_backup_size_kb "$DB_BACKUP") KB)"
  # FIX 34b (presentation rev3, spec REV 3): a backup that cannot be READ BACK
  # is not a backup — spec PROOF: "next backup is ~135MB and restores to a
  # working DB". The verifier opens THE BACKUP FILE ITSELF (the artifact a
  # rollback would restore) and reads its pages back via PRAGMA
  # integrity_check; a file whose pages are corrupt raises sqlite3.DatabaseError
  # (or reports a non-ok integrity result) and the deploy aborts (exit 2)
  # BEFORE the build replaces the old .next, so a poison backup never survives
  # into the rollback chain. A 0-byte / header-less file is refused on the
  # magic-header check before any integrity verdict. A bare `cp` of a live
  # WAL-mode DB can lag the -wal file; the checkpoint above shrinks that
  # window and integrity_check still proves the restored-from file parses end
  # to end. FAIL-CLOSED, unlike the checkpoint above: a non-zero verifier exit
  # aborts the deploy (exit 2) — a poison backup in the rollback chain is worse
  # than a delayed deploy; the backup itself is kept on disk for forensics.
  DB_BACKUP_VERIFY_RC=0
  python3 - "$DB_BACKUP" <<'PYRESTORE' 2>/dev/null || DB_BACKUP_VERIFY_RC=$?
import sqlite3, os, sys
ok = False
try:
    # A 0-byte / header-less file is not a DB: require the SQLite magic header
    # before trusting any integrity verdict from it.
    with open(sys.argv[1], "rb") as fh:
        ok = fh.read(16) == b"SQLite format 3\x00"
    if ok:
        chk = sqlite3.connect(sys.argv[1], timeout=5)
        try:
            row = chk.execute("PRAGMA integrity_check").fetchone()
            ok = bool(row) and str(row[0]).lower() == "ok"
        finally:
            chk.close()
except (sqlite3.DatabaseError, OSError):
    ok = False  # unreadable/malformed image is a failed verification
if not ok:
    sys.exit(9)
PYRESTORE
  if [[ "$DB_BACKUP_VERIFY_RC" -ne 0 ]]; then
    _preflight_abort_receipt "FIX 34b: DB backup at ${DB_BACKUP} FAILED restore-verification (integrity_check != ok) — refusing to continue; the backup is kept on disk for forensics. Old build untouched."
    exit 2
  fi
  # RETENTION: only now that this deploy's backup exists. Never prunes the
  # backup this run just wrote. Prefix scoped to the ".autodeploy." marker
  # (BUG-2 FIX) so this can NEVER match a human/operator-made backup file —
  # only ones this script's own Phase 1b code path created.
  oc_backup_prune "$(dirname "$DB_BACKUP")" "$(basename "$DB_FILE").backup.autodeploy." "$DB_BACKUP"
fi

# ── 1c. Snapshot current .next as rollback artifact ───────────────────────────
# ROLLBACK-CORRUPTION GUARD: only snapshot NEXT_DIR over the existing rollback
# when NEXT_DIR is itself a validated build (has a BUILD_ID). Without this
# check, running the script against an ALREADY-BROKEN live .next (corrupted by
# any prior failure — this script, a crash, a manual edit, disk issue) would
# blindly `rm -rf` the last known-good rollback and replace it with the broken
# build, destroying the only escape hatch before Phase 2 has even attempted a
# new build. If a good rollback from a previous run already exists, it is kept
# untouched instead. Only when there is neither a validated live build nor a
# pre-existing rollback do we correctly have nothing to fall back to.
_log "[1c] Snapshotting .next as rollback artifact"
NEXT_DIR="${APP_DIR}/.next"
ROLLBACK_DIR="${APP_DIR}/.next.rollback"

if [[ -d "$NEXT_DIR" && -f "$NEXT_DIR/BUILD_ID" ]]; then
  rm -rf "$ROLLBACK_DIR"
  cp -r "$NEXT_DIR" "$ROLLBACK_DIR"
  _ok "  Rollback artifact created: ${ROLLBACK_DIR}"
  ROLLBACK_EXISTS=1
elif [[ -d "$ROLLBACK_DIR" && -f "$ROLLBACK_DIR/BUILD_ID" ]]; then
  _warn "  Live .next has no BUILD_ID (looks broken/partial) — refusing to overwrite the existing rollback with it."
  _warn "  Keeping the rollback artifact already on disk: ${ROLLBACK_DIR}"
  ROLLBACK_EXISTS=1
elif [[ -d "$NEXT_DIR" ]]; then
  _warn "  Live .next exists but has no BUILD_ID (looks broken/partial), and no prior rollback artifact exists."
  _warn "  On build failure, there is nothing safe to roll back to."
  ROLLBACK_EXISTS=0
else
  _warn "  No existing .next directory found — rollback artifact not created."
  _warn "  On build failure, there is nothing to roll back to."
  ROLLBACK_EXISTS=0
fi

# ── 1d. Kill non-canonical pm2 apps fighting for the canonical port ──────────
_log "[1d] Killing non-canonical pm2 apps fighting for port ${PORT}"
# PORT-AWARE selection (scripts/lib/pm2-port-zombies.py). The old logic here
# matched NAME KEYWORDS only ('mission-control'/'command-center'/'blackceo')
# and was port-blind. That had two production-breaking failure modes, both
# reachable on a live box running cc-prod (:4000) + blackceo-cc-demo-interview
# (:4600) + blackceo-cc-demo-dashboard (:4601):
#   1. It DELETED both RUNNING demo apps — keyword hit, ports unrelated.
#   2. It left the actual :4000 holder alive when that app's name carried no
#      keyword (cc-prod), so Phase 4 started a duplicate that fought it for
#      the port.
# An app is now selected ONLY if its name differs from the canonical AND it
# is bound to (lsof listener PID or a pm2 descendant of one) or declared on
# (pm2 args/env, args win) the canonical port. An app serving any other port
# can NEVER be selected. Fail-safe: a missing selector or unparseable jlist
# selects NOTHING — nothing is ever killed blind.
ZOMBIE_SELECTOR="${SCRIPT_DIR}/lib/pm2-port-zombies.py"
LISTENER_PIDS=""
if command -v lsof >/dev/null 2>&1; then
  # PIDs currently LISTENing on the canonical port. lsof is optional (absent
  # on some VPS containers); declared-port matching works without it.
  LISTENER_PIDS=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ' || true)
fi
NON_CANONICAL=""
if [[ -f "$ZOMBIE_SELECTOR" ]]; then
  # LISTENER_PIDS is intentionally unquoted: one argv entry per PID.
  NON_CANONICAL=$(pm2 jlist 2>/dev/null \
    | python3 -s "$ZOMBIE_SELECTOR" "$PM2_APP_NAME" "$PORT" $LISTENER_PIDS 2>/dev/null || true)
else
  _warn "  Selector not found at ${ZOMBIE_SELECTOR} — skipping pm2 dedup (nothing is killed blind)."
fi

if [[ -n "$NON_CANONICAL" ]]; then
  while IFS= read -r zombie_name; do
    [[ -z "$zombie_name" ]] && continue
    _warn "  Killing non-canonical pm2 app fighting for port ${PORT}: '${zombie_name}'"
    pm2 delete "$zombie_name" 2>/dev/null || pm2 stop "$zombie_name" 2>/dev/null || true
  done <<< "$NON_CANONICAL"
  _ok "  Non-canonical port-fighters removed."
else
  _ok "  No non-canonical pm2 app is bound to or declared on port ${PORT}."
fi

# NATIVE-MODULE GATE: the running server must be able to LOAD and USE every
# native module it requires (better-sqlite3 class) BEFORE the build starts.
# npm ci can silently drop a platform binary; discovering that after the
# health check already failed wastes the whole deploy and forces manual
# recovery. The gate resolves the package from the app's own node_modules,
# then opens an in-memory SQLite database and executes a query, so a binary
# that merely exists but cannot load or execute is still rejected.
NATIVE_MODULE_GATES=( "better-sqlite3" )

_ccbi_native_gate() {
  # Usage: _ccbi_native_gate <directory-containing-node_modules>
  local _gate_dir="$1"
  local _gate_node="${CCBI_NODE_BIN:-$(command -v node)}"
  local _gate_mod
  if [[ -z "${_gate_node}" || ! -x "${_gate_node}" ]]; then
    _err "Native-module gate: Node executable not found or not executable (CCBI_NODE_BIN=${CCBI_NODE_BIN:-unset})."
    return 2
  fi
  for _gate_mod in "${NATIVE_MODULE_GATES[@]}"; do
    if ! (cd "$_gate_dir" && "$_gate_node" -e '
      const { createRequire } = require("module");
      const req = createRequire(process.argv[1] + "/node_modules/");
      let NativeModule = req(process.argv[2]);
      if (NativeModule && typeof NativeModule !== "function") NativeModule = NativeModule.default || NativeModule.NativeModule;
      if (typeof NativeModule !== "function") process.exit(4);
      const db = new NativeModule(":memory:");
      try {
        const row = db.prepare("SELECT 42 AS answer").get();
        if (!row || row.answer !== 42) process.exit(3);
      } finally {
        db.close();
      }
    ' "$_gate_dir" "$_gate_mod" >/dev/null 2>&1); then
      _err "Native-module gate failed for ${_gate_mod} in ${_gate_dir} (with ${_gate_node})."
      _err "Run 'cd ${_gate_dir} && npm rebuild ${_gate_mod}' and re-run the updater. Old build untouched."
      return 1
    fi
    _ok "  Native module ${_gate_mod} loads and opens SQLite."
  done
  return 0
}

# ISSUE-09 follow-up: prove a rebuild actually produced a loadable binary.
# `npm rebuild <mod>` REPORTS SUCCESS WITHOUT PRODUCING A BINARY. Measured on
# the operator Mac: `npm rebuild better-sqlite3` printed "rebuilt dependencies
# successfully" and exited 0 while node_modules/better-sqlite3 held no .node
# file at all, so every subsequent `new Database()` threw "Could not locate the
# bindings file". A step that claims to have done something it did not is the
# same defect class as the ABI drift this unit exists to close, so assert the
# ARTIFACT, never the exit code.
_ccbi_assert_rebuild_produced_binary() {  # <app_dir> <module>
  local _dir="$1" _mod="$2"
  # The package resolver is authoritative. Native package names and binding
  # filenames do not have a stable 1:1 mapping (better-sqlite3 builds
  # better_sqlite3.node), so guessing a file name can reject a successful
  # rebuild before its functional probe runs. Resolving the package and
  # opening SQLite through it proves the real binding loads and executes.
  if ! _ccbi_native_gate "$_dir"; then
    _preflight_abort_receipt "npm rebuild ${_mod} reported success, but the resolved package does not load and execute SQLite under ${CC_NODE_BIN}. Old build untouched."
  fi
  _ok "  Rebuild of ${_mod} verified: the resolved package loads and executes SQLite under ${CC_NODE_BIN}."
}

# ISSUE-09: a failing PRE-FLIGHT gate is repaired ONCE before aborting. The
# usual cause is an ABI mismatch between the live node_modules and the resolved
# runtime, which is exactly what `npm rebuild` fixes, and aborting handed the
# operator a manual command for a repair this script can perform itself. One
# attempt, then re-gate; a second failure still aborts, so a genuinely broken
# toolchain is never papered over. Deliberately NOT applied to the staged-deps
# or post-build gates: those trees were just installed by this run, and a
# failure there is a real defect in the candidate, not drift to be repaired.
if ! _ccbi_native_gate "$APP_DIR"; then
  _warn "  Pre-flight native gate failed; attempting ONE rebuild against ${CC_NODE_BIN} (module ABI $("$CC_NODE_BIN" -p process.versions.modules 2>/dev/null || echo unknown)) ..."
  for _nat_mod in "${NATIVE_MODULE_GATES[@]}"; do
    ( cd "${APP_DIR}" && npm rebuild "${_nat_mod}" ) >/dev/null 2>&1 || true
    _ccbi_assert_rebuild_produced_binary "${APP_DIR}" "${_nat_mod}"
  done
  _ok "  Pre-flight native gate repaired by one verified rebuild."
fi
_ok "Phase 1 pre-flight passed (including native-module gates)."

# ── 1e. Stage a complete candidate release ──────────────────────────────────
# Candidate preparation must never mutate the live release. The candidate gets
# its own source copy, lockfile-pinned dependencies, generated files and build
# artifact. Nothing in APP_DIR is swapped until the candidate has built and
# passed its runtime gates.
TRANSACTION_PHASE="PREPARING"
RELEASE_DIR=""
LIVE_NODE_MODULES_BACKUP=""
PREVIOUS_DEPS_BACKUP=""
OLD_NEXT_PARK=""
CANDIDATE_NEXT_PARK=""
CANDIDATE_DEPS_PARK=""

_ccbi_discard_candidate_release() {
  [[ -n "${RELEASE_DIR:-}" && -d "$RELEASE_DIR" ]] || return 0
  rm -rf "$RELEASE_DIR" 2>/dev/null || {
    _warn "Could not remove candidate release directory: ${RELEASE_DIR}"
    return 1
  }
  return 0
}

_ccbi_restore_previous_dependencies() {
  # Usage: _ccbi_restore_previous_dependencies [keep-candidate-park]
  # keep-candidate-park is used by explicit rollback so an interruption can
  # recover the complete candidate until the rollback has fully succeeded.
  local _keep_candidate="${1:-}"
  [[ -n "${LIVE_NODE_MODULES_BACKUP:-}" && -d "$LIVE_NODE_MODULES_BACKUP" ]] || return 0
  CANDIDATE_DEPS_PARK="${APP_DIR}/.node_modules.candidate.$$"
  local _moved_current=0
  if [[ -d "${APP_DIR}/node_modules" ]]; then
    rm -rf "$CANDIDATE_DEPS_PARK" 2>/dev/null || true
    if mv "${APP_DIR}/node_modules" "$CANDIDATE_DEPS_PARK" 2>/dev/null; then
      _moved_current=1
    else
      rm -rf "${APP_DIR}/node_modules" 2>/dev/null || true
    fi
  fi
  if mv "$LIVE_NODE_MODULES_BACKUP" "${APP_DIR}/node_modules" 2>/dev/null; then
    _ok "  Previous dependency tree restored: ${APP_DIR}/node_modules"
    if [[ "$_keep_candidate" != "keep-candidate-park" ]]; then
      rm -rf "$CANDIDATE_DEPS_PARK" 2>/dev/null || true
      CANDIDATE_DEPS_PARK=""
      PREVIOUS_DEPS_BACKUP=""
    fi
    LIVE_NODE_MODULES_BACKUP=""
    return 0
  fi

  _err "CRITICAL: failed to restore previous dependency tree from ${LIVE_NODE_MODULES_BACKUP}."
  if [[ "$_moved_current" -eq 1 && -d "$CANDIDATE_DEPS_PARK" ]]; then
    mv "$CANDIDATE_DEPS_PARK" "${APP_DIR}/node_modules" 2>/dev/null \
      || _err "CRITICAL: could not recover the displaced dependency tree from ${CANDIDATE_DEPS_PARK}."
  fi
  CANDIDATE_DEPS_PARK=""
  return 1
}

_ccbi_restore_previous_release() {
  if [[ -n "${OLD_NEXT_PARK:-}" && -d "$OLD_NEXT_PARK" ]]; then
    local _discarded="${APP_DIR}/.next.discarded.$$"
    local _moved_current=0
    if [[ -d "${APP_DIR}/.next" ]]; then
      rm -rf "$_discarded" 2>/dev/null || true
      if mv "${APP_DIR}/.next" "$_discarded" 2>/dev/null; then
        _moved_current=1
      else
        rm -rf "${APP_DIR}/.next" 2>/dev/null || true
      fi
    fi
    if mv "$OLD_NEXT_PARK" "${APP_DIR}/.next" 2>/dev/null; then
      _ok "  Previous build artifact restored: ${APP_DIR}/.next"
      rm -rf "$_discarded" 2>/dev/null || true
    else
      _err "CRITICAL: failed to restore previous build artifact from ${OLD_NEXT_PARK}."
      if [[ "$_moved_current" -eq 1 && -d "$_discarded" ]]; then
        mv "$_discarded" "${APP_DIR}/.next" 2>/dev/null \
          || _err "CRITICAL: could not recover the displaced artifact from ${_discarded}."
      fi
    fi
    OLD_NEXT_PARK=""
  fi
  _ccbi_restore_previous_dependencies
  TRANSACTION_PHASE="PREVIOUS_LIVE"
}

_ccbi_recover_interrupted_rollback() {
  local _recovered=0
  if [[ -n "${CANDIDATE_NEXT_PARK:-}" && -d "$CANDIDATE_NEXT_PARK" ]]; then
    if [[ -d "${APP_DIR}/.next" ]]; then
      rm -rf "${APP_DIR}/.next.interrupted.$$" 2>/dev/null || true
      mv "${APP_DIR}/.next" "${APP_DIR}/.next.interrupted.$$" 2>/dev/null || true
    fi
    if mv "$CANDIDATE_NEXT_PARK" "${APP_DIR}/.next" 2>/dev/null; then
      _ok "  Interrupted rollback recovered the candidate artifact."
      _recovered=1
    else
      _err "CRITICAL: could not recover the candidate artifact from ${CANDIDATE_NEXT_PARK}."
    fi
    CANDIDATE_NEXT_PARK=""
  fi
  if [[ -n "${CANDIDATE_DEPS_PARK:-}" && -d "$CANDIDATE_DEPS_PARK" ]]; then
    if [[ -d "${APP_DIR}/node_modules" ]]; then
      if [[ -n "${PREVIOUS_DEPS_BACKUP:-}" ]]; then
        mv "${APP_DIR}/node_modules" "$PREVIOUS_DEPS_BACKUP" 2>/dev/null || true
      else
        rm -rf "${APP_DIR}/node_modules" 2>/dev/null || true
      fi
    fi
    if mv "$CANDIDATE_DEPS_PARK" "${APP_DIR}/node_modules" 2>/dev/null; then
      _ok "  Interrupted rollback recovered the candidate dependencies."
      _recovered=1
    else
      _err "CRITICAL: could not recover the candidate dependencies from ${CANDIDATE_DEPS_PARK}."
    fi
    CANDIDATE_DEPS_PARK=""
    if [[ -n "${PREVIOUS_DEPS_BACKUP:-}" && -d "$PREVIOUS_DEPS_BACKUP" ]]; then
      LIVE_NODE_MODULES_BACKUP="$PREVIOUS_DEPS_BACKUP"
    fi
  fi
  if [[ "$_recovered" -eq 1 ]]; then
    TRANSACTION_PHASE="CANDIDATE_LIVE"
    _warn "  Explicit rollback was interrupted; the complete candidate release was restored."
  else
    TRANSACTION_PHASE="CANDIDATE_LIVE"
  fi
}

# Explicit transaction phases make EXIT cleanup safe:
# PREPARING/BUILDING discards only the private candidate; PROMOTING restores the
# complete previous release; a live candidate is never partially rolled back.
# Invoked by the EXIT trap below.
# shellcheck disable=SC2329
_ccbi_on_exit_cleanup() {
  case "${TRANSACTION_PHASE:-PREPARING}" in
    PREPARING|BUILDING)
      _ccbi_discard_candidate_release
      ;;
    PROMOTING)
      _ccbi_restore_previous_release
      _ccbi_discard_candidate_release
      ;;
    ROLLING_BACK)
      _ccbi_recover_interrupted_rollback
      ;;
    *)
      # CANDIDATE_LIVE, UNKNOWN, GREEN and ROLLED_BACK remain complete states.
      ;;
  esac
}
trap _ccbi_on_exit_cleanup EXIT

# Invoked by the signal traps below.
# shellcheck disable=SC2329
_ccbi_on_signal_cleanup() {
  _ccbi_on_exit_cleanup
  exit 130
}
trap _ccbi_on_signal_cleanup INT TERM HUP

_log "[1e] Staging complete candidate release"
if [[ ! -f "${APP_DIR}/package-lock.json" ]]; then
  _preflight_abort_receipt "package-lock.json missing in ${APP_DIR} — refusing to stage dependencies. Old build untouched."
  exit 2
fi
BUILD_INVENTORY_LIB="${SCRIPT_DIR}/lib/build-inventory.sh"
if [[ ! -f "$BUILD_INVENTORY_LIB" ]]; then
  _err "scripts/lib/build-inventory.sh not found beside atomic-deploy.sh — content inventory unavailable."
  _err "Refusing to build an unverifiable artifact (PRES-046)."
  exit 2
fi
# shellcheck source=lib/build-inventory.sh
source "$BUILD_INVENTORY_LIB"

# Capture the live source identity BEFORE copying anything. The candidate copy
# must match this digest, and the live tree must still match it after the build.
PRE_BUILD_INVENTORY="$(_ccbi_inventory_digest "$APP_DIR")" || {
  _err "Failed to compute pre-build content inventory for ${APP_DIR}."
  exit 2
}
_log "  Pre-build live content inventory: ${PRE_BUILD_INVENTORY}"

RELEASE_DIR="${APP_DIR}/.release-candidate.$$"
rm -rf "$RELEASE_DIR" 2>/dev/null || true
mkdir -p "$RELEASE_DIR" || { _err "Failed to create candidate release directory."; exit 2; }

# Copy canonical compile inputs, build launcher support, and the env files Next
# would read from the project root. Runtime data stays in APP_DIR.
for _release_input in $_CCBI_TOPLEVEL_INPUTS scripts next-env.d.ts; do
  if [[ -e "${APP_DIR}/${_release_input}" ]]; then
    cp -R "${APP_DIR}/${_release_input}" "${RELEASE_DIR}/" || {
      _err "Failed to copy candidate input: ${_release_input}"
      exit 2
    }
  fi
done
for _release_env in .env .env.production .env.production.local .env.local; do
  if [[ -f "${APP_DIR}/${_release_env}" ]]; then
    cp -p "${APP_DIR}/${_release_env}" "${RELEASE_DIR}/${_release_env}" || {
      _err "Failed to copy candidate environment file: ${_release_env}"
      exit 2
    }
  fi
done

CANDIDATE_SOURCE_INVENTORY="$(_ccbi_inventory_digest "$RELEASE_DIR")" || {
  _err "Failed to compute the candidate source inventory after copying."
  exit 2
}
if [[ "$CANDIDATE_SOURCE_INVENTORY" != "$PRE_BUILD_INVENTORY" ]]; then
  _err "  Candidate source inventory does not match the live source captured before copying."
  _err "  Live inventory:       ${PRE_BUILD_INVENTORY}"
  _err "  Candidate inventory: ${CANDIDATE_SOURCE_INVENTORY}"
  _preflight_abort_receipt "Candidate source copy failed the frozen-source identity check. Live release untouched."
  exit 2
fi

if ! (cd "$RELEASE_DIR" && npm ci --no-audit --no-fund --prefer-offline --ignore-scripts=false 2>&1 | tee "$RELEASE_DIR/npm-ci.log"); then
  _preflight_abort_receipt "Dependency staging failed (npm ci). Live source, dependencies and artifact untouched."
  exit 2
fi
CANDIDATE_SOURCE_INVENTORY="$(_ccbi_inventory_digest "$RELEASE_DIR")" || {
  _err "Failed to re-check the candidate source inventory after npm ci."
  exit 2
}
if [[ "$CANDIDATE_SOURCE_INVENTORY" != "$PRE_BUILD_INVENTORY" ]]; then
  _preflight_abort_receipt "npm ci changed a compile-affecting candidate input. Live release untouched."
  exit 2
fi
if ! _ccbi_native_gate "$RELEASE_DIR"; then
  _preflight_abort_receipt "Native-module gate failed on staged dependencies. Live source, dependencies and artifact untouched."
  exit 2
fi
_ok "  Candidate source, dependencies and environment staged in ${RELEASE_DIR}."

###############################################################################
# ─── PHASE 2: BUILD IN THE CANDIDATE RELEASE ────────────────────────────────
###############################################################################
_banner "Phase 2 — Build (candidate release)"

TRANSACTION_PHASE="BUILDING"
BUILD_TMP_NAME=".next.tmp.$(date +%Y%m%d-%H%M%S)-$$"
BUILD_TMP="${RELEASE_DIR}/${BUILD_TMP_NAME}"
_log "Building into candidate artifact directory: ${BUILD_TMP}"
BUILD_START_TS=$(date +%s 2>/dev/null || echo 0)

# The live source tree captured above is the freshness oracle. The build runs
# in the private candidate copy, so APP_DIR remains untouched while still
# being attested after the build.
cd "$RELEASE_DIR" || exit 2
CCBI_TSCONFIG_SNAPSHOT=""
if [[ -f "$RELEASE_DIR/tsconfig.json" ]]; then
  CCBI_TSCONFIG_SNAPSHOT="$(mktemp "${TMPDIR:-/tmp}/ccbi-candidate-tsconfig-XXXXXX")" || {
    _err "Failed to snapshot the candidate tsconfig.json before build."
    exit 2
  }
  cp -p "$RELEASE_DIR/tsconfig.json" "$CCBI_TSCONFIG_SNAPSHOT" || {
    _err "Failed to copy the candidate tsconfig.json snapshot."
    exit 2
  }
fi

BUILD_EXIT_FILE=$(mktemp "${TMPDIR:-/tmp}/atomic-build-exit-XXXXXX")
echo "2" > "$BUILD_EXIT_FILE"
export BUILD_EXIT_FILE

_log "Running: npm run build  (output: ${BUILD_TMP}, node: ${CC_NODE_BIN})"
(
  NEXT_DIST_DIR="$BUILD_TMP_NAME" npm run build 2>&1
  echo $? > "$BUILD_EXIT_FILE"
) | while IFS= read -r line; do
  printf '%s[build] %s%s\n' "${CYAN}" "${RESET}" "$line" >&2
done
BUILD_EXIT=$(cat "$BUILD_EXIT_FILE" 2>/dev/null || echo 2)
rm -f "$BUILD_EXIT_FILE"
_log "  npm run build exited: ${BUILD_EXIT}"

BUILD_ID_FILE="${BUILD_TMP}/BUILD_ID"
# The fallback for Next versions that ignore NEXT_DIST_DIR is also private to the
# candidate release and cannot touch the live artifact.
if [[ ! -f "$BUILD_ID_FILE" && -f "${RELEASE_DIR}/.next/BUILD_ID" ]]; then
  _warn "  NEXT_DIST_DIR not respected by this Next.js version — build went to the candidate .next directory."
  NEXT_BUILD_ID_MTIME=$(stat -c%Y "${RELEASE_DIR}/.next/BUILD_ID" 2>/dev/null \
    || stat -f%m "${RELEASE_DIR}/.next/BUILD_ID" 2>/dev/null \
    || echo 0)
  if (( NEXT_BUILD_ID_MTIME < BUILD_START_TS )); then
    _preflight_abort_receipt "Build failed: candidate BUILD_ID is stale. Live source, dependencies and artifact untouched."
    exit 2
  fi
  mv "${RELEASE_DIR}/.next" "$BUILD_TMP" 2>/dev/null || {
    _preflight_abort_receipt "Failed to move candidate .next output to the build artifact directory. Live release untouched."
    exit 2
  }
  BUILD_ID_FILE="${BUILD_TMP}/BUILD_ID"
fi

if [[ ! -f "$BUILD_ID_FILE" ]]; then
  _err "Build FAILED — BUILD_ID not present in candidate output (${BUILD_TMP})."
  _preflight_abort_receipt "Build exited ${BUILD_EXIT} or BUILD_ID absent. Live source, dependencies and artifact untouched."
  exit 2
fi
BUILD_ID_MTIME=$(stat -c%Y "$BUILD_ID_FILE" 2>/dev/null \
  || stat -f%m "$BUILD_ID_FILE" 2>/dev/null \
  || echo 0)
if (( BUILD_ID_MTIME < BUILD_START_TS )); then
  _err "  BUILD_ID mtime (${BUILD_ID_MTIME}) predates build start (${BUILD_START_TS})."
  _preflight_abort_receipt "Build failed: candidate BUILD_ID is stale. Live source, dependencies and artifact untouched."
  exit 2
fi
if [[ "$BUILD_EXIT" -ne 0 ]]; then
  _err "Build FAILED — npm run build exited ${BUILD_EXIT}."
  _preflight_abort_receipt "npm run build exited ${BUILD_EXIT}. Live source, dependencies and artifact untouched."
  exit 2
fi
BUILD_ID=$(cat "$BUILD_ID_FILE" 2>/dev/null || echo "unknown")
_ok "Build succeeded. BUILD_ID: ${BUILD_ID}"

# Undo Next's legitimate build-generated tsconfig edit in the private candidate,
# then prove that every compile-affecting candidate input still matches the live
# source captured before copying. A build stub that mutates candidate source is
# rejected even when APP_DIR itself remained unchanged.
if [[ -n "${CCBI_TSCONFIG_SNAPSHOT:-}" && -f "$CCBI_TSCONFIG_SNAPSHOT" ]]; then
  cp -p "$CCBI_TSCONFIG_SNAPSHOT" "$RELEASE_DIR/tsconfig.json" 2>/dev/null || true
  rm -f "$CCBI_TSCONFIG_SNAPSHOT" 2>/dev/null || true
  CCBI_TSCONFIG_SNAPSHOT=""
fi
CANDIDATE_SOURCE_INVENTORY="$(_ccbi_inventory_digest "$RELEASE_DIR")" || {
  _err "Failed to re-check the candidate source inventory after the build."
  _preflight_abort_receipt "Post-build candidate content inventory computation failed. Candidate discarded; live release untouched."
  exit 2
}
if [[ "$CANDIDATE_SOURCE_INVENTORY" != "$PRE_BUILD_INVENTORY" ]]; then
  _err "  FROZEN-SOURCE VIOLATION: candidate compile inputs changed during the build."
  _err "  Live inventory:       ${PRE_BUILD_INVENTORY}"
  _err "  Candidate inventory: ${CANDIDATE_SOURCE_INVENTORY}"
  _preflight_abort_receipt "FROZEN-SOURCE VIOLATION (PRES-046): candidate compile-affecting inputs changed during compilation. Candidate discarded; live release untouched."
  exit 2
fi

if ! _ccbi_native_gate "$RELEASE_DIR"; then
  _err "Post-build: candidate dependencies cannot load or use the native modules."
  _preflight_abort_receipt "Post-build native-module gate failed — candidate discarded; live release untouched."
  exit 2
fi

POST_BUILD_INVENTORY="$(_ccbi_inventory_digest "$APP_DIR")" || {
  _err "Failed to compute post-build content inventory for ${APP_DIR}."
  _preflight_abort_receipt "Post-build content inventory computation failed. Candidate discarded; live release untouched."
  exit 2
}
if [[ "$POST_BUILD_INVENTORY" != "$PRE_BUILD_INVENTORY" ]]; then
  _err "  FROZEN-SOURCE VIOLATION: live compile inputs changed during the candidate build."
  _err "  Pre-build  inventory: ${PRE_BUILD_INVENTORY}"
  _err "  Post-build inventory: ${POST_BUILD_INVENTORY}"
  _preflight_abort_receipt "FROZEN-SOURCE VIOLATION (PRES-046): compile-affecting inputs changed during compilation. Candidate discarded; live release untouched."
  exit 2
fi
_ok "  Frozen-source proof passed — live content inventory unchanged during build (${POST_BUILD_INVENTORY})."

if ! _ccbi_write_manifest "$APP_DIR" "$BUILD_TMP" "$BUILD_ID" "$BUILD_START_TS"; then
  _err "Failed to write build-inventory.json into ${BUILD_TMP}."
  _preflight_abort_receipt "Build manifest write failed. Candidate discarded; live release untouched."
  exit 2
fi
_ok "  Immutable manifest written into candidate build output (inventory ${POST_BUILD_INVENTORY})"

###############################################################################
# ─── PHASE 3: CONTROLLED PROMOTION ───────────────────────────────────────────
###############################################################################
_banner "Phase 3 — Controlled promotion"

_log "Promoting complete candidate release (artifact + dependencies)"
TRANSACTION_PHASE="PROMOTING"
LIVE_NODE_MODULES_BACKUP="${APP_DIR}/.node_modules.rollback.$$"
PREVIOUS_DEPS_BACKUP="$LIVE_NODE_MODULES_BACKUP"

if [[ ! -d "${APP_DIR}/node_modules" ]]; then
  _err "Live node_modules is missing; refusing an unverifiable promotion."
  _preflight_abort_receipt "Cannot promote a candidate without a live dependency tree to preserve."
  exit 2
fi
mv "${APP_DIR}/node_modules" "$LIVE_NODE_MODULES_BACKUP" || {
  _err "Failed to park live node_modules for promotion."
  _preflight_abort_receipt "Could not preserve the live dependency tree; promotion refused."
  exit 2
}
if ! mv "${RELEASE_DIR}/node_modules" "${APP_DIR}/node_modules"; then
  _err "Failed to promote candidate dependencies; restoring previous dependencies."
  _ccbi_restore_previous_dependencies
  _preflight_abort_receipt "Candidate dependency promotion failed; previous release restored."
  exit 2
fi

OLD_NEXT_PARK="${APP_DIR}/.next.old.$$"
if [[ -d "${APP_DIR}/.next" ]]; then
  mv "${APP_DIR}/.next" "$OLD_NEXT_PARK" || {
    _err "Failed to park live .next for promotion; restoring previous dependencies."
    _ccbi_restore_previous_dependencies
    _preflight_abort_receipt "Could not preserve the live artifact; promotion refused and previous dependencies restored."
    exit 2
  }
fi
if ! mv "$BUILD_TMP" "${APP_DIR}/.next"; then
  _err "CRITICAL: Failed to move the candidate artifact into .next — restoring the previous release."
  _ccbi_restore_previous_release
  _preflight_abort_receipt "Candidate artifact promotion failed; previous complete release restored."
  exit 2
fi
TRANSACTION_PHASE="CANDIDATE_LIVE"
rm -rf "$OLD_NEXT_PARK" 2>/dev/null || true
OLD_NEXT_PARK=""
_ok "Complete candidate release promoted (BUILD_ID: ${BUILD_ID})."

###############################################################################
# ─── PHASE 4: RESTART + HEALTH VERIFICATION ───────────────────────────────────
###############################################################################
_banner "Phase 4 — Restart + Health verification"

# PM2 --update-env MERGES the caller environment into the persisted process
# environment; omitting a key does not delete it. Pin the artifact directory so
# the stale value is explicitly reconciled.
export NEXT_DIST_DIR="${APP_DIR}/.next"
_log "Explicitly reconciling PM2 NEXT_DIST_DIR to ${NEXT_DIST_DIR}"

_log "[4a] Restarting pm2 app '${PM2_APP_NAME}' onto fresh build ..."
if pm2 list 2>/dev/null | grep -q "$PM2_APP_NAME"; then
  pm2 restart "$PM2_APP_NAME" --update-env 2>/dev/null || {
    _warn "  pm2 restart failed — trying pm2 reload ..."
    pm2 reload "$PM2_APP_NAME" --update-env 2>/dev/null || true
  }
else
  _warn "  pm2 app '${PM2_APP_NAME}' not found in pm2 list."
  _warn "  Attempting pm2 start from ${APP_DIR} ..."
  if [[ -f "$APP_DIR/ecosystem.config.cjs" ]]; then
    cd "$APP_DIR" || exit 2
    CC_PORT="$PORT" \
      DATABASE_PATH="${DB_PATH_OVERRIDE:-${DATABASE_PATH:-}}" \
      CC_INSTALL_DIR="$APP_DIR" \
      pm2 start "$APP_DIR/ecosystem.config.cjs" --update-env 2>/dev/null || true
  else
    cd "$APP_DIR" || exit 2
    CC_PORT="$PORT" pm2 start npm --name "$PM2_APP_NAME" --update-env -- start 2>/dev/null || true
  fi
fi

_log "  Waiting 5 seconds for server to start ..."
sleep 5

_log "[4b] Running cc-health-check.sh ..."
HEALTH_JSON=""
HEALTH_EXIT=0
ATTEMPT=0

while true; do
  ATTEMPT=$(( ATTEMPT + 1 ))
  HEALTH_EXIT=0
  _run_health_check HEALTH_JSON || HEALTH_EXIT=$?
  _log "  Health check attempt ${ATTEMPT}: exit ${HEALTH_EXIT}"

  if [[ $HEALTH_EXIT -eq 0 ]]; then
    break
  elif [[ $HEALTH_EXIT -eq 1 ]]; then
    _err "  Health check returned exit 1 (definitive NOT GREEN) on attempt ${ATTEMPT}."
    break
  elif [[ $HEALTH_EXIT -eq 3 ]]; then
    _unknown_receipt "$HEALTH_JSON" "$ATTEMPT" "$HEALTH_RETRIES"
    if [[ $ATTEMPT -ge $HEALTH_RETRIES ]]; then
      _err "  Health check returned exit 3 (UNKNOWN) on all ${HEALTH_RETRIES} attempts."
      break
    fi
    _warn "  Retrying in ${HEALTH_RETRY_WAIT}s ... (attempt ${ATTEMPT}/${HEALTH_RETRIES})"
    sleep "$HEALTH_RETRY_WAIT"
  else
    _err "  Health check returned unexpected exit ${HEALTH_EXIT}."
    HEALTH_EXIT=1
    break
  fi
done

###############################################################################
# ─── PHASE 5: VERDICT ────────────────────────────────────────────────────────
###############################################################################
_banner "Phase 5 — Verdict"

if [[ $HEALTH_EXIT -eq 0 ]]; then
  _ok "Deploy is GREEN on the complete candidate release."
  if [[ -n "${LIVE_NODE_MODULES_BACKUP:-}" && -d "$LIVE_NODE_MODULES_BACKUP" ]]; then
    rm -rf "$LIVE_NODE_MODULES_BACKUP" 2>/dev/null \
      && _ok "  Previous dependency tree removed after verified green promotion." \
      || _warn "Could not remove previous dependency tree: ${LIVE_NODE_MODULES_BACKUP}"
    LIVE_NODE_MODULES_BACKUP=""
    PREVIOUS_DEPS_BACKUP=""
  fi
  _ccbi_discard_candidate_release \
    && _ok "  Candidate preparation directory removed." \
    || true

  _log "[5] Persisting pm2 process list (pm2 save) so CC + cloudflared survive OOM/reboot ..."
  pm2 save >/dev/null 2>&1 \
    && _ok "  pm2 process list saved — CC app + cloudflared connector will auto-resurrect after restart/OOM." \
    || _warn "  pm2 save FAILED — process list NOT persisted. Run 'pm2 save' manually so this box survives a reboot."

  # ── The box keeps checking and repairing itself after this deploy ──────────
  # Both steps are BEST-EFFORT by design: neither may change the exit code of
  # an otherwise-green deploy. A failure here is a warning an operator can act
  # on, never a rollback.
  #
  # 1. pm2 log rotation. pm2 appends to ~/.pm2/logs forever; on a long-running
  #    box that is a disk-full incident in waiting, and disk-full takes the
  #    whole CC down. Idempotent: an already-correct box writes nothing.
  _log "[5] Ensuring pm2 log rotation is installed and pinned ..."
  oc_ensure_pm2_logrotate || _warn "  pm2 log rotation setup reported a problem — pm2 logs may grow unbounded on this box."

  # 2. The box watchdog's SCHEDULE. scripts/watchdog-cc.sh is the only thing
  #    that can restart a command center that has stopped answering, and its
  #    header has documented "*/5 * * * *" for as long as it has existed —
  #    while nothing in this repo ever installed that schedule. Measured on the
  #    operator Mac: no crontab, no launchd job, its log untouched since
  #    2026-09-09. Installing it from the deploy is what makes "the system
  #    checks itself" true on every box instead of only where someone
  #    remembered. WATCHDOG_SELF_HEAL=1 enables only the bounded repairs
  #    watchdog-cc.sh already implements; this changes none of its repair logic.
  _log "[5] Installing the box watchdog schedule (scripts/install-watchdog-cc.sh) ..."
  _wd_args=(--port "$PORT" --pm2-app "$PM2_APP_NAME" --app-dir "$APP_DIR")
  [[ -n "$PUBLIC_URL_PROBE" ]] && _wd_args+=(--public-url "$PUBLIC_URL_PROBE")
  if bash "${SCRIPT_DIR}/install-watchdog-cc.sh" "${_wd_args[@]}"; then
    _ok "  Box watchdog scheduled — it checks this CC every 5 minutes and repairs the failures it is allowed to repair."
  else
    _warn "  Box watchdog schedule NOT installed. Nothing out-of-process will restart this CC if it stops answering. Install it with: bash ${SCRIPT_DIR}/install-watchdog-cc.sh --port ${PORT} --pm2-app ${PM2_APP_NAME}"
  fi

  # ── Cleanup rollback + parked build artefacts ──────────────────────────
  # MR-40: On a green deploy the rollback snapshot and any parked
  # .next.old.* directories are stale — the just-deployed build IS the new
  # known-good. Leaving these inside the app tree inflates the deploy,
  # leaks into backups, and confuses audits. The rollback lives in the git
  # history via atomic-deploy.sh's own code; disk snapshot is only needed
  # for immediate rollback within this deploy window. Non-fatal: cleanup
  # failures do not fail an otherwise-green deploy.
  _log "[5] Cleaning up rollback snapshot + parked build artefacts ..."
  if [[ -n "${ROLLBACK_DIR:-}" && -d "$ROLLBACK_DIR" ]]; then
    rm -rf "$ROLLBACK_DIR" 2>/dev/null \
      && _ok "  Rollback snapshot removed: ${ROLLBACK_DIR}" \
      || _warn "  Could not remove rollback snapshot: ${ROLLBACK_DIR}"
  fi
  find "$APP_DIR" -maxdepth 1 -type d -name '.next.old.*' -exec rm -rf {} + 2>/dev/null || true
  if [[ -d "${APP_DIR}/.next.PREDEPLOY" ]]; then
    rm -rf "${APP_DIR}/.next.PREDEPLOY" 2>/dev/null || true
  fi

  if [[ -f "${APP_DIR}/.deploy-rollback-state.json" ]]; then
    _rs_target="$(_ccbi_json_field "${APP_DIR}/.deploy-rollback-state.json" failed_target_inventory_digest)"
    if [[ -n "$_rs_target" && "$_rs_target" == "$POST_BUILD_INVENTORY" ]]; then
      rm -f "${APP_DIR}/.deploy-rollback-state.json" \
        && _ok "  Rollback receipt cleared — verified GREEN deploy of the exact failed-target content (${POST_BUILD_INVENTORY})." \
        || _warn "  Could not remove .deploy-rollback-state.json — remove it manually after verifying this deploy."
    else
      _warn "  Rollback receipt NOT cleared: its failed_target (${_rs_target:-unknown}) does not match this deploy's content (${POST_BUILD_INVENTORY}). Pending-repair state stays open."
    fi
  fi

  _success_receipt "$HEALTH_JSON" "$BUILD_ID"
  exit 0

elif [[ $HEALTH_EXIT -eq 3 ]]; then
  # UNKNOWN retains both complete states: candidate artifact+dependencies live,
  # previous artifact+dependencies available for an explicit operator rollback.
  TRANSACTION_PHASE="UNKNOWN"
  _warn "Deploy ended UNKNOWN after ${ATTEMPT} health-check attempts."
  _warn "The complete CANDIDATE artifact and dependency tree remain live."
  _warn "The complete PREVIOUS artifact and dependency tree remain retained for an explicit rollback."
  _warn "Operator must investigate. Automatic rollback is disabled on UNKNOWN."
  printf '\n%s╔══════════════════════════════════════════════════════════╗%s\n' "$YELLOW" "$RESET" >&2
  printf '%s║  ATOMIC DEPLOY — UNKNOWN (exit 3 after all retries)     ║%s\n' "$YELLOW" "$RESET" >&2
  printf '%s╚══════════════════════════════════════════════════════════╝%s\n' "$YELLOW" "$RESET" >&2
  printf '  Timestamp    : %s\n' "$(_ts)" >&2
  printf '  Attempts     : %s / %s\n' "$ATTEMPT" "$HEALTH_RETRIES" >&2
  printf '  App dir      : %s\n' "$APP_DIR" >&2
  printf '  Build ID     : %s\n' "${BUILD_ID:-unknown}" >&2
  printf '  Candidate deps: promoted\n' >&2
  printf '  Previous deps : %s\n' "${LIVE_NODE_MODULES_BACKUP:-not retained}" >&2
  printf '  Health JSON  :\n%s\n\n' "$HEALTH_JSON" >&2
  exit 3

else
  _err "Health check NOT GREEN (exit ${HEALTH_EXIT}). Executing explicit complete-release rollback ..."
  FAILED_HEALTH_JSON="$HEALTH_JSON"

  if [[ $ROLLBACK_EXISTS -eq 0 ]]; then
    _err "CRITICAL: No rollback artifact exists (.next.rollback not present)."
    _err "The complete candidate release remains live; dependencies were not partially restored."
    _rollback_receipt "$FAILED_HEALTH_JSON" "{\"green\":false,\"error\":\"no rollback artifact; complete candidate retained\"}" \
      "Health check exit ${HEALTH_EXIT}: NOT GREEN; no prior artifact available, so the complete candidate remains live"
    exit 1
  fi

  ROLLBACK_INVENTORY="(unattested)"
  if [[ -f "$ROLLBACK_DIR/build-inventory.json" ]]; then
    _rb_inv="$(_ccbi_json_field "$ROLLBACK_DIR/build-inventory.json" inventory_digest)"
    [[ -n "$_rb_inv" ]] && ROLLBACK_INVENTORY="$_rb_inv"
  fi

  # Prepare the prior artifact beside the live candidate first. A copy failure
  # leaves the complete candidate untouched.
  TRANSACTION_PHASE="ROLLING_BACK"
  ROLLBACK_RESTORE_DIR="${APP_DIR}/.next.restore.$$"
  rm -rf "$ROLLBACK_RESTORE_DIR" 2>/dev/null || true
  if ! cp -r "$ROLLBACK_DIR" "$ROLLBACK_RESTORE_DIR" 2>/dev/null; then
    rm -rf "$ROLLBACK_RESTORE_DIR" 2>/dev/null || true
    TRANSACTION_PHASE="CANDIDATE_LIVE"
    _err "CRITICAL: Failed to prepare .next from rollback artifact!"
    _err "The complete candidate release remains live. Rollback artifact at: ${ROLLBACK_DIR}"
    _rollback_receipt "$FAILED_HEALTH_JSON" "{\"green\":false,\"error\":\"rollback preparation failed; complete candidate retained\"}" \
      "Health check NOT GREEN; rollback preparation FAILED — complete candidate retained"
    exit 1
  fi

  # Park the candidate artifact and move the prepared prior artifact into
  # place. Any interruption in this window restores the complete candidate.
  CANDIDATE_NEXT_PARK="${APP_DIR}/.next.candidate.$$"
  if ! mv "${APP_DIR}/.next" "$CANDIDATE_NEXT_PARK" 2>/dev/null; then
    rm -rf "$ROLLBACK_RESTORE_DIR" 2>/dev/null || true
    TRANSACTION_PHASE="CANDIDATE_LIVE"
    _err "CRITICAL: Failed to park the candidate artifact for rollback; complete candidate remains live."
    _rollback_receipt "$FAILED_HEALTH_JSON" "{\"green\":false,\"error\":\"candidate artifact park failed; complete candidate retained\"}" \
      "Health check NOT GREEN; rollback could not park the candidate — complete candidate retained"
    exit 1
  fi
  if ! mv "$ROLLBACK_RESTORE_DIR" "${APP_DIR}/.next" 2>/dev/null; then
    _ccbi_recover_interrupted_rollback
    _err "CRITICAL: Failed to install the prepared rollback artifact; complete candidate restored."
    _rollback_receipt "$FAILED_HEALTH_JSON" "{\"green\":false,\"error\":\"rollback artifact install failed; complete candidate restored\"}" \
      "Health check NOT GREEN; rollback artifact installation FAILED — complete candidate restored"
    exit 1
  fi

  _log "Restoring the previous dependency tree for the restored build ..."
  if ! _ccbi_restore_previous_dependencies keep-candidate-park; then
    _ccbi_recover_interrupted_rollback
    _err "CRITICAL: Failed to restore previous dependencies; complete candidate restored."
    _rollback_receipt "$FAILED_HEALTH_JSON" "{\"green\":false,\"error\":\"dependency rollback failed; complete candidate restored\"}" \
      "Health check NOT GREEN; dependency rollback FAILED — complete candidate restored"
    exit 1
  fi
  TRANSACTION_PHASE="ROLLED_BACK"
  rm -rf "$CANDIDATE_NEXT_PARK" "$CANDIDATE_DEPS_PARK" 2>/dev/null || true
  CANDIDATE_NEXT_PARK=""
  CANDIDATE_DEPS_PARK=""
  PREVIOUS_DEPS_BACKUP=""

  _log "Restarting pm2 app onto the restored complete release ..."
  pm2 restart "$PM2_APP_NAME" --update-env 2>/dev/null || true
  sleep 5

  _log "Re-running cc-health-check.sh on restored build ..."
  ROLLBACK_HEALTH_JSON=""
  ROLLBACK_HEALTH_EXIT=0
  _run_health_check ROLLBACK_HEALTH_JSON || ROLLBACK_HEALTH_EXIT=$?
  _log "  Rollback health check exit: ${ROLLBACK_HEALTH_EXIT}"

  _rollback_receipt "$FAILED_HEALTH_JSON" "$ROLLBACK_HEALTH_JSON" \
    "Health check exit ${HEALTH_EXIT}: NOT GREEN on new build (BUILD_ID: ${BUILD_ID:-unknown}); server rolled back to the prior complete release"

  _ccbi_write_rollback_state \
    "$APP_DIR" \
    "$ROLLBACK_INVENTORY" \
    "$PRE_BUILD_INVENTORY" \
    "${BUILD_ID:-unknown}" \
    "Health check exit ${HEALTH_EXIT} on target build ${BUILD_ID:-unknown}; auto-rolled back to the prior complete release" \
    && _ok "  Rollback receipt written: ${APP_DIR}/.deploy-rollback-state.json (prior=${ROLLBACK_INVENTORY})" \
    || _err "  Failed to write rollback receipt — degraded state NOT recorded; startup guard will refuse the mismatch loudly."

  _ccbi_discard_candidate_release \
    && _ok "  Candidate preparation directory removed after rollback." \
    || true

  if [[ $ROLLBACK_HEALTH_EXIT -eq 0 ]]; then
    _warn "Rollback complete. Server is GREEN on the PRIOR complete release — AVAILABLE BUT DEGRADED (pending repair)."
    _warn "This is NOT a successful upgrade: health output separates availability from target freshness."
    _warn "Investigate the failing health-check JSON above before re-deploying."
  else
    _err "ALERT: Rollback complete but server is still NOT GREEN (exit ${ROLLBACK_HEALTH_EXIT}) on the prior complete release."
    _err "Operator must investigate immediately. See rollback health JSON above."
  fi

  exit 1
fi
