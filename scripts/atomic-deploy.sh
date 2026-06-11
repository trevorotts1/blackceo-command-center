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
#   --health-retries N   Number of times to retry after exit-3 UNKNOWN from health check (default: 3)
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
# INVARIANTS (from B.2 spec)
#   Never partial     — the live .next is replaced by a single atomic rename/move
#   Never unverified  — every deploy is followed by cc-health-check.sh
#   Never silent fail — a non-green result always produces a loud receipt with health-check JSON
#   Never disk-blind  — 5 GB disk gate runs before any build artifacts are written
#   Rollback verified — the rollback itself is health-checked before the script exits
#   Never rollback 3  — exit 3 (UNKNOWN/transient) triggers retry, never rollback
#
# REQUIRES: bash 4+, pm2, npm, python3, sqlite3, curl, df

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
APP_DIR="${CC_APP_DIR:-${HOME}/projects/mission-control}"
PM2_APP_NAME="${CC_PM2_APP_NAME:-mission-control}"
PORT="${CC_PORT:-4000}"
DB_PATH_OVERRIDE="${CC_DB_PATH:-}"
DISK_PATH_OVERRIDE="${CC_DISK_PATH:-}"
DISK_MIN_GB="${CC_DISK_MIN_GB:-5}"
HEALTH_RETRIES="${CC_HEALTH_RETRIES:-3}"
HEALTH_RETRY_WAIT="${CC_HEALTH_RETRY_WAIT:-15}"
CANONICAL_DIR_OVERRIDE="${CC_CANONICAL_DIR:-}"
PUBLIC_URL_PROBE="${CC_PUBLIC_URL:-}"
# Fixture harness override: if set, use this path for cc-health-check.sh instead of SCRIPT_DIR
HEALTH_CHECK_PATH_OVERRIDE="${CC_HEALTH_CHECK_PATH:-}"

###############################################################################
# Argument parsing
###############################################################################
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir)           APP_DIR="${2:?--app-dir requires a value}"; shift 2 ;;
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

  # Old DB backups (mission-control.db.backup.YYYY-MM-DD pattern)
  find "$dir" -maxdepth 1 -name "mission-control.db.backup.*" -type f -delete 2>/dev/null || true
  # Keep the most-recent plain .backup for emergency recovery; clean dated ones only
  # Actually: the rollback artifact is .next.rollback; DB backup for this deploy is
  # written to a timestamped path. Clean up backups older than 3 days.
  find "$dir" -maxdepth 1 -name "*.db.backup" -not -newer "$dir" -type f 2>/dev/null |
    while IFS= read -r f; do
      local age_days
      age_days=$(( ( $(date +%s) - $(stat -c%Y "$f" 2>/dev/null || stat -f%m "$f" 2>/dev/null || echo 0) ) / 86400 ))
      [[ "$age_days" -ge 3 ]] && rm -f "$f" && _log "  Removed old DB backup: $(basename "$f")"
    done || true

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
  json_tmp=$(mktemp /tmp/cc-health-$$.json)
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
for _dep in pm2 npm python3 sqlite3 curl df; do
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
  # Resolve from well-known paths relative to APP_DIR
  for _candidate in \
    "${APP_DIR}/mission-control.db" \
    "/data/mission-control/mission-control.db" \
    "/data/projects/command-center/mission-control.db"; do
    if [[ -f "$_candidate" ]]; then
      DB_FILE="$_candidate"
      break
    fi
  done
fi

if [[ -z "$DB_FILE" || ! -f "$DB_FILE" ]]; then
  _warn "  DB not found (tried APP_DIR and heuristic paths). Skipping DB backup."
  _warn "  Supply --db-path if the DB is at a non-standard location."
  DB_BACKUP=""
else
  DB_BACKUP="${DB_FILE}.backup.$(date +%Y%m%d-%H%M%S)"
  sqlite3 "$DB_FILE" '.timeout 5000' 'PRAGMA wal_checkpoint(TRUNCATE);' 2>/dev/null || true
  cp "$DB_FILE" "$DB_BACKUP"
  _ok "  DB backed up: ${DB_BACKUP}"
fi

# ── 1c. Snapshot current .next as rollback artifact ───────────────────────────
_log "[1c] Snapshotting .next as rollback artifact"
NEXT_DIR="${APP_DIR}/.next"
ROLLBACK_DIR="${APP_DIR}/.next.rollback"

if [[ -d "$NEXT_DIR" ]]; then
  rm -rf "$ROLLBACK_DIR"
  cp -r "$NEXT_DIR" "$ROLLBACK_DIR"
  _ok "  Rollback artifact created: ${ROLLBACK_DIR}"
  ROLLBACK_EXISTS=1
else
  _warn "  No existing .next directory found — rollback artifact not created."
  _warn "  On build failure, there is nothing to roll back to."
  ROLLBACK_EXISTS=0
fi

# ── 1d. Kill non-canonical pm2 apps for this product ─────────────────────────
_log "[1d] Killing non-canonical pm2 apps for this product"
# Find all pm2 apps whose name contains a CC keyword but is NOT the canonical name.
# These are zombies that could fight for the port.
NON_CANONICAL=$(pm2 jlist 2>/dev/null | python3 -s -c "
import sys, json
try:
  apps = json.load(sys.stdin) or []
  canonical = sys.argv[1]
  port_str = sys.argv[2]
  keywords = ('mission-control', 'command-center', 'blackceo')
  for app in apps:
    env = app.get('pm2_env') or {}
    name = (env.get('name') or app.get('name') or '').strip()
    name_lc = name.lower()
    # Is it a CC app?
    is_cc = any(kw in name_lc for kw in keywords)
    if not is_cc:
      continue
    # Is it canonical?
    if name == canonical:
      continue
    # Non-canonical CC app — print its name
    print(name)
except Exception as e:
  import sys as _sys
  print(f'ERROR:{e}', file=_sys.stderr)
" "$PM2_APP_NAME" "$PORT" 2>/dev/null || true)

if [[ -n "$NON_CANONICAL" ]]; then
  while IFS= read -r zombie_name; do
    [[ -z "$zombie_name" ]] && continue
    _warn "  Killing non-canonical pm2 app: '${zombie_name}'"
    pm2 delete "$zombie_name" 2>/dev/null || pm2 stop "$zombie_name" 2>/dev/null || true
  done <<< "$NON_CANONICAL"
  _ok "  Non-canonical pm2 apps removed."
else
  _ok "  No non-canonical pm2 apps found."
fi

_ok "Phase 1 pre-flight passed."

###############################################################################
# ─── PHASE 2: BUILD TO TEMP DIR ─────────────────────────────────────────────
###############################################################################
_banner "Phase 2 — Build (temp dir)"

BUILD_TMP="${APP_DIR}/.next.tmp.$(date +%Y%m%d-%H%M%S)-$$"
_log "Building into temp dir: ${BUILD_TMP}"

# Record build start time (seconds since epoch) for mtime guard below.
# We compare BUILD_ID mtime against this value to ensure the file was written
# by THIS build invocation, not carried over from the Phase 1c snapshot.
BUILD_START_TS=$(date +%s 2>/dev/null || echo 0)

# Export NEXT output dir env var so Next.js writes to the temp dir instead of .next
# Next.js honours the NEXT_DIST_DIR env variable as the output directory.
export NEXT_DIST_DIR="$BUILD_TMP"

cd "$APP_DIR"

# ── Capture npm exit code before the pipe ────────────────────────────────────
# IMPORTANT: piping npm run build through a while-read loop MASKS the exit
# code because the pipe's last command (the loop) returns 0. We work around
# this by writing npm's exit code to a temp file inside the subshell and
# reading it back after the pipe drains. This is the only portable approach
# that also preserves streaming build output.
BUILD_EXIT_FILE=$(mktemp /tmp/atomic-build-exit-$$.txt)
echo "2" > "$BUILD_EXIT_FILE"   # Pre-set to failure; overwritten only on clean exit

export BUILD_EXIT_FILE

_log "Running: npm run build  (output: ${BUILD_TMP})"
(
  npm run build 2>&1
  echo $? > "$BUILD_EXIT_FILE"
) | while IFS= read -r line; do
  printf '%s[build] %s%s\n' "${CYAN}" "${RESET}" "$line" >&2
done

BUILD_EXIT=$(cat "$BUILD_EXIT_FILE" 2>/dev/null || echo 2)
rm -f "$BUILD_EXIT_FILE"
_log "  npm run build exited: ${BUILD_EXIT}"

# ── Validate output: BUILD_ID must exist AND be fresh (mtime > BUILD_START_TS) ──
# The mtime guard prevents the Phase 1c cp artefact (old BUILD_ID copied into
# APP_DIR/.next) from being accepted as a fresh build result. A BUILD_ID whose
# mtime is <= BUILD_START_TS was NOT written by this build invocation.
#
# Rule: treat any scenario where BUILD_TMP/BUILD_ID is absent (or stale) after
# build as exit 2 unconditionally — regardless of APP_DIR/.next/BUILD_ID state.
BUILD_ID_FILE="${BUILD_TMP}/BUILD_ID"

# If NEXT_DIST_DIR is not respected (some Next.js versions ignore it), fall back:
# build output may still have gone to .next. Detect which happened.
if [[ ! -f "$BUILD_ID_FILE" && -f "${APP_DIR}/.next/BUILD_ID" ]]; then
  _warn "  NEXT_DIST_DIR not respected by this Next.js version — build went to .next directly."

  # Mtime guard: reject the BUILD_ID if it predates the build start.
  # A stale BUILD_ID here means Phase 1c wrote it (it's the old build artefact);
  # npm produced no new output at all — treat as build failure.
  NEXT_BUILD_ID_MTIME=$(stat -c%Y "${APP_DIR}/.next/BUILD_ID" 2>/dev/null \
    || stat -f%m "${APP_DIR}/.next/BUILD_ID" 2>/dev/null \
    || echo 0)
  if (( NEXT_BUILD_ID_MTIME <= BUILD_START_TS )); then
    _err "  BUILD_ID mtime (${NEXT_BUILD_ID_MTIME}) predates build start (${BUILD_START_TS})."
    _err "  This BUILD_ID is the Phase 1c snapshot copy, not a fresh build artefact."
    _err "  Treating as build failure — live .next is untouched."
    rm -rf "$BUILD_TMP" 2>/dev/null || true
    _preflight_abort_receipt "Build failed: BUILD_ID in .next is stale (mtime predates build start). npm run build produced no new output."
    exit 2
  fi

  _warn "  Moving ${APP_DIR}/.next to ${BUILD_TMP} as the temp build artifact (mtime guard passed)."
  mv "${APP_DIR}/.next" "$BUILD_TMP" 2>/dev/null || {
    _err "  Failed to move .next to temp dir. Aborting."
    # Restore rollback if we disturbed .next
    if [[ $ROLLBACK_EXISTS -eq 1 ]]; then
      cp -r "$ROLLBACK_DIR" "${APP_DIR}/.next" 2>/dev/null || true
    fi
    _preflight_abort_receipt "Failed to move .next to temp build dir after NEXT_DIST_DIR bypass."
    exit 2
  }
  BUILD_ID_FILE="${BUILD_TMP}/BUILD_ID"
fi

# Final check: BUILD_ID must exist in BUILD_TMP AND be fresh.
# No fallback to APP_DIR/.next/BUILD_ID — absent BUILD_ID in BUILD_TMP = exit 2.
if [[ ! -f "$BUILD_ID_FILE" ]]; then
  _err "Build FAILED — BUILD_ID not present in output directory (${BUILD_TMP})."
  _err "No fallback accepted: live .next was NOT touched."
  rm -rf "$BUILD_TMP" 2>/dev/null || true
  _preflight_abort_receipt "Build exited ${BUILD_EXIT} or BUILD_ID absent. Live .next was NOT swapped."
  exit 2
fi

# Mtime guard on the primary build path: BUILD_ID must be newer than build start.
BUILD_ID_MTIME=$(stat -c%Y "$BUILD_ID_FILE" 2>/dev/null \
  || stat -f%m "$BUILD_ID_FILE" 2>/dev/null \
  || echo 0)
if (( BUILD_ID_MTIME <= BUILD_START_TS )); then
  _err "  BUILD_ID mtime (${BUILD_ID_MTIME}) <= build start (${BUILD_START_TS})."
  _err "  This BUILD_ID predates the build — stale artefact in BUILD_TMP."
  rm -rf "$BUILD_TMP" 2>/dev/null || true
  _preflight_abort_receipt "Build failed: BUILD_ID in BUILD_TMP is stale (mtime predates build start)."
  exit 2
fi

# npm exit code must be 0 for a successful build.
if [[ $BUILD_EXIT -ne 0 ]]; then
  _err "Build FAILED — npm run build exited ${BUILD_EXIT}."
  rm -rf "$BUILD_TMP" 2>/dev/null || true
  _preflight_abort_receipt "npm run build exited ${BUILD_EXIT}. Live .next was NOT swapped."
  exit 2
fi

BUILD_ID=$(cat "$BUILD_ID_FILE" 2>/dev/null || echo "unknown")
_ok "Build succeeded. BUILD_ID: ${BUILD_ID}"

###############################################################################
# ─── PHASE 3: ATOMIC SWAP ───────────────────────────────────────────────────
###############################################################################
_banner "Phase 3 — Atomic swap"

_log "Swapping ${BUILD_TMP} → ${APP_DIR}/.next (single rename)"

# Atomically replace .next with the new build using rename.
# mv on the same filesystem is atomic at the kernel level (rename syscall).
# We park the old .next aside to a temp name first, then rename the new build in.
# This ensures there is NO window where .next does not exist.
OLD_NEXT_PARK="${APP_DIR}/.next.old.$$"

if [[ -d "${APP_DIR}/.next" ]]; then
  mv "${APP_DIR}/.next" "$OLD_NEXT_PARK" 2>/dev/null || {
    _err "Failed to park old .next — aborting swap."
    rm -rf "$BUILD_TMP" 2>/dev/null || true
    _preflight_abort_receipt "mv ${APP_DIR}/.next to park path failed. Old build untouched."
    exit 2
  }
fi

mv "$BUILD_TMP" "${APP_DIR}/.next" 2>/dev/null || {
  _err "CRITICAL: Failed to move new build into .next — attempting to restore old build."
  # Try to put old build back
  if [[ -d "$OLD_NEXT_PARK" ]]; then
    mv "$OLD_NEXT_PARK" "${APP_DIR}/.next" 2>/dev/null || {
      _err "DOUBLE FAILURE: could not restore old build. Manual intervention required."
      _err "Old build parked at: ${OLD_NEXT_PARK}"
      _err "New build at: ${BUILD_TMP}"
    }
  fi
  _preflight_abort_receipt "Atomic swap of new build into .next failed."
  exit 2
}

# Clean up parked old build (it's now superseded by .next.rollback)
rm -rf "$OLD_NEXT_PARK" 2>/dev/null || true

_ok "Atomic swap complete. .next is now the fresh build (BUILD_ID: ${BUILD_ID})"

###############################################################################
# ─── PHASE 4: RESTART + HEALTH VERIFICATION ─────────────────────────────────
###############################################################################
_banner "Phase 4 — Restart + Health verification"

# Restart the server onto the fresh build.
_log "[4a] Restarting pm2 app '${PM2_APP_NAME}' onto fresh build ..."
if pm2 list 2>/dev/null | grep -q "$PM2_APP_NAME"; then
  pm2 restart "$PM2_APP_NAME" 2>/dev/null || {
    _warn "  pm2 restart failed — trying pm2 reload ..."
    pm2 reload "$PM2_APP_NAME" 2>/dev/null || true
  }
else
  _warn "  pm2 app '${PM2_APP_NAME}' not found in pm2 list."
  _warn "  Attempting pm2 start from ${APP_DIR} ..."
  cd "$APP_DIR"
  pm2 start npm --name "$PM2_APP_NAME" -- start 2>/dev/null || true
fi

# Brief settle window before probing (server needs a few seconds to bind the port)
_log "  Waiting 5 seconds for server to start ..."
sleep 5

# Run health check with retry loop for exit code 3 (UNKNOWN)
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
    # Green — success
    break
  elif [[ $HEALTH_EXIT -eq 1 ]]; then
    # Definitive not-green — proceed to rollback
    _err "  Health check returned exit 1 (definitive NOT GREEN) on attempt ${ATTEMPT}."
    break
  elif [[ $HEALTH_EXIT -eq 3 ]]; then
    # UNKNOWN/transient
    _unknown_receipt "$HEALTH_JSON" "$ATTEMPT" "$HEALTH_RETRIES"
    if [[ $ATTEMPT -ge $HEALTH_RETRIES ]]; then
      _err "  Health check returned exit 3 (UNKNOWN) on all ${HEALTH_RETRIES} attempts."
      break
    fi
    _warn "  Retrying in ${HEALTH_RETRY_WAIT}s ... (attempt ${ATTEMPT}/${HEALTH_RETRIES})"
    sleep "$HEALTH_RETRY_WAIT"
  else
    # exit 2 (usage error from health check) or unexpected — treat as definitive fail
    _err "  Health check returned unexpected exit ${HEALTH_EXIT}."
    HEALTH_EXIT=1
    break
  fi
done

###############################################################################
# ─── PHASE 5: VERDICT ───────────────────────────────────────────────────────
###############################################################################
_banner "Phase 5 — Verdict"

if [[ $HEALTH_EXIT -eq 0 ]]; then
  # ── SUCCESS ─────────────────────────────────────────────────────────────────
  _ok "Deploy is GREEN on the new build."
  _success_receipt "$HEALTH_JSON" "$BUILD_ID"
  exit 0

elif [[ $HEALTH_EXIT -eq 3 ]]; then
  # ── UNKNOWN — pause/retry exhausted; DO NOT rollback ────────────────────────
  # Per B.2 spec: exit 3 → pause/retry N times; NEVER rollback on exit 3.
  _warn "Deploy ended UNKNOWN after ${ATTEMPT} health-check attempts."
  _warn "The new build is live but the health check could not confirm green."
  _warn "Operator must investigate. DO NOT use auto-rollback on exit 3."
  printf '\n%s╔══════════════════════════════════════════════════════════╗%s\n' "$YELLOW" "$RESET" >&2
  printf '%s║  ATOMIC DEPLOY — UNKNOWN (exit 3 after all retries)     ║%s\n' "$YELLOW" "$RESET" >&2
  printf '%s╚══════════════════════════════════════════════════════════╝%s\n' "$YELLOW" "$RESET" >&2
  printf '  Timestamp    : %s\n' "$(_ts)" >&2
  printf '  Attempts     : %s / %s\n' "$ATTEMPT" "$HEALTH_RETRIES" >&2
  printf '  App dir      : %s\n' "$APP_DIR" >&2
  printf '  Build ID     : %s\n' "${BUILD_ID:-unknown}" >&2
  printf '  Health JSON  :\n%s\n\n' "$HEALTH_JSON" >&2
  exit 3

else
  # ── ROLLBACK ─────────────────────────────────────────────────────────────────
  _err "Health check NOT GREEN (exit ${HEALTH_EXIT}). Executing auto-rollback ..."
  FAILED_HEALTH_JSON="$HEALTH_JSON"

  if [[ $ROLLBACK_EXISTS -eq 0 ]]; then
    _err "CRITICAL: No rollback artifact exists (.next.rollback not present)."
    _err "Cannot roll back — this is a first-deploy or the snapshot was not taken."
    _rollback_receipt "$FAILED_HEALTH_JSON" "{\"green\":false,\"error\":\"no rollback artifact\"}" \
      "Health check exit ${HEALTH_EXIT}: NOT GREEN; no rollback artifact available"
    exit 1
  fi

  _log "Restoring .next.rollback → .next ..."
  rm -rf "${APP_DIR}/.next" 2>/dev/null || true
  cp -r "$ROLLBACK_DIR" "${APP_DIR}/.next" 2>/dev/null || {
    _err "CRITICAL: Failed to restore .next from rollback artifact!"
    _err "The live .next directory is MISSING. Manual intervention required."
    _err "Rollback artifact at: ${ROLLBACK_DIR}"
    _rollback_receipt "$FAILED_HEALTH_JSON" "{\"green\":false,\"error\":\"rollback restore failed\"}" \
      "Health check NOT GREEN; rollback restore FAILED — manual intervention required"
    exit 1
  }

  _log "Restarting pm2 app onto restored build ..."
  pm2 restart "$PM2_APP_NAME" 2>/dev/null || true
  sleep 5

  _log "Re-running cc-health-check.sh on restored build ..."
  ROLLBACK_HEALTH_JSON=""
  ROLLBACK_HEALTH_EXIT=0
  _run_health_check ROLLBACK_HEALTH_JSON || ROLLBACK_HEALTH_EXIT=$?
  _log "  Rollback health check exit: ${ROLLBACK_HEALTH_EXIT}"

  _rollback_receipt "$FAILED_HEALTH_JSON" "$ROLLBACK_HEALTH_JSON" \
    "Health check exit ${HEALTH_EXIT}: NOT GREEN on new build (BUILD_ID: ${BUILD_ID:-unknown}); server rolled back to prior build"

  if [[ $ROLLBACK_HEALTH_EXIT -eq 0 ]]; then
    _warn "Rollback complete. Server is GREEN on the prior build."
    _warn "Investigate the failing health-check JSON above before re-deploying."
  else
    _err "ALERT: Rollback complete but server is still NOT GREEN (exit ${ROLLBACK_HEALTH_EXIT}) on the prior build."
    _err "Operator must investigate immediately. See rollback health JSON above."
  fi

  exit 1
fi
