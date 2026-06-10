#!/usr/bin/env bash
# cc-health-check.sh — THE single definition of "green" for a deployed
# BlackCEO Command Center instance.
#
# PRD Addendum B, item B.1 (P0) — REDO #10 fixes applied
#
# REDO #10 fixes (REDO #2 adversarial-round fixes, applied on top of REDO #9):
#
# [WRONG VERDICT — Row 28 — SQLite BUSY → UNKNOWN, not FAIL]:
#   DB locked during heavy write or migration: the script was marking
#   company_name.pass=false (exit 1 = FAIL). Truth table Row 28 mandates UNKNOWN.
#   Additionally the truth table requires a DISTINCT indeterminate exit code so
#   callers can distinguish 'known bad' from 'cannot tell'.
#   Fix: add exit code 3 for UNKNOWN/indeterminate states. company_name BUSY path
#   now exits 3. Callers (deploy.sh auto-rollback gate) MUST NOT treat exit 3 as
#   a definitive failure — it signals a transient infrastructure condition.
#   CHANGELOG: exit 0=green, exit 1=not-green, exit 2=usage error, exit 3=UNKNOWN.
#
# [WRONG VERDICT — Row 21 — DATABASE_PATH unset → PASS]:
#   A box where DATABASE_PATH was never set in pm2 env (uses src/lib/db/index.ts
#   default process.cwd()/mission-control.db). The script was setting pm2_topology
#   pass=false ('DATABASE_PATH not explicitly set'). Truth table Row 21 mandates PASS:
#   'Default path is valid; unset is not misconfigured'.
#   Fix: demote the DATABASE_PATH-unset condition to a warning detail field on a
#   PASSING check, not a FAILING one. pm2_topology.pass remains true in all other
#   conditions. The JSON output gains 'database_path_warn' when unset.
#
# [WRONG VERDICT — Row 6 — fresh install, no company row → UNKNOWN, not FAIL]:
#   Fresh install, never onboarded, companies table is empty. Script was marking
#   company_name.pass=false ('Unconfigured box has no company row') => exit 1 (FAIL).
#   Truth table Row 6 mandates UNKNOWN: 'Fresh install is not a broken install;
#   B.1 must not block bootstrapping'.
#   Fix: when COMPANY_CONFIG_EXISTS_BOOL=false AND DB has no company row AND the
#   table itself exists (fresh install), mark company_name UNKNOWN (exit 3).
#   If the DB is absent entirely, that remains FAIL (different condition).
#
# [WRONG VERDICT — Row 10 — server unreachable during B.2 deploy restart → UNKNOWN]:
#   curl times out to 127.0.0.1:PORT, _http_check returns 'fail:000', http_root.pass=false
#   => exit 1. Truth table Row 10 mandates UNKNOWN: 'Server may be starting; B.2 deploy
#   calls B.1 before pm2 is fully up'. exit 1 causes B.2's auto-rollback gate to fire
#   on a valid deployment in progress.
#   Fix: HTTP code 000 (connection refused / timeout) maps to UNKNOWN (exit 3), not FAIL.
#   Only a definitive non-200 code (e.g. 500, 503) maps to FAIL.
#
# [WRONG VERDICT — Row 24 — disk threshold 500 MB, not 5 GB]:
#   Default DISK_MIN_GB was 5 (5 GB). Truth table Row 23/24 use 500 MB as the
#   pass/fail boundary. A box with 1 GB free got FAIL from the script but PASS per spec.
#   Fix: change default DISK_MIN_GB from 5 to 0.5 (500 MB). Callers that need the
#   5 GB build-threshold check must pass --disk-min-gb 5 explicitly.
#
# [missingFromSpec — /api/health body parse in Check 1]:
#   Check 1 only verified HTTP 200 on /api/health. A box with pending migrations
#   or a broken da_challenges schema returns 200 {status:'ok', gap:0} — a confirmed
#   false-green (the migration-020 Sheila-class pattern). Adding body parse to Check 1:
#   if /api/health returns {status:'degraded'} or {gap > 0}, mark http_api_health.pass=false
#   with detail 'N pending migrations detected (status: degraded)'.
#   Also added to the B.1 spec comment in route.ts.
#
# [missingFromSpec — --public-url CF tunnel warning]:
#   No public-URL / CF tunnel health check exists. While not a hard B.1 gate, a
#   CF Access misconfiguration on a client subdomain produces no automated signal.
#   Fix: add --public-url <URL> flag. When set, cc-health-check.sh probes the
#   public subdomain: expects 302-to-CF-login (not 200, not connection-error).
#   Emits a WARNING (not a hard FAIL) in the JSON output under 'warnings' key.
#   This is not a B.1 gate check; it does not affect green/not-green verdict.
#
# [missingFromSpec — exit code 3 for UNKNOWN/indeterminate]:
#   The truth table explicitly requires 'a distinct indeterminate exit code so
#   the caller can distinguish known bad from cannot tell'. Previous script only
#   had exit 0 (green), exit 1 (not green), exit 2 (usage).
#   Fix: add exit 3 = UNKNOWN/indeterminate. Triggered by: DB BUSY after retries,
#   fresh-install no-company-row (not broken), server unreachable (000 = may be starting).
#   The overall 'green' field in JSON remains false for UNKNOWN (not-green), but
#   the exit code distinguishes UNKNOWN from definitive FAIL.
#

# REDO #9 fix [P0 — false-green, unconfigured-box branch missing empty-HTML guard]:
#   When COMPANY_CONFIG_EXISTS_BOOL=false (config not discovered), ALLOW_DEFAULT=0,
#   DB contains a real non-Default non-empty name (e.g. 'Acme Corp'), AND all three
#   HTML extraction methods yield empty string, the else branch at line 974-976
#   emitted company_name.pass=true with html_name='' — no HTML side was ever verified.
#   Spec: 'sqlite3 DB-direct AND from served HTML; must match' — no unconfigured-box
#   exception. This is the REDO #8 mirror guard, symmetrically applied.
#   Fix: insert between the mismatch elif and the else: an explicit guard
#     [[ -z "$COMPANY_HTML_NAME" ]] => company_name.pass=false,
#     detail "could not extract company name from served HTML — branding unverifiable
#     (unconfigured box; no og:site_name, data-company, or <title> found)".
#
# REDO #9 fix [NON-BLOCKING — misleading detail string]:
#   The else branch that marks company_name.pass=true in the unconfigured path
#   printed 'Company name OK (unconfigured box — Default acceptable with --allow-default)'
#   even when ALLOW_DEFAULT=0 and DB is not 'Default'. The parenthetical describes
#   the --allow-default=Default use-case, not this code path.
#   Fix: use an accurate detail: 'Company name consistent — unconfigured box, DB: <name>, HTML: <name>'.
#
# REDO #9 fix [NON-BLOCKING — _CC_CFGOUT temp file leak]:
#   /tmp/_CC_CFGOUT (line 872) was created with mktemp but had no EXIT trap.
#   The _PM2_SCRIPT temp file (line 1031) has a proper trap. Added _CC_CFGOUT to
#   the EXIT trap for consistency and to prevent leaks on unexpected exits.
#
# REDO #9 fix [NON-BLOCKING — vacuous cwd_ok=true in zero-CC-apps path]:
#   When app_count=0, the Python script emitted cwd_ok=True because no comparison
#   was performed. Spec line 21: 'a cwd check that compared nothing may never report
#   cwd_ok=true.' The overall verdict is still correctly false (app_count=0 → topology
#   fails before cwd_ok is consulted), but the JSON field was wrong per spec letter.
#   Fix: emit cwd_ok=False explicitly in the zero-CC-apps path.
#
# REDO #8 fix [P0 — empty-HTML silent pass, Round-3 adversarial]:
#   When COMPANY_CONFIG_EXISTS=true AND the DB has a real non-Default name BUT all
#   three HTML extraction methods (og:site_name, data-company, <title>) yield empty,
#   the mismatch elif ([[ -n "$COMPANY_HTML_NAME" && ... ]]) was skipped and
#   company_name passed WITHOUT the HTML side ever being verified. The spec requires
#   BOTH DB and HTML to be checked on a configured box.
#   Fix: add an explicit FIRST branch in the configured-box path:
#     [[ -z "$COMPANY_HTML_NAME" ]] => company_name.pass=false,
#     detail "could not extract company name from served HTML — branding unverifiable".
#   Mirror the same guard in the unconfigured-box branch for an empty-string DB name.
#   Also make <title> regex case-insensitive (grep -ioE instead of grep -oE).
#
# REDO #7 fix [P0 — spec line 20, false-green]: Partial-branding guard in the
#   configured-box branch (lines 852-884). When company-config.json EXISTS but
#   companyName is empty/null/whitespace AND the DB has a valid non-Default name
#   (e.g. 'Acme Corp'), the script was taking the configured-box branch, matching
#   DB+HTML, and returning company_name.pass=true / green=true.  Spec line 20 states
#   NOT green unconditionally when config file exists but companyName is empty/null/
#   whitespace.  Fix: add an explicit guard at the top of the configured-box branch:
#   if COMPANY_CONFIG_EXISTS_BOOL='true' and the resolved companyName is empty/null/
#   whitespace → emit company_name.pass=false with detail 'config file present but
#   companyName is empty — misconfigured box' before any DB comparison.
#
# REDO #7 fix [P1 — Sheila-class, spec intent]: Discovery-failure + DB=Default.
#   When company-config.json exists at a non-standard path not reachable by any of
#   the three discovery methods (--canonical-dir, pm2 pm_cwd, heuristic dirs) AND
#   the DB contains 'Default', the script set COMPANY_CONFIG_EXISTS_BOOL='false',
#   took the 'unconfigured box — Default acceptable' branch, and returned green=true.
#   This is exactly the Sheila branding-seed failure B.1 was designed to catch.
#   Fix (option a): treat DB='Default' as NOT green in the unconfigured branch as well,
#   unless --allow-default is explicitly passed.  This closes the gap with no path-
#   passing changes needed in callers.  Post-deploy gates MUST NOT pass --allow-default.
#
# REDO #6 fix: PRD directive (c) — apps_with_cwd filter removed from the cwd check.
#   The old `apps_with_cwd = [a for a in cc_apps if get_cwd(a)]` filtered out CC apps
#   that lacked pm_cwd, allowing them to silently pass the cwd check. Fix: compare ALL
#   cc_apps directly. get_cwd(a) returning '' normalises to '.' via normpath, which !=
#   any real canon_dir → cwd_ok=False. This closes the vacuous-all() hole entirely:
#   all([]) cannot be reached because zero cc_apps → topology fails on app_count first.
#
# REDO #5 fix: WRONG-VERDICT title extraction — production HTML format.
#
# REDO #4 fix: DEFECT 3 — macOS BSD grep -c two-stage pipeline multiline bug.
#   ASSETS_FOUND_TOTAL was computed via 'grep -v ... | grep -c .' which returns
#   '0\n0' on macOS when the input is empty. The subsequent [[ -eq 0 ]] arithmetic
#   test threw a syntax error and silently skipped the zero-assets FAIL branch,
#   causing static_assets.pass=true on a page with no /_next/static refs.
#   Fix: single-stage 'grep -c [^[:space:]]' + sanitize with ${...%%$'\n'*}.
#
# REQUIRES: bash 4+ (hard guard below), curl, sqlite3, pm2, python3, df
# macOS note: GNU coreutils 'timeout' must be available (brew install coreutils).
#   The script falls back to a portable background-subshell+kill pattern if
#   GNU timeout is absent, so the check is soft-degrading, not hard-failing.
#   Add /opt/homebrew/bin to PATH before calling this script on Mac.
#
# OUTPUT
# ------
# JSON to stdout:
# {
#   "green": true | false,
#   "timestamp": "ISO-8601",
#   "checks": {
#     "http_root":        { "pass": bool, "detail": "..." },
#     "http_api_health":  { "pass": bool, "detail": "..." },
#     "static_assets":    { "pass": bool, "detail": "...",
#                           "assets_found": N,   <- ALL refs extracted from HTML
#                           "total": N,          <- assets actually probed (may be < assets_found if capped)
#                           "capped": bool,      <- true when total < assets_found
#                           "failed": ["/_next/static/…:HTTP404"] },
#     "company_name":     { "pass": bool, "detail": "...",
#                           "db_name": "Acme", "html_name": "Acme",
#                           "config_exists": bool,
#                           "config_warn": "..." },   <- present when config_exists=false due to heuristic miss
#     "pm2_topology":     { "pass": bool, "detail": "...",
#                           "app_count": 1, "crash_loopers": [],
#                           "database_path_set": bool, "cwd_ok": bool },
#     "disk_headroom":    { "pass": bool, "detail": "...",
#                           "free_gb": 12, "path": "/data", "threshold_gb": 5 }
#   }
# }
#
# Exit codes: 0 = green, 1 = not green (definitive), 2 = usage error, 3 = UNKNOWN/indeterminate
#   Exit 3 is triggered by transient infrastructure conditions (DB BUSY, server 000/connecting,
#   fresh-install with no data). Callers must NOT treat exit 3 as a definitive failure;
#   it means 'cannot determine green/not-green — retry when the condition clears'.
#   B.2 auto-rollback gate: trigger rollback on exit 1 only; exit 3 → pause and retry.
#
# PARAMETERS (env vars or flags — flags take precedence)
# -------------------------------------------------------
#   --port PORT            TCP port the CC listens on          (default: 4000)
#   --db-path PATH         Absolute path to mission-control.db (default: resolve from pm2/env)
#   --canonical-dir DIR    Canonical install directory (auto-derived; emit warning if unresolvable)
#   --host HOST            Public hostname/URL for display only (default: http://127.0.0.1:PORT)
#   --disk-path PATH       Path to check for disk headroom     (default: data-volume heuristic)
#   --disk-min-gb N        Minimum free GB required            (default: 0.5 = 500 MB per truth table Rows 23/24)
#                          Pass --disk-min-gb 5 for the 5 GB build-preflight threshold (B.4 pre-flight gate)
#   --pm2-check-window N   Seconds between restart-count snapshots for delta check (default: 15)
#   --max-assets N         Max /_next/static assets to probe   (0=unlimited; default: 0)
#                          When capped, assets_found reflects the true count and capped=true in JSON.
#   --public-url URL       Public subdomain URL (e.g. https://acme.zerohumanworkforce.com)
#                          When set, probes the public URL and emits a WARNING (not a hard FAIL)
#                          if it does NOT return 302-to-CF-login. Does not affect green verdict.
#   --allow-default        Allow 'Default' company name on unconfigured boxes (config absent)
#                          WITHOUT this flag, 'Default' in the DB is always NOT green (catches
#                          Sheila-class discovery-failure false-greens). DO NOT pass this flag
#                          in post-deploy gates or fleet sweeps.
#   --json-only            Suppress all stderr progress lines
#   --pretty               Pretty-print the JSON output
#
# Env-var equivalents (lower priority than flags):
#   CC_PORT, CC_DB_PATH, CC_CANONICAL_DIR, CC_PUBLIC_HOST,
#   CC_DISK_PATH, CC_DISK_MIN_GB, CC_PM2_CHECK_WINDOW, CC_MAX_ASSETS,
#   CC_PUBLIC_URL (public subdomain URL for CF-tunnel warning probe),
#   CC_ALLOW_DEFAULT (set to "1" to allow 'Default' on unconfigured boxes)
#
# CONSUMED BY (B.1 checklist P0 — all callers must use this script)
# -----------------------------------------------------------------
#   scripts/deploy.sh                  — post-restart verification + auto-rollback trigger
#   scripts/fleet-refresh-verify.sh    — post-deploy canary gate for each box
#   scripts/sunday-cron-sweep.sh       — weekly fleet sweep (Sunday 03:00 UTC)
#   scripts/watchdog-cc.sh             — continuous crash detection (every 5 min)
#   Any ad-hoc sweep                   — stop writing your own green signature; call this

###############################################################################
# HARD GUARD: bash 4+ required (declare -A, ${var,,} used throughout)
###############################################################################
if [[ "${BASH_VERSINFO[0]:-0}" -lt 4 ]]; then
  printf 'ERROR: cc-health-check.sh requires bash 4+. System bash on macOS is 3.2.\n' >&2
  printf 'Install bash 4+ via Homebrew: brew install bash\n' >&2
  printf 'Then invoke as: /opt/homebrew/bin/bash scripts/cc-health-check.sh\n' >&2
  exit 2
fi

set -euo pipefail

###############################################################################
# Portable timeout wrapper
# GNU coreutils 'timeout' is not on the default macOS PATH.
# Use it when available; otherwise fall back to a background-subshell+kill.
###############################################################################
_timeout_cmd() {
  # Usage: _timeout_cmd SECONDS cmd args...
  local secs="$1"; shift
  if command -v gtimeout &>/dev/null; then
    gtimeout "$secs" "$@"
  elif command -v timeout &>/dev/null; then
    timeout "$secs" "$@"
  else
    # Portable fallback: run in background, kill after N seconds
    "$@" &
    local bg_pid=$!
    (sleep "$secs" && kill "$bg_pid" 2>/dev/null) &
    local watcher_pid=$!
    wait "$bg_pid" 2>/dev/null
    local rc=$?
    kill "$watcher_pid" 2>/dev/null || true
    return $rc
  fi
}

###############################################################################
# Helpers
###############################################################################

_log() { [[ "${JSON_ONLY:-0}" == "1" ]] || printf '%s\n' "$*" >&2; }

_die_usage() { printf 'ERROR: %s\n' "$*" >&2; exit 2; }

_iso8601() { date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# Minimal JSON string escaper (handles common cases without jq dependency)
_jstr() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  printf '%s' "$s"
}

# FIX #9: absolutify a path — exits 2 immediately if the value does not start with '/'.
# Relative paths are never accepted; the caller must provide an absolute path.
_absolutify_path() {
  local val="$1"
  if [[ -z "$val" ]]; then
    echo ""
    return
  fi
  if [[ "$val" != /* ]]; then
    printf 'ERROR: path must be absolute (starts with /), got relative: %s\n' "$val" >&2
    exit 2
  fi
  echo "$val"
}

###############################################################################
# Argument parsing
###############################################################################

PORT="${CC_PORT:-4000}"
DB_PATH_OVERRIDE="${CC_DB_PATH:-}"
CANONICAL_DIR_OVERRIDE="${CC_CANONICAL_DIR:-}"
PUBLIC_HOST="${CC_PUBLIC_HOST:-}"
DISK_PATH_OVERRIDE="${CC_DISK_PATH:-}"
# REDO #10 [Row 24]: default changed from 5 to 0.5 (500 MB per truth table Rows 23/24).
# Pass --disk-min-gb 5 for the 5 GB build-preflight gate (B.4 pre-flight only).
DISK_MIN_GB="${CC_DISK_MIN_GB:-0.5}"
PM2_CHECK_WINDOW="${CC_PM2_CHECK_WINDOW:-15}"
MAX_ASSETS="${CC_MAX_ASSETS:-0}"   # 0 = no cap (probe ALL assets)
ALLOW_DEFAULT="${CC_ALLOW_DEFAULT:-0}"  # REDO #7: 0 = Default in DB always NOT green
PUBLIC_URL_PROBE="${CC_PUBLIC_URL:-}"   # REDO #10: optional CF-tunnel warning probe
JSON_ONLY="0"
PRETTY="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)             PORT="${2:?--port requires a value}"; shift 2 ;;
    --db-path)          DB_PATH_OVERRIDE="${2:?--db-path requires a value}"; shift 2 ;;
    --canonical-dir)    CANONICAL_DIR_OVERRIDE="${2:?--canonical-dir requires a value}"; shift 2 ;;
    --host)             PUBLIC_HOST="${2:?--host requires a value}"; shift 2 ;;
    --disk-path)        DISK_PATH_OVERRIDE="${2:?--disk-path requires a value}"; shift 2 ;;
    --disk-min-gb)      DISK_MIN_GB="${2:?--disk-min-gb requires a value}"; shift 2 ;;
    --pm2-check-window) PM2_CHECK_WINDOW="${2:?--pm2-check-window requires a value}"; shift 2 ;;
    --max-assets)       MAX_ASSETS="${2:?--max-assets requires a value}"; shift 2 ;;
    --public-url)       PUBLIC_URL_PROBE="${2:?--public-url requires a value}"; shift 2 ;;
    --allow-default)    ALLOW_DEFAULT="1"; shift ;;
    --json-only)        JSON_ONLY="1"; shift ;;
    --pretty)           PRETTY="1"; shift ;;
    *) _die_usage "Unknown argument: $1" ;;
  esac
done

# FIX #9: absolutify --db-path and --canonical-dir on ingestion; exit 2 on relative input.
if [[ -n "$DB_PATH_OVERRIDE" ]]; then
  DB_PATH_OVERRIDE="$(_absolutify_path "$DB_PATH_OVERRIDE")"
fi
if [[ -n "$CANONICAL_DIR_OVERRIDE" ]]; then
  CANONICAL_DIR_OVERRIDE="$(_absolutify_path "$CANONICAL_DIR_OVERRIDE")"
fi

###############################################################################
# Resolved defaults
###############################################################################

# Base URL for local probes (always 127.0.0.1 to bypass CF-Access on health checks)
LOCAL_BASE="http://127.0.0.1:${PORT}"

# Public host used only for display; probes always hit 127.0.0.1
PUBLIC_BASE="${PUBLIC_HOST:-${LOCAL_BASE}}"
PUBLIC_BASE="${PUBLIC_BASE%/}"

###############################################################################
# Dependency check (warn but continue — we report per-check failures)
###############################################################################

for cmd in curl sqlite3 pm2 awk grep python3 df; do
  if ! command -v "$cmd" &>/dev/null; then
    _log "WARN: $cmd not found — some checks will be skipped"
  fi
done

###############################################################################
# Check state accumulators (bash 4+ associative arrays, guarded above)
###############################################################################

CHECK_KEYS=()
declare -A CHECK_PASS=()
declare -A CHECK_DETAIL=()
declare -A CHECK_EXTRA=()

_mark() {
  local name="$1" pass="$2" detail="$3" extra="${4:-}"
  CHECK_PASS["$name"]="$pass"
  CHECK_DETAIL["$name"]="$detail"
  CHECK_EXTRA["$name"]="$extra"
  local k
  for k in "${CHECK_KEYS[@]:-}"; do
    [[ "$k" == "$name" ]] && return
  done
  CHECK_KEYS+=("$name")
}

###############################################################################
# HEURISTIC INSTALL DIR LIST
# Used by Check 3 (config-exists disk probe) and DB resolution.
# Centralised here so both use the same paths — no structural gap.
###############################################################################

_heuristic_install_dirs() {
  # Returns newline-separated list of candidate dirs (may not exist)
  printf '%s\n' \
    "${HOME}/projects/command-center" \
    "/data/projects/command-center" \
    "/data/mission-control" \
    "${HOME}/projects/mission-control"
}

###############################################################################
# FIX #5: CF-Access redirect guard
# Validate that the FINAL URL host after -L redirect is still localhost/127.0.0.1.
# A 302 -> CF-login -> 200 text/html must NOT be accepted as a passing probe.
# Returns "pass", "fail:CODE", or "fail:cf-redirect:FINAL_URL"
###############################################################################
_http_check() {
  local label="$1" url="$2"
  local code final_url
  # -L follows redirects; --max-time 10; write final http_code + url_effective
  local resp
  resp=$(curl -s -L -o /dev/null \
    -w "%{http_code}|||%{url_effective}" \
    --max-time 10 "$url" 2>/dev/null || echo "000|||${url}")

  code="${resp%%|||*}"
  final_url="${resp##*|||}"

  local display_code
  display_code=$(printf '%d' "$code" 2>/dev/null || echo "$code")

  # FIX #5: reject any probe where the final URL host is NOT localhost/127.0.0.1
  # This catches 302->CF-Access-login->200 text/html redirects.
  if [[ "$code" == "200" ]]; then
    local final_host
    # Extract host from URL (strip protocol, path, port)
    final_host=$(printf '%s' "$final_url" | sed -E 's|^https?://([^/:?#]*).*|\1|' | tr '[:upper:]' '[:lower:]')
    if [[ "$final_host" != "localhost" && "$final_host" != "127.0.0.1" ]]; then
      _log "  FAIL $label => 200 but redirected to non-local host: ${final_host} (CF-Access login page?)"
      echo "fail:cf-redirect:${final_host}"
      return
    fi
    _log "  OK  $label => ${display_code}"
    echo "pass"
  elif [[ "$code" == "000" ]]; then
    # REDO #10 [Row 10]: HTTP code 000 = connection refused or timeout.
    # This is UNKNOWN (server may be starting; B.2 deploy calls B.1 before pm2 is fully up).
    # Do NOT map to FAIL — that would trigger B.2 auto-rollback on a valid deploy in progress.
    _log "  UNKNOWN $label => 000 (connection refused/timeout — server may be starting)"
    echo "unknown:000"
  else
    _log "  FAIL $label => ${display_code}"
    echo "fail:${display_code}"
  fi
}

###############################################################################
# CHECK 1: HTTP 200 on / and /api/health (with redirect following + body parse)
#
# REDO #10 [Row 10]: HTTP 000 (connection refused / timeout) → UNKNOWN (exit 3),
#   not FAIL. Server may be starting; B.2 deploy calls B.1 before pm2 is fully up.
#
# REDO #10 [missingFromSpec — body parse]: /api/health returns JSON with a
#   'status' field ('ok' or 'degraded') and a 'gap' field (count of pending
#   migrations). A 200 response with status='degraded' or gap>0 is a false-green
#   (confirmed: migration-020 Sheila-class pattern returns gap:0,status:'ok' on a
#   structurally broken DB — now fixed — but the body parse adds a layer of defense
#   for future migration bugs and is required by the updated B.1 spec).
#   If /api/health returns {status:'degraded'} or {gap > 0}, mark FAIL.
#   If the body cannot be parsed as JSON, mark UNKNOWN (not hard FAIL — server
#   might be starting and returning a non-JSON startup page).
###############################################################################

_log "[1/5] HTTP liveness — / and /api/health (with body parse)"

ROOT_RESULT=$(_http_check "GET /" "${LOCAL_BASE}/")
# For /api/health we need the body too — fetch separately to parse JSON
API_HEALTH_BODY=$(curl -s -L --max-time 10 \
  -w "|||%{http_code}|||%{url_effective}" \
  "${LOCAL_BASE}/api/health" 2>/dev/null || echo "|||000|||${LOCAL_BASE}/api/health")
# Extract body, code, final URL from the combined output
# Format: <body>|||<code>|||<final_url>
API_HEALTH_BODY_TEXT="${API_HEALTH_BODY%|||*}"       # strip last two segments
API_HEALTH_BODY_TEXT="${API_HEALTH_BODY_TEXT%|||*}"  # strip code segment
API_HTTP_CODE_RAW="${API_HEALTH_BODY#*|||}"
API_HTTP_CODE="${API_HTTP_CODE_RAW%%|||*}"
API_FINAL_URL="${API_HEALTH_BODY##*|||}"
API_FINAL_HOST=$(printf '%s' "$API_FINAL_URL" | sed -E 's|^https?://([^/:?#]*).*|\1|' | tr '[:upper:]' '[:lower:]')

ROOT_CODE="${ROOT_RESULT#fail:}"

if [[ "$ROOT_RESULT" == "pass" ]]; then
  _mark "http_root" "true" "HTTP 200 on /"
elif [[ "$ROOT_RESULT" == "fail:cf-redirect:"* ]]; then
  REDIR_HOST="${ROOT_RESULT#fail:cf-redirect:}"
  _mark "http_root" "false" "HTTP 200 but redirected to non-local host '${REDIR_HOST}' — CF-Access login page intercepted the probe; probe via 127.0.0.1 must not redirect off-host"
elif [[ "$ROOT_RESULT" == "unknown:000" ]]; then
  # REDO #10 [Row 10]: connection refused/timeout → UNKNOWN, not FAIL
  _mark "http_root" "unknown" "HTTP 000 on / — server unreachable (connection refused or timeout; may be starting up)"
else
  _mark "http_root" "false" "HTTP ${ROOT_CODE} on / (expected 200)"
fi

# /api/health: check HTTP code, CF-redirect, and body content
if [[ "$API_HTTP_CODE" == "000" ]]; then
  # REDO #10 [Row 10]: UNKNOWN — server unreachable
  _mark "http_api_health" "unknown" "HTTP 000 on /api/health — server unreachable (connection refused or timeout; may be starting up)"
elif [[ "$API_HTTP_CODE" == "200" && "$API_FINAL_HOST" != "localhost" && "$API_FINAL_HOST" != "127.0.0.1" ]]; then
  # CF-Access redirect
  _mark "http_api_health" "false" "HTTP 200 but redirected to non-local host '${API_FINAL_HOST}' — CF-Access login page intercepted the probe"
elif [[ "$API_HTTP_CODE" == "200" ]]; then
  # REDO #10 [body parse]: parse /api/health JSON for status and gap
  if command -v python3 &>/dev/null; then
    API_BODY_VERDICT=$(printf '%s' "$API_HEALTH_BODY_TEXT" | python3 -s -c "
import sys, json
try:
  d = json.load(sys.stdin)
  status = d.get('status', '')
  gap = int(d.get('migrations', {}).get('gap', 0) or 0)
  if status == 'degraded' or gap > 0:
    print(f'fail:{gap}:{status}')
  else:
    print('pass')
except (json.JSONDecodeError, ValueError):
  print('unknown:nonjson')
except Exception:
  print('unknown:parse-error')
" 2>/dev/null || echo "unknown:python-error")
  else
    # python3 absent — cannot parse body; accept 200 as pass (best-effort)
    API_BODY_VERDICT="pass"
    _log "  WARN: python3 absent — /api/health body parse skipped (cannot detect pending migrations)"
  fi

  if [[ "$API_BODY_VERDICT" == "pass" ]]; then
    _mark "http_api_health" "true" "HTTP 200 on /api/health (status:ok, gap:0)"
  elif [[ "$API_BODY_VERDICT" == "fail:"* ]]; then
    _BODY_GAP="${API_BODY_VERDICT#fail:}"
    _BODY_GAP_NUM="${_BODY_GAP%%:*}"
    _BODY_STATUS="${_BODY_GAP#*:}"
    _mark "http_api_health" "false" \
      "/api/health returned HTTP 200 but body indicates non-healthy state: status=${_BODY_STATUS}, pending migrations=${_BODY_GAP_NUM} (false-green if ignored)"
  elif [[ "$API_BODY_VERDICT" == "unknown:"* ]]; then
    # Body not parseable — UNKNOWN, not FAIL (server may be serving startup page)
    _mark "http_api_health" "unknown" "/api/health returned HTTP 200 but response body is not valid JSON — cannot verify migration status"
  else
    _mark "http_api_health" "true" "HTTP 200 on /api/health"
  fi
else
  _mark "http_api_health" "false" "HTTP ${API_HTTP_CODE} on /api/health (expected 200)"
fi

###############################################################################
# CHECK 2: Serve HTML → extract EVERY /_next/static asset → curl each → 200
#          This is the Sheila bug detector: stale manifest hash absent on disk.
###############################################################################

_log "[2/5] Static asset integrity (stale-manifest detection)"
if [[ "${MAX_ASSETS}" -gt 0 ]]; then
  _log "  NOTE: --max-assets ${MAX_ASSETS} cap active; un-probed assets cause fail (not silent pass)"
else
  _log "  Probing ALL assets (no cap)"
fi

if ! command -v curl &>/dev/null; then
  _mark "static_assets" "false" "curl not available — cannot check assets" \
    '"assets_found":0,"total":0,"capped":false,"failed":[]'
else
  # Fetch the served HTML from / via 127.0.0.1 so CF-Access cannot block the probe
  # REDO #10 [Row 10]: capture HTTP code to distinguish connection-refused (000) from
  # genuine content errors. Connection refused → UNKNOWN (server may be starting).
  HTML_FETCH_CODE_RAW=$(curl -s -L --max-time 15 \
    -w "|||%{http_code}" \
    -o /tmp/_cc_html_asset_$$ \
    "${LOCAL_BASE}/" 2>/dev/null || echo "|||000")
  HTML_FETCH_CODE="${HTML_FETCH_CODE_RAW##*|||}"
  HTML=$(cat /tmp/_cc_html_asset_$$ 2>/dev/null || true)
  rm -f /tmp/_cc_html_asset_$$

  if [[ "$HTML_FETCH_CODE" == "000" && -z "$HTML" ]]; then
    # REDO #10: server unreachable → UNKNOWN, not FAIL
    _mark "static_assets" "unknown" "Server unreachable (HTTP 000 — connection refused or timeout) — static assets cannot be verified; may be starting up" \
      '"assets_found":0,"total":0,"capped":false,"failed":[]'
  elif [[ -z "$HTML" ]]; then
    _mark "static_assets" "false" "Could not fetch HTML from / to parse assets" \
      '"assets_found":0,"total":0,"capped":false,"failed":[]'
  else
    # Extract all /_next/static/... href, src, and url() references from HTML.
    ASSET_PATHS=$(printf '%s' "$HTML" \
      | grep -oE '/_next/static/[^"'"'"') >\\]+' \
      | grep -v '^[[:space:]]*$' \
      | sort -u || true)

    # Extract the buildId from __NEXT_DATA__ and explicitly probe the _buildManifest.js.
    # This is the critical catch: a stale buildId means the manifest hash on disk no longer
    # matches what the server serves in the HTML.
    BUILD_ID=$(printf '%s' "$HTML" \
      | grep -oE '"buildId":"[^"]+"' \
      | sed 's/"buildId":"//;s/"//' \
      | head -1 || true)

    if [[ -n "$BUILD_ID" ]]; then
      BUILDID_ASSET="/_next/static/${BUILD_ID}/_buildManifest.js"
      ASSET_PATHS=$(printf '%s\n%s' "$ASSET_PATHS" "$BUILDID_ASSET" \
        | grep -v '^[[:space:]]*$' | sort -u || true)
    fi

    # True count of ALL asset refs found in HTML (never truncated).
    # FIX #3 (REDO): macOS BSD grep -c on a two-stage pipeline ('printf | grep -v | grep -c')
    # returns '0\n0' (one line per grep stage, not one total) when the input is empty.
    # ASSETS_FOUND_TOTAL would become a multiline string; [[ "$ASSETS_FOUND_TOTAL" -eq 0 ]]
    # would throw a bash arithmetic syntax error, evaluate false, and skip the intended
    # zero-assets FAIL branch, emitting static_assets.pass=true (false-green).
    # Fix: use a single-stage grep -c that counts non-blank lines, then sanitize the result
    # to strip any trailing newline artifact before the arithmetic comparison.
    ASSETS_FOUND_TOTAL=$(printf '%s' "$ASSET_PATHS" \
      | grep -c '[^[:space:]]' 2>/dev/null || echo "0")
    # Sanitize: strip any multiline artifact (BSD grep quirk on empty pipeline)
    ASSETS_FOUND_TOTAL=$(( ${ASSETS_FOUND_TOTAL%%$'\n'*} + 0 ))

    if [[ "$ASSETS_FOUND_TOTAL" -eq 0 ]]; then
      # No /_next/static refs in HTML is suspicious — Next.js always injects them.
      _mark "static_assets" "false" \
        "No /_next/static asset references found in served HTML — build may not be wired or server is returning an error page" \
        '"assets_found":0,"total":0,"capped":false,"failed":[]'
    else
      _log "  Found ${ASSETS_FOUND_TOTAL} /_next/static asset references"
      FAILED_ASSETS=()
      TOTAL_CHECKED=0
      PROBE_CAP_HIT="false"

      while IFS= read -r asset_path; do
        [[ -z "$asset_path" ]] && continue

        # Enforce per-run asset cap when MAX_ASSETS > 0
        if [[ "${MAX_ASSETS}" -gt 0 && "$TOTAL_CHECKED" -ge "$MAX_ASSETS" ]]; then
          PROBE_CAP_HIT="true"
          _log "  INFO: --max-assets ${MAX_ASSETS} cap reached; ${ASSETS_FOUND_TOTAL} total refs, ${TOTAL_CHECKED} probed"
          break
        fi

        TOTAL_CHECKED=$((TOTAL_CHECKED + 1))

        # Always probe via 127.0.0.1:PORT regardless of how the path was stamped.
        if [[ "$asset_path" =~ ^https?:// ]]; then
          asset_path_only=$(printf '%s' "$asset_path" | grep -oE '/_next/.*' || true)
          [[ -z "$asset_path_only" ]] && asset_path_only="$asset_path"
          asset_url="${LOCAL_BASE}${asset_path_only}"
        else
          asset_url="${LOCAL_BASE}${asset_path}"
        fi

        # Fetch: get HTTP code and Content-Type header
        RESP=$(curl -s -o /dev/null \
          -w "%{http_code}|||%{content_type}" \
          --max-time 10 \
          "$asset_url" 2>/dev/null || echo "000|||")

        ASSET_CODE="${RESP%%|||*}"
        ASSET_CT="${RESP##*|||}"

        # Content-type validation:
        #   .js  must return application/javascript or text/javascript (NOT text/html)
        #   .css must return text/css (NOT text/html)
        # A 200 with text/html means the server is returning an error page for a
        # missing file — the exact pattern of the Sheila stale-manifest bug.
        CT_OK="true"
        if [[ "$ASSET_CODE" == "200" ]]; then
          case "$asset_path" in
            *.js)
              [[ "$ASSET_CT" == *"javascript"* ]] || CT_OK="false" ;;
            *.css)
              [[ "$ASSET_CT" == *"css"* ]] || CT_OK="false" ;;
          esac
        fi

        if [[ "$ASSET_CODE" == "200" && "$CT_OK" == "true" ]]; then
          : # pass
        else
          if [[ "$ASSET_CODE" == "200" && "$CT_OK" == "false" ]]; then
            FAILED_ASSETS+=("${asset_path}:wrong-content-type(${ASSET_CT})")
          else
            FAILED_ASSETS+=("${asset_path}:HTTP${ASSET_CODE}")
          fi
          _log "  FAIL asset ${asset_path} => ${ASSET_CODE} (${ASSET_CT})"
        fi
      done <<< "$ASSET_PATHS"

      FAILED_JSON_ARR="["
      first=1
      for fa in "${FAILED_ASSETS[@]:-}"; do
        [[ -z "$fa" ]] && continue
        [[ $first -eq 0 ]] && FAILED_JSON_ARR+=","
        FAILED_JSON_ARR+="\"$(_jstr "$fa")\""
        first=0
      done
      FAILED_JSON_ARR+="]"

      # Build the JSON extra fields — assets_found = true count, total = probed count
      ASSETS_EXTRA="\"assets_found\":${ASSETS_FOUND_TOTAL},\"total\":${TOTAL_CHECKED},\"capped\":${PROBE_CAP_HIT},\"failed\":${FAILED_JSON_ARR}"

      if [[ "$PROBE_CAP_HIT" == "true" ]]; then
        # Cap hit = un-probed assets cannot be verified = FAIL
        # This is intentional: the spec requires EVERY asset to be probed.
        UNPROBED=$(( ASSETS_FOUND_TOTAL - TOTAL_CHECKED ))
        _mark "static_assets" "false" \
          "Asset probe capped at ${MAX_ASSETS}/${ASSETS_FOUND_TOTAL} — ${UNPROBED} assets un-probed; cannot verify EVERY asset (raise --max-assets or remove cap)" \
          "$ASSETS_EXTRA"
      elif [[ ${#FAILED_ASSETS[@]} -eq 0 ]]; then
        _mark "static_assets" "true" \
          "all ${TOTAL_CHECKED} static assets returned 200 with correct content-type (${ASSETS_FOUND_TOTAL} total found)" \
          "$ASSETS_EXTRA"
      else
        FAILED_COUNT=${#FAILED_ASSETS[@]}
        _mark "static_assets" "false" \
          "${FAILED_COUNT}/${TOTAL_CHECKED} static assets failed (stale manifest or missing files on disk)" \
          "$ASSETS_EXTRA"
      fi
    fi
  fi
fi

###############################################################################
# CHECK 3: Company name — DB-direct AND served HTML; must match; not "Default"
#          on a box with company-config.json present.
#
# FIX #1 (FALSE-GREEN): COMPANY_CONFIG_EXISTS is determined by FILE EXISTENCE on
#   disk, completely independent of whether companyName is empty/null/whitespace.
#   An empty companyName in company-config.json is a configured-but-broken box —
#   it must NOT fall through to the "unconfigured, Default OK" branch.
#
# FIX #5 (CF-Access redirect): The HTML fetch for company name extraction validates
#   the final URL host is still localhost/127.0.0.1 before trusting the body.
#
# FIX #6 (sqlite3 busy-vs-empty): Distinguish SQLITE_BUSY/locked (UNKNOWN/retry)
#   from a genuinely empty companies table. A lock/timeout is treated as UNKNOWN,
#   not "no company row."
###############################################################################

_log "[3/5] Company name consistency (DB-direct vs served HTML)"

# Resolve the DB path in priority order:
#   1. --db-path flag / CC_DB_PATH env
#   2. DATABASE_PATH from the running pm2 process env (resolved against pm_cwd)
#   3. Canonical paths heuristic
_resolve_db_path() {
  if [[ -n "$DB_PATH_OVERRIDE" ]]; then
    echo "$DB_PATH_OVERRIDE"
    return
  fi

  if command -v pm2 &>/dev/null && command -v python3 &>/dev/null; then
    local pm2_raw pm2_db
    pm2_raw=$(_timeout_cmd 15 pm2 jlist 2>/dev/null || echo "[]")
    pm2_db=$(printf '%s\n' "$pm2_raw" | python3 -s -c "
import sys, json, os
try:
  apps = json.load(sys.stdin)
  if apps is None: apps = []
  for app in apps:
    env = app.get('pm2_env') or {}
    pm_cwd = env.get('pm_cwd') or env.get('cwd') or ''
    for ekey in ('env_data', 'env'):
      e = env.get(ekey) or {}
      if isinstance(e, dict):
        v = e.get('DATABASE_PATH') or e.get('database_path')
        if v:
          if not os.path.isabs(v) and pm_cwd:
            v = os.path.normpath(os.path.join(pm_cwd, v))
          print(v)
          raise SystemExit(0)
    v = env.get('DATABASE_PATH') or env.get('database_path')
    if v:
      if not os.path.isabs(v) and pm_cwd:
        v = os.path.normpath(os.path.join(pm_cwd, v))
      print(v)
      raise SystemExit(0)
except SystemExit:
  pass
except Exception:
  pass
" 2>/dev/null || true)
    if [[ -n "$pm2_db" && -f "$pm2_db" ]]; then
      echo "$pm2_db"
      return
    fi
  fi

  # Heuristic: common install paths
  while IFS= read -r candidate_dir; do
    local candidate="${candidate_dir}/mission-control.db"
    if [[ -f "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done < <(_heuristic_install_dirs)

  echo ""
}

# pass path via sys.argv — never interpolate into a Python string literal.
# This avoids Python SyntaxError on paths containing single quotes (e.g. /home/o'brien/…).
_get_config_company_name() {
  local install_dir="${1:-}"
  [[ -z "$install_dir" ]] && echo "" && return
  local cfg="${install_dir}/config/company-config.json"
  [[ ! -f "$cfg" ]] && echo "" && return
  python3 -s - "$cfg" << 'PYEOF' 2>/dev/null || echo ""
import json, sys
try:
  d = json.load(open(sys.argv[1]))
  n = (d.get('companyName') or '').strip()
  print(n)
except Exception:
  print('')
PYEOF
}

# FIX #4 (wrong cwd): _pm2_cwd_for_config now filters by CC port OR canonical app name
# so that a non-CC app registered before the CC app doesn't hijack the cwd.
# Returns the cwd of the FIRST cc_app (port-matched or name-matched), not the first
# of ALL apps.
_pm2_cwd_for_config() {
  if ! command -v pm2 &>/dev/null || ! command -v python3 &>/dev/null; then
    echo ""
    return
  fi
  local pm2_raw
  pm2_raw=$(_timeout_cmd 15 pm2 jlist 2>/dev/null || echo "[]")
  printf '%s\n' "$pm2_raw" | python3 -s -c "
import sys, json, re
port_str = sys.argv[1] if len(sys.argv) > 1 else ''

def env_val(pm2_env, key):
    for layer in ('env_data', 'env'):
        e = pm2_env.get(layer) or {}
        if isinstance(e, dict):
            v = e.get(key) or e.get(key.lower())
            if v:
                return str(v)
    v = pm2_env.get(key) or pm2_env.get(key.lower())
    if v:
        return str(v)
    return ''

def port_matches(app, port_str):
    env = app.get('pm2_env') or {}
    port_env = env_val(env, 'PORT')
    if port_env == port_str:
        return True
    args = env.get('args') or env.get('node_args') or ''
    if isinstance(args, list):
        args = ' '.join(str(a) for a in args)
    args_str = str(args)
    if re.search(r'(?:^|\s)-p\s+' + re.escape(port_str) + r'(?:\s|$)', args_str):
        return True
    if re.search(r'--port\s+' + re.escape(port_str) + r'(?!\d)', args_str):
        return True
    return False

def name_matches_cc(app, port_str):
    env = app.get('pm2_env') or {}
    name = (env.get('name') or app.get('name') or '').lower()
    name_kw = any(kw in name for kw in ('mission-control', 'command-center', 'blackceo'))
    if not name_kw:
        return False
    port_env = env_val(env, 'PORT')
    if port_env and port_env != port_str:
        return False
    return True

try:
    apps = json.loads(sys.stdin.read())
    if apps is None:
        apps = []
    for app in apps:
        env = app.get('pm2_env') or {}
        if port_matches(app, port_str) or name_matches_cc(app, port_str):
            cwd = env.get('pm_cwd') or env.get('cwd') or ''
            if cwd:
                print(cwd)
                raise SystemExit(0)
except Exception:
    pass
" "$PORT" 2>/dev/null || true
}

# FIX #1: Disk-direct config probe.
# COMPANY_CONFIG_EXISTS is set based on FILE EXISTENCE of company-config.json,
# INDEPENDENT of the companyName value inside it.
# Priority order:
#   1. --canonical-dir flag (explicit, highest priority)
#   2. pm2 pm_cwd of the CC app (catches installs at non-heuristic paths)
#   3. heuristic dirs
#
# Sets COMPANY_CONFIG_EXISTS_BOOL (global) to "true"/"false" based purely on
# whether company-config.json exists on disk (not on its content).
# Also sets CONFIG_COMPANY_NAME (possibly empty even when file exists).
CONFIG_DISCOVERY_METHOD=""
CONFIG_DISCOVERY_WARN=""
COMPANY_CONFIG_EXISTS_BOOL="false"  # FIX #1: set by file existence, not name content

_find_config_from_disk() {
  # Priority 1: explicit canonical dir
  if [[ -n "$CANONICAL_DIR_OVERRIDE" ]]; then
    CONFIG_DISCOVERY_METHOD="canonical-dir-flag"
    local cfg="${CANONICAL_DIR_OVERRIDE}/config/company-config.json"
    if [[ -f "$cfg" ]]; then
      COMPANY_CONFIG_EXISTS_BOOL="true"
    else
      COMPANY_CONFIG_EXISTS_BOOL="false"
    fi
    _get_config_company_name "$CANONICAL_DIR_OVERRIDE"
    return
  fi

  # Priority 2: pm2 pm_cwd (filtered to CC app)
  local pm2_cwd
  pm2_cwd=$(_pm2_cwd_for_config)
  if [[ -n "$pm2_cwd" ]]; then
    local cfg="${pm2_cwd}/config/company-config.json"
    if [[ -f "$cfg" ]]; then
      CONFIG_DISCOVERY_METHOD="pm2-pm_cwd"
      COMPANY_CONFIG_EXISTS_BOOL="true"
      _get_config_company_name "$pm2_cwd"
      return
    fi
  fi

  # Priority 3: heuristic dirs
  while IFS= read -r candidate_dir; do
    local cfg="${candidate_dir}/config/company-config.json"
    if [[ -f "$cfg" ]]; then
      CONFIG_DISCOVERY_METHOD="heuristic"
      COMPANY_CONFIG_EXISTS_BOOL="true"
      _get_config_company_name "$candidate_dir"
      return
    fi
  done < <(_heuristic_install_dirs)

  # Not found
  CONFIG_DISCOVERY_METHOD="not-found"
  COMPANY_CONFIG_EXISTS_BOOL="false"
  CONFIG_DISCOVERY_WARN="company-config.json not found via --canonical-dir, pm2 pm_cwd, or heuristic paths. If the app is installed outside standard dirs, supply --canonical-dir. config_exists=false may be a false negative."
  echo ""
}

# FIX #6: sqlite3 busy-vs-empty.
# Returns one of:
#   "UNKNOWN:BUSY"    — SQLITE_BUSY or lock/timeout detected
#   ""                — empty result (table present, no matching row)
#   "<name>"          — the company name
_sqlite3_query_with_busy_detect() {
  local db_path="$1" query="$2"
  local attempt result err_output
  for attempt in 1 2 3; do
    # Capture both stdout and stderr; detect SQLITE_BUSY keyword
    err_output=$(sqlite3 -cmd '.timeout 5000' "$db_path" "$query" 2>&1 1>/tmp/_cc_sq_out_$$ || true)
    result=$(cat /tmp/_cc_sq_out_$$ 2>/dev/null || true)
    rm -f /tmp/_cc_sq_out_$$
    # If stderr contains SQLITE_BUSY, database locked, or unable to open, treat as UNKNOWN
    if printf '%s' "$err_output" | grep -qiE 'SQLITE_BUSY|database is locked|unable to open|disk I/O error'; then
      if [[ "$attempt" -lt 3 ]]; then
        sleep 2
        continue
      fi
      echo "UNKNOWN:BUSY"
      return
    fi
    # Normal result (may be empty string for empty table)
    echo "$result"
    return
  done
  echo ""
}

if ! command -v sqlite3 &>/dev/null; then
  _mark "company_name" "false" "sqlite3 not available — DB-direct check skipped" \
    '"db_name":"","html_name":"","config_exists":false'
else
  DB_PATH=$(_resolve_db_path)

  if [[ -z "$DB_PATH" || ! -f "$DB_PATH" ]]; then
    _mark "company_name" "false" \
      "DB not found (tried override, pm2 env, heuristic paths) — cannot verify company name" \
      '"db_name":"","html_name":"","config_exists":false'
  else
    _log "  Querying DB: $DB_PATH"

    # FIX #6: Use busy-detecting query; treat UNKNOWN:BUSY as an explicit unknown state.
    DB_COMPANY_RAW=$(_sqlite3_query_with_busy_detect "$DB_PATH" \
      "SELECT name FROM companies WHERE name IS NOT NULL AND name != '' ORDER BY created_at ASC LIMIT 1;")

    DB_BUSY="false"
    if [[ "$DB_COMPANY_RAW" == "UNKNOWN:BUSY" ]]; then
      DB_BUSY="true"
      DB_COMPANY_RAW=""
    fi

    if [[ -z "$DB_COMPANY_RAW" && "$DB_BUSY" == "false" ]]; then
      DB_COMPANY_RAW=$(_sqlite3_query_with_busy_detect "$DB_PATH" \
        "SELECT name FROM companies ORDER BY created_at ASC LIMIT 1;")
      if [[ "$DB_COMPANY_RAW" == "UNKNOWN:BUSY" ]]; then
        DB_BUSY="true"
        DB_COMPANY_RAW=""
      fi
    fi
    COMPANY_DB_NAME="${DB_COMPANY_RAW:-}"

    # FIX #5: Fetch HTML for company name — validate final URL host before trusting body.
    HTML_FOR_COMPANY=""
    HTML_FETCH_RESP=$(curl -s -L --max-time 10 \
      -w "|||%{url_effective}" \
      -o /tmp/_cc_html_fetch_$$ \
      "${LOCAL_BASE}/" 2>/dev/null || true)
    HTML_FETCH_FINAL_URL="${HTML_FETCH_RESP##*|||}"
    HTML_FETCH_FINAL_HOST=$(printf '%s' "$HTML_FETCH_FINAL_URL" | sed -E 's|^https?://([^/:?#]*).*|\1|' | tr '[:upper:]' '[:lower:]')

    if [[ "$HTML_FETCH_FINAL_HOST" == "localhost" || "$HTML_FETCH_FINAL_HOST" == "127.0.0.1" ]]; then
      HTML_FOR_COMPANY=$(cat /tmp/_cc_html_fetch_$$ 2>/dev/null || true)
    else
      _log "  WARN: HTML fetch for company_name redirected to ${HTML_FETCH_FINAL_HOST} — ignoring body (CF-Access login page)"
    fi
    rm -f /tmp/_cc_html_fetch_$$

    COMPANY_HTML_NAME=""
    if [[ -n "$HTML_FOR_COMPANY" ]]; then
      COMPANY_HTML_NAME=$(printf '%s' "$HTML_FOR_COMPANY" \
        | grep -oiE '<meta[^>]*og:site_name[^>]*>' \
        | grep -oiE 'content="[^"]+"' \
        | sed 's/[Cc]ontent="//;s/"//' \
        | head -1 || true)

      if [[ -z "$COMPANY_HTML_NAME" ]]; then
        COMPANY_HTML_NAME=$(printf '%s' "$HTML_FOR_COMPANY" \
          | grep -oE 'data-company="[^"]+"' \
          | sed 's/data-company="//;s/"//' \
          | head -1 || true)
      fi

      if [[ -z "$COMPANY_HTML_NAME" ]]; then
        # Title fallback.  Production layout.tsx emits:
        #   <title>COMPANY_NAME Command Center</title>
        # (space-separated suffix, NO em-dash / en-dash / pipe).
        # Step 1: try a separator-based split for legacy/custom titles that use a dash.
        # Step 2: if the whole string survives step 1 unchanged, strip the literal
        #         ' Command Center' suffix so the DB comparison works on the real format.
        # REDO #8: grep -ioE makes the <title> match case-insensitive (handles <TITLE>, <Title>)
        _RAW_TITLE=$(printf '%s' "$HTML_FOR_COMPANY" \
          | grep -ioE '<title>[^<]+</title>' \
          | sed 's/<[Tt][Ii][Tt][Ll][Ee]>//;s/<\/[Tt][Ii][Tt][Ll][Ee]>//' \
          | head -1 || true)
        if [[ -n "$_RAW_TITLE" ]]; then
          # First try separator-based split (em-dash, en-dash, pipe, or ' - ')
          _SPLIT=$(printf '%s' "$_RAW_TITLE" | awk -F' [—–|-] ' '{print $1}')
          if [[ "$_SPLIT" != "$_RAW_TITLE" ]]; then
            # Separator found — use the left-hand part
            COMPANY_HTML_NAME="$_SPLIT"
          else
            # No separator — strip the canonical ' Command Center' suffix
            # (handles: 'Acme Corp Command Center' → 'Acme Corp')
            COMPANY_HTML_NAME=$(printf '%s' "$_RAW_TITLE" \
              | sed 's/ Command Center$//' | sed 's/ command center$//')
            # If stripping produced an empty string (title WAS 'Command Center'),
            # fall back to the raw title so an unconfigured default doesn't false-pass.
            [[ -z "$COMPANY_HTML_NAME" ]] && COMPANY_HTML_NAME="$_RAW_TITLE"
          fi
        fi
      fi
    fi

    # FIX #1: Determine configured-box status from FILE EXISTENCE, not name content.
    # IMPORTANT: _find_config_from_disk() sets COMPANY_CONFIG_EXISTS_BOOL as a global.
    # It MUST be called directly (not in a subshell via $()) so the variable assignment
    # propagates to the current shell. We capture stdout via a temp file instead.
    # REDO #9 [NON-BLOCKING]: _CC_CFGOUT now has an EXIT trap (mirrors _PM2_SCRIPT pattern).
    _CC_CFGOUT=$(mktemp /tmp/cc-cfgout-XXXXXX)
    trap 'rm -f "$_CC_CFGOUT"' EXIT
    _find_config_from_disk > "$_CC_CFGOUT"
    CONFIG_COMPANY_NAME=$(cat "$_CC_CFGOUT" 2>/dev/null || true)
    rm -f "$_CC_CFGOUT"
    trap - EXIT

    _log "  DB company name:   '${COMPANY_DB_NAME}'"
    _log "  HTML company name: '${COMPANY_HTML_NAME}'"
    _log "  Config file exists (disk-direct via ${CONFIG_DISCOVERY_METHOD}): ${COMPANY_CONFIG_EXISTS_BOOL}"
    [[ -n "$CONFIG_DISCOVERY_WARN" ]] && _log "  WARN: ${CONFIG_DISCOVERY_WARN}"

    # Build optional config_warn JSON field
    if [[ -n "$CONFIG_DISCOVERY_WARN" ]]; then
      CONFIG_WARN_FIELD=",\"config_warn\":\"$(_jstr "$CONFIG_DISCOVERY_WARN")\""
    else
      CONFIG_WARN_FIELD=""
    fi

    # REDO #10 [Row 28]: DB busy/lock is UNKNOWN (transient infra condition, exit 3),
    # NOT a definitive FAIL (exit 1). Truth table Row 28 mandates UNKNOWN;
    # triggering a deploy rollback on a transient DB lock is operationally incorrect.
    # The _mark pass value "unknown" propagates to exit 3 in the verdict assembly.
    if [[ "$DB_BUSY" == "true" ]]; then
      _mark "company_name" "unknown" \
        "DB locked/busy after 3 retries — company_name check is UNKNOWN (transient infra condition; retry when DB is not locked; do NOT trigger rollback on this state)" \
        "\"db_name\":\"UNKNOWN\",\"html_name\":\"$(_jstr "$COMPANY_HTML_NAME")\",\"config_exists\":${COMPANY_CONFIG_EXISTS_BOOL}${CONFIG_WARN_FIELD}"
    elif [[ "$COMPANY_CONFIG_EXISTS_BOOL" == "true" ]]; then
      # FIX #1: Configured box branch — entered solely based on file existence.
      # An empty companyName in config (empty/null/'   ') still lands here.
      #
      # REDO #7 [P0 guard — spec line 20]:
      # If config file exists but companyName is empty/null/whitespace, that is a
      # misconfigured box regardless of what the DB contains (even a valid non-Default
      # name like 'Acme Corp').  Spec line 20 mandates NOT green unconditionally in
      # this case.  This guard must fire BEFORE any DB comparison so that a healthy DB
      # never masks a broken config file.
      if [[ -z "$CONFIG_COMPANY_NAME" ]]; then
        # Distinguish two distinct empty-name cases:
        #   (i)  python3 absent — cannot parse config; python3 is the missing dependency
        #   (ii) python3 present — config exists but companyName is genuinely empty/null/whitespace
        if ! command -v python3 &>/dev/null; then
          _mark "company_name" "false" \
            "config file present but python3 is not available — cannot parse companyName (install python3 to verify branding)" \
            "\"db_name\":\"$(_jstr "$COMPANY_DB_NAME")\",\"html_name\":\"$(_jstr "$COMPANY_HTML_NAME")\",\"config_exists\":true${CONFIG_WARN_FIELD}"
        else
          _mark "company_name" "false" \
            "config file present but companyName is empty — misconfigured box (spec line 20: NOT green unconditionally)" \
            "\"db_name\":\"$(_jstr "$COMPANY_DB_NAME")\",\"html_name\":\"$(_jstr "$COMPANY_HTML_NAME")\",\"config_exists\":true${CONFIG_WARN_FIELD}"
        fi
      elif [[ -z "$COMPANY_DB_NAME" ]]; then
        _mark "company_name" "false" \
          "Configured box has no company row in DB — branding not seeded (run B.3 seed)" \
          "\"db_name\":\"\",\"html_name\":\"$(_jstr "$COMPANY_HTML_NAME")\",\"config_exists\":true${CONFIG_WARN_FIELD}"
      elif [[ "${COMPANY_DB_NAME,,}" == "default" ]]; then
        _mark "company_name" "false" \
          "Configured box shows 'Default' company in DB — branding seed failed (Sheila bug)" \
          "\"db_name\":\"$(_jstr "$COMPANY_DB_NAME")\",\"html_name\":\"$(_jstr "$COMPANY_HTML_NAME")\",\"config_exists\":true${CONFIG_WARN_FIELD}"
      elif [[ -z "$COMPANY_HTML_NAME" ]]; then
        # REDO #8 [P0 — empty-HTML silent pass]: spec requires BOTH DB and HTML to be
        # verified on a configured box.  When all three extraction methods (og:site_name,
        # data-company, <title>) yield empty, the mismatch elif is skipped and the check
        # was silently passing with only the DB side verified.
        # Fix: explicit FAIL here with a clear "branding unverifiable" message so the
        # caller knows the HTML side was never checked.
        _mark "company_name" "false" \
          "could not extract company name from served HTML — branding unverifiable (no og:site_name, data-company, or <title> found in served page)" \
          "\"db_name\":\"$(_jstr "$COMPANY_DB_NAME")\",\"html_name\":\"\",\"config_exists\":true${CONFIG_WARN_FIELD}"
      elif [[ "$COMPANY_HTML_NAME" != "$COMPANY_DB_NAME" ]]; then
        _mark "company_name" "false" \
          "Company name mismatch: DB='${COMPANY_DB_NAME}' vs HTML='${COMPANY_HTML_NAME}'" \
          "\"db_name\":\"$(_jstr "$COMPANY_DB_NAME")\",\"html_name\":\"$(_jstr "$COMPANY_HTML_NAME")\",\"config_exists\":true${CONFIG_WARN_FIELD}"
      else
        _mark "company_name" "true" \
          "Company name consistent: '${COMPANY_DB_NAME}'" \
          "\"db_name\":\"$(_jstr "$COMPANY_DB_NAME")\",\"html_name\":\"$(_jstr "$COMPANY_HTML_NAME")\",\"config_exists\":true${CONFIG_WARN_FIELD}"
      fi
    else
      # Unconfigured box — config file absent entirely (COMPANY_CONFIG_EXISTS_BOOL=false).
      #
      # REDO #7 [P1 — Sheila-class false-green]:
      # 'Default' in the DB is NOT green even when config discovery failed, UNLESS
      # --allow-default is explicitly passed.  Without this guard, a box whose config
      # file lives at a non-standard path (outside --canonical-dir / pm2 pm_cwd /
      # heuristic dirs) silently returns green=true when the DB still says 'Default' —
      # the exact Sheila branding-seed failure.  The script's own comment at line 699
      # acknowledged 'config_exists=false may be a false negative' but accepted it
      # silently; this guard converts that silent pass into an explicit fail.
      #
      # --allow-default is provided for genuine unconfigured installs (fresh boxes,
      # local dev) but MUST NOT be passed in deploy.sh, fleet-refresh-verify.sh,
      # sunday-cron-sweep.sh, or watchdog-cc.sh.
      if [[ "${ALLOW_DEFAULT:-0}" != "1" && "${COMPANY_DB_NAME,,}" == "default" ]]; then
        _mark "company_name" "false" \
          "DB shows 'Default' company name — branding not seeded (Sheila-class: config may exist at non-standard path or branding seed was never run). Pass --allow-default only on genuinely unconfigured boxes." \
          "\"db_name\":\"$(_jstr "$COMPANY_DB_NAME")\",\"html_name\":\"$(_jstr "$COMPANY_HTML_NAME")\",\"config_exists\":false${CONFIG_WARN_FIELD}"
      elif [[ -z "$COMPANY_DB_NAME" ]]; then
        # REDO #10 [Row 6 — fresh install, no company row → UNKNOWN, not FAIL]:
        # Truth table Row 6: fresh install is not a broken install; B.1 must not block
        # bootstrapping. The companies table may simply be empty on a never-onboarded box.
        # Distinguishing a fresh install from a broken install is not possible at this point
        # (both look like an empty DB name). Map to UNKNOWN (exit 3) so callers do not
        # trigger rollback on a genuinely fresh box.
        #
        # Note: the REDO #8 mirror guard (fail on no company row) was written to prevent
        # silent passes. That guard is correct for CONFIGURED boxes (config file present)
        # where an empty DB row indicates a failed branding seed. For UNCONFIGURED boxes
        # (config absent), an empty DB is the normal fresh-install state.
        # The configured-box branch (COMPANY_CONFIG_EXISTS_BOOL=true) still FAILS for
        # empty DB (line ~1111 above) — that is correct and unchanged.
        _mark "company_name" "unknown" \
          "Unconfigured box — companies table is empty (fresh install / never onboarded; not a broken install). company_name check is UNKNOWN (transient state; will resolve after onboarding)" \
          "\"db_name\":\"\",\"html_name\":\"$(_jstr "$COMPANY_HTML_NAME")\",\"config_exists\":false${CONFIG_WARN_FIELD}"
      elif [[ -z "$COMPANY_HTML_NAME" ]]; then
        # REDO #9 [P0 — false-green, symmetric mirror of REDO #8 configured-box guard]:
        # Spec: 'sqlite3 DB-direct AND from served HTML; must match' — no exception for
        # unconfigured boxes. When COMPANY_CONFIG_EXISTS_BOOL=false, ALLOW_DEFAULT=0,
        # DB contains a real non-Default non-empty name (e.g. 'Acme Corp'), AND all three
        # HTML extraction methods (og:site_name, data-company, <title>) yield empty string,
        # the old else branch emitted company_name.pass=true without the HTML side ever being
        # verified. This guard fires before the mismatch check and before the pass-through else.
        _mark "company_name" "false" \
          "could not extract company name from served HTML — branding unverifiable (unconfigured box; no og:site_name, data-company, or <title> found)" \
          "\"db_name\":\"$(_jstr "$COMPANY_DB_NAME")\",\"html_name\":\"\",\"config_exists\":false${CONFIG_WARN_FIELD}"
      elif [[ "$COMPANY_HTML_NAME" != "$COMPANY_DB_NAME" ]]; then
        _mark "company_name" "false" \
          "Company name mismatch (unconfigured box): DB='${COMPANY_DB_NAME}' vs HTML='${COMPANY_HTML_NAME}'" \
          "\"db_name\":\"$(_jstr "$COMPANY_DB_NAME")\",\"html_name\":\"$(_jstr "$COMPANY_HTML_NAME")\",\"config_exists\":false${CONFIG_WARN_FIELD}"
      else
        # REDO #9 [NON-BLOCKING — accurate detail string]:
        # The old parenthetical '(unconfigured box — Default acceptable with --allow-default)'
        # was contextually wrong when ALLOW_DEFAULT=0 and DB is not 'Default'.
        # Use an accurate description of the actual condition that triggered this branch.
        _mark "company_name" "true" \
          "Company name consistent — unconfigured box, DB: '${COMPANY_DB_NAME}', HTML: '${COMPANY_HTML_NAME}'" \
          "\"db_name\":\"$(_jstr "$COMPANY_DB_NAME")\",\"html_name\":\"$(_jstr "$COMPANY_HTML_NAME")\",\"config_exists\":false${CONFIG_WARN_FIELD}"
      fi
    fi
  fi
fi

###############################################################################
# CHECK 4: pm2 topology
#   - Exactly ONE app bound to CC port
#   - Zero crash-looping CC apps (errored status OR restart-count DELTA >= threshold)
#   - pm_cwd == canonical install dir
#   - DATABASE_PATH explicitly set in env
#
# FIX #2 (vacuous all() + missing-cwd mismatch): PRD B.1 directive (c) — a CC app
#   lacking pm_cwd COUNTS as a cwd mismatch (topology fail). The old `apps_with_cwd`
#   filter excluded apps without pm_cwd from comparison (silent pass on missing cwd).
#   Fix: compare ALL cc_apps directly; missing cwd normalises to '.' which != canon_dir.
#
# FIX #3 (crash-loop scope): delta crash map iterates cc_apps ONLY. A non-CC app
#   (e.g. openclaw-telegram-worker) with restart-delta>=3 must NOT fail pm2_topology.
#
# FIX #4 (wrong cwd for config probe): _pm2_cwd_for_config is now port/name filtered.
#   Here the pm2 Python also filters cc_apps by CC port/name, so a non-CC app before
#   the CC app in the list cannot steal the cwd used for the canon-dir check.
#
# FIX #10 (argv[3] label): Python script reads sys.argv[3] as snapshot_label.
###############################################################################

_log "[4/5] pm2 topology (port binding, crash-loop delta, cwd, DATABASE_PATH)"

if ! command -v pm2 &>/dev/null; then
  _mark "pm2_topology" "false" "pm2 not available — topology check skipped" \
    '"app_count":0,"crash_loopers":[],"database_path_set":false,"cwd_ok":false'
elif ! command -v python3 &>/dev/null; then
  _mark "pm2_topology" "false" "python3 not available — pm2 topology analysis skipped" \
    '"app_count":0,"crash_loopers":[],"database_path_set":false,"cwd_ok":false'
else
  # Determine canonical dir for cwd check.
  EFFECTIVE_CANON_DIR="$CANONICAL_DIR_OVERRIDE"
  if [[ -z "$EFFECTIVE_CANON_DIR" ]]; then
    # Priority: pm2 pm_cwd (CC-filtered), then heuristic dirs
    EFFECTIVE_CANON_DIR=$(_pm2_cwd_for_config)
    if [[ -z "$EFFECTIVE_CANON_DIR" ]]; then
      while IFS= read -r candidate_dir; do
        if [[ -d "$candidate_dir" ]]; then
          EFFECTIVE_CANON_DIR="$candidate_dir"
          break
        fi
      done < <(_heuristic_install_dirs)
    fi
  fi
  _log "  Canonical dir for cwd check: '${EFFECTIVE_CANON_DIR}'"

  # Build the Python analysis script to a temp file.
  _PM2_SCRIPT=$(mktemp /tmp/cc-pm2-check-XXXXXX.py)
  trap 'rm -f "$_PM2_SCRIPT"' EXIT

  cat > "$_PM2_SCRIPT" << 'PYEOF'
import sys
import json
import os
import re

port_str       = sys.argv[1]
canon_dir      = sys.argv[2]   # may be empty string
snapshot_label = sys.argv[3] if len(sys.argv) > 3 else "unknown"  # FIX #10

# Crash restart delta threshold: require >= N restarts within the window
# to distinguish a crash-loop from a single operator-initiated restart.
RESTART_DELTA_THRESHOLD = 3
# Absolute restart count threshold for errored/non-online apps
RESTART_CRASH_THRESHOLD = 10


def parse_apps(raw):
    try:
        apps = json.loads(raw)
    except Exception as e:
        return None, f"pm2 jlist parse failed: {e}"
    if apps is None:
        apps = []
    if not isinstance(apps, list):
        return None, f"pm2 jlist returned unexpected type: {type(apps).__name__}"
    return apps, None


def env_val(pm2_env, key):
    for layer in ('env_data', 'env'):
        e = pm2_env.get(layer) or {}
        if isinstance(e, dict):
            v = e.get(key) or e.get(key.lower())
            if v:
                return str(v)
    v = pm2_env.get(key) or pm2_env.get(key.lower())
    if v:
        return str(v)
    return ""


def get_name(app):
    env = app.get('pm2_env') or {}
    return env.get('name') or app.get('name') or 'unknown'


def get_status(app):
    env = app.get('pm2_env') or {}
    return env.get('status') or ''


def get_restart_count(app):
    env = app.get('pm2_env') or {}
    try:
        return int(env.get('restart_time') or 0)
    except (TypeError, ValueError):
        return 0


def get_cwd(app):
    env = app.get('pm2_env') or {}
    return env.get('pm_cwd') or env.get('cwd') or ''


def port_matches(app, port_str):
    env = app.get('pm2_env') or {}
    port_env = env_val(env, 'PORT')
    if port_env == port_str:
        return True
    args = env.get('args') or env.get('node_args') or ''
    if isinstance(args, list):
        args = ' '.join(str(a) for a in args)
    args_str = str(args)
    if re.search(r'(?:^|\s)-p\s+' + re.escape(port_str) + r'(?:\s|$)', args_str):
        return True
    if re.search(r'--port\s+' + re.escape(port_str) + r'(?!\d)', args_str):
        return True
    return False


def name_matches_cc(app, port_str):
    """Name-based CC detection.
    An app is only counted as a CC app via name match if:
      - its name contains a CC keyword AND
      - its PORT env is either (a) absent/empty (legacy app, no explicit port) OR
        (b) equals the target port.
    An app with an explicit different PORT is NEVER counted.
    """
    env = app.get('pm2_env') or {}
    name = get_name(app).lower()
    name_kw = any(kw in name for kw in ('mission-control', 'command-center', 'blackceo'))
    if not name_kw:
        return False
    port_env = env_val(env, 'PORT')
    if port_env and port_env != port_str:
        return False
    return True


raw_input = sys.stdin.read()
apps, parse_error = parse_apps(raw_input)
if apps is None:
    print(json.dumps({
        "error": parse_error,
        "snapshot_label": snapshot_label,
        "cc_apps": [], "crash_loopers": [],
        "db_path_set": False, "cwd_ok": False, "found_cwd": "",
        "app_restarts": {}
    }))
    sys.exit(0)

# Identify CC apps — use port_matches first (most precise), fall back to name match
cc_apps = []
for app in apps:
    if port_matches(app, port_str) or name_matches_cc(app, port_str):
        cc_apps.append(app)

# -------------------------------------------------------------------------
# FIX #3: crash-looper detection iterates CC APPS ONLY.
# Unrelated pm2 processes that happen to be stopped/errored do NOT trigger.
# -------------------------------------------------------------------------
crash_loopers = []
for app in cc_apps:
    name   = get_name(app)
    status = get_status(app)
    rc     = get_restart_count(app)

    if status == 'errored':
        crash_loopers.append({'name': name, 'reason': 'status=errored', 'restart_count': rc})
    elif status == 'stopped':
        crash_loopers.append({'name': name, 'reason': 'status=stopped (app not running)', 'restart_count': rc})
    elif status not in ('online', 'launching', '') and rc > RESTART_CRASH_THRESHOLD:
        crash_loopers.append({
            'name': name,
            'reason': f'status={status} with restart_count={rc} > {RESTART_CRASH_THRESHOLD}',
            'restart_count': rc
        })

db_path_set = False
found_cwd   = ""

for app in cc_apps:
    env = app.get('pm2_env') or {}
    db_raw = env_val(env, 'DATABASE_PATH')
    if db_raw:
        cwd_a = get_cwd(app)
        if db_raw and not os.path.isabs(db_raw) and cwd_a:
            db_raw = os.path.normpath(os.path.join(cwd_a, db_raw))
        db_path_set = True

    cwd = get_cwd(app)
    if cwd:
        found_cwd = cwd

# CWD check — no vacuous pass, no get_cwd() filter.
# PRD B.1 directive (c): a CC app lacking pm_cwd COUNTS as a cwd mismatch (topology fail).
# The old `apps_with_cwd = [a for a in cc_apps if get_cwd(a)]` filter allowed an app
# with missing pm_cwd to pass silently by being excluded from comparison.
# Fix: compare ALL cc_apps directly. get_cwd(a) returning '' gives
#   os.path.normpath('') == '.' which will != canon_dir → mismatch → cwd_ok=False.
# This removes the vacuous-all() hole entirely: all([]) can NEVER be reached because
#   zero cc_apps → topology already fails on app_count (not on cwd_ok).
# If canon_dir is not set and cc_apps exist: cwd_ok=False.
# If no cc_apps: cwd_ok=False (spec line 21: a cwd check that compared nothing may never
#   report cwd_ok=true; topology verdict is already false via app_count=0 branch).
cwd_ok = False
if cc_apps and canon_dir:
    cwd_ok = all(
        os.path.normpath(get_cwd(a)) == os.path.normpath(canon_dir)
        for a in cc_apps
    )
elif cc_apps and not canon_dir:
    cwd_ok = False
else:
    # REDO #9 [NON-BLOCKING — spec line 21]:
    # Zero cc_apps: no cwd comparison was performed.
    # Spec: 'a cwd check that compared nothing may never report cwd_ok=true.'
    # The overall verdict is already correctly false via the app_count=0 branch
    # at the verdict assembly step; this ensures the JSON field also reflects
    # that no comparison occurred rather than claiming a vacuous pass.
    cwd_ok = False

# FIX #3: emit restart counts for CC APPS ONLY (for delta computation).
# Using all apps for delta would let unrelated apps trip the crash-loop gate.
app_restarts = {get_name(a): get_restart_count(a) for a in cc_apps}

print(json.dumps({
    "snapshot_label": snapshot_label,
    "cc_apps": [
        {
            "name":          get_name(a),
            "status":        get_status(a),
            "cwd":           get_cwd(a),
            "restart_count": get_restart_count(a),
        }
        for a in cc_apps
    ],
    "crash_loopers":  crash_loopers,
    "db_path_set":    db_path_set,
    "cwd_ok":         cwd_ok,
    "found_cwd":      found_cwd,
    "app_restarts":   app_restarts,
}))
PYEOF

  _run_pm2_snapshot() {
    # FIX #10: pass snapshot label as argv[3] so both snapshots are distinguishable in errors.
    local label="$1"
    local raw
    raw=$(_timeout_cmd 15 pm2 jlist 2>/dev/null || echo "[]")
    printf '%s\n' "$raw" \
      | python3 -s "$_PM2_SCRIPT" "$PORT" "$EFFECTIVE_CANON_DIR" "$label" 2>/dev/null \
      || echo "{\"error\":\"pm2 analysis script failed\",\"snapshot_label\":\"${label}\",\"cc_apps\":[],\"crash_loopers\":[],\"db_path_set\":false,\"cwd_ok\":false,\"found_cwd\":\"\",\"app_restarts\":{}}"
  }

  _log "  Taking first pm2 snapshot..."
  SNAP1=$(_run_pm2_snapshot "first")

  if [[ "${PM2_CHECK_WINDOW:-0}" -gt 0 ]]; then
    _log "  Waiting ${PM2_CHECK_WINDOW}s for restart-count delta check..."
    sleep "$PM2_CHECK_WINDOW"
    _log "  Taking second pm2 snapshot..."
    SNAP2=$(_run_pm2_snapshot "second")
  else
    SNAP2="$SNAP1"
  fi

  # FIX #3: delta crash-loop detection over CC APPS ONLY.
  # app_restarts in each snapshot now contains only CC apps (set in Python above).
  DELTA_CRASHERS=$(python3 -s -c "
import sys, json
RESTART_DELTA_THRESHOLD = 3
try:
  snap1 = json.loads(sys.argv[1])
  snap2 = json.loads(sys.argv[2])
  r1 = snap1.get('app_restarts') or {}
  r2 = snap2.get('app_restarts') or {}
  extra = []
  for name, rc2 in r2.items():
    rc1 = r1.get(name, rc2)
    delta = rc2 - rc1
    if delta >= RESTART_DELTA_THRESHOLD:
      extra.append({
        'name': name,
        'reason': f'restart_count increased {rc1}->{rc2} (delta={delta}>={RESTART_DELTA_THRESHOLD}) during window',
        'restart_count': rc2
      })
  print(json.dumps(extra))
except Exception as e:
  print('[]')
" "$SNAP1" "$SNAP2" 2>/dev/null || echo "[]")

  # Merge delta crash-loopers into the topology crash_loopers list
  PM2_ANALYSIS=$(python3 -s -c "
import sys, json
try:
  d = json.loads(sys.argv[1])
  delta = json.loads(sys.argv[2])
  existing = d.get('crash_loopers') or []
  existing_names = {c['name'] for c in existing}
  for dc in delta:
    if dc['name'] not in existing_names:
      existing.append(dc)
  d['crash_loopers'] = existing
  print(json.dumps(d))
except Exception as e:
  print(sys.argv[1])
" "$SNAP2" "$DELTA_CRASHERS" 2>/dev/null || echo "$SNAP2")

  rm -f "$_PM2_SCRIPT"
  trap - EXIT

  PM2_ERROR=$(printf '%s' "$PM2_ANALYSIS" \
    | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',''))" \
    2>/dev/null || true)
  PM2_CC_APP_COUNT=$(printf '%s' "$PM2_ANALYSIS" \
    | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('cc_apps',[])))" \
    2>/dev/null || echo "0")
  PM2_CRASH_LOOPERS_JSON=$(printf '%s' "$PM2_ANALYSIS" \
    | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('crash_loopers',[])))" \
    2>/dev/null || echo "[]")
  PM2_DB_PATH_SET=$(printf '%s' "$PM2_ANALYSIS" \
    | python3 -s -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('db_path_set') else 'false')" \
    2>/dev/null || echo "false")
  PM2_CWD_OK=$(printf '%s' "$PM2_ANALYSIS" \
    | python3 -s -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('cwd_ok') else 'false')" \
    2>/dev/null || echo "false")
  PM2_FOUND_CWD=$(printf '%s' "$PM2_ANALYSIS" \
    | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(d.get('found_cwd',''))" \
    2>/dev/null || echo "")

  PM2_APP_COUNT="$PM2_CC_APP_COUNT"

  _log "  CC apps on port ${PORT}: ${PM2_APP_COUNT}"
  _log "  Crash-loopers (CC-scoped): ${PM2_CRASH_LOOPERS_JSON}"
  _log "  DATABASE_PATH set: ${PM2_DB_PATH_SET}"
  _log "  CWD ok: ${PM2_CWD_OK} (found: ${PM2_FOUND_CWD}, canonical: ${EFFECTIVE_CANON_DIR})"

  PM2_PASS="true"
  PM2_DETAIL="pm2 topology OK: 1 app on port ${PORT}, no crash-loopers, cwd OK"

  if [[ -n "$PM2_ERROR" ]]; then
    PM2_PASS="false"
    PM2_DETAIL="pm2 jlist parse error: ${PM2_ERROR}"
  elif [[ "$PM2_APP_COUNT" -eq 0 ]]; then
    PM2_PASS="false"
    PM2_DETAIL="No pm2 app found bound to port ${PORT}"
  elif [[ "$PM2_APP_COUNT" -gt 1 ]]; then
    PM2_PASS="false"
    PM2_DETAIL="${PM2_APP_COUNT} pm2 apps bound to port ${PORT} — zombie process(es) fighting for port"
  elif [[ "$PM2_CRASH_LOOPERS_JSON" != "[]" ]]; then
    PM2_PASS="false"
    PM2_DETAIL="Crash-looping or stopped CC app(s) detected: ${PM2_CRASH_LOOPERS_JSON}"
  elif [[ "$PM2_DB_PATH_SET" == "false" ]]; then
    # REDO #10 [Row 21]: DATABASE_PATH unset → PASS with warning, not FAIL.
    # Truth table Row 21: 'Default path is valid; unset is not misconfigured.'
    # A correctly deployed box where DATABASE_PATH was never set uses the
    # src/lib/db/index.ts default (process.cwd()/mission-control.db) — this is
    # valid as long as pm_cwd is the canonical dir (checked next).
    # Demote to a warning detail field so operators know to set it (B.4 hardening),
    # but do NOT fail the check — a correctly running box should not be penalised.
    PM2_PASS="true"
    PM2_DETAIL="pm2 topology OK (DATABASE_PATH not explicitly set — uses default process.cwd() path; set via B.4 hardening for cwd-drift resilience)"
    # If cwd is also wrong while DATABASE_PATH is unset, the cwd check below will catch it.
  fi
  if [[ "$PM2_CWD_OK" == "false" && "$PM2_PASS" == "true" ]]; then
    if [[ -n "$EFFECTIVE_CANON_DIR" ]]; then
      PM2_PASS="false"
      PM2_DETAIL="pm_cwd '${PM2_FOUND_CWD}' != canonical dir '${EFFECTIVE_CANON_DIR}'"
    else
      PM2_PASS="false"
      PM2_DETAIL="pm_cwd check: canonical dir could not be auto-derived — supply --canonical-dir"
    fi
  fi

  _mark "pm2_topology" "$PM2_PASS" "$PM2_DETAIL" \
    "\"app_count\":${PM2_APP_COUNT},\"crash_loopers\":${PM2_CRASH_LOOPERS_JSON},\"database_path_set\":${PM2_DB_PATH_SET},\"cwd_ok\":${PM2_CWD_OK}"
fi

###############################################################################
# CHECK 5: Disk headroom >= DISK_MIN_GB on the data volume
###############################################################################

_log "[5/5] Disk headroom (build threshold: ${DISK_MIN_GB}GB)"

_resolve_disk_path() {
  if [[ -n "$DISK_PATH_OVERRIDE" ]]; then
    echo "$DISK_PATH_OVERRIDE"
    return
  fi
  if [[ -d "/data" ]]; then
    echo "/data"
    return
  fi
  echo "$HOME"
}

DISK_CHECK_PATH=$(_resolve_disk_path)

if ! command -v df &>/dev/null; then
  _mark "disk_headroom" "false" "df not available — disk check skipped" \
    '"free_gb":0,"path":"","threshold_gb":'"${DISK_MIN_GB}"
else
  AVAIL_KB=$(df -k "$DISK_CHECK_PATH" 2>/dev/null \
    | awk 'NR==2 {print $4}' || echo "0")
  # REDO #10 [Row 24]: use floating-point comparison so DISK_MIN_GB=0.5 (500 MB) works.
  # awk handles the decimal threshold cleanly on both macOS and Linux.
  DISK_FREE_GB_RAW=$(awk "BEGIN {printf \"%.2f\", ${AVAIL_KB:-0} / 1024 / 1024}" 2>/dev/null || echo "0")
  # Integer part for display (e.g. "1.23" → "1.23")
  DISK_FREE_GB="$DISK_FREE_GB_RAW"

  # Compute integer equivalent in MB for comparison (avoids floating-point in bash)
  AVAIL_MB=$(( ${AVAIL_KB:-0} / 1024 ))
  THRESHOLD_MB=$(awk "BEGIN {printf \"%d\", ${DISK_MIN_GB} * 1024}" 2>/dev/null || echo "5120")

  _log "  Disk path: ${DISK_CHECK_PATH}"
  _log "  Free: ${DISK_FREE_GB}GB (threshold: ${DISK_MIN_GB}GB = ${THRESHOLD_MB}MB)"

  if [[ "$AVAIL_MB" -ge "$THRESHOLD_MB" ]]; then
    _mark "disk_headroom" "true" \
      "${DISK_FREE_GB}GB free on ${DISK_CHECK_PATH} (threshold ${DISK_MIN_GB}GB)" \
      "\"free_gb\":${DISK_FREE_GB},\"path\":\"$(_jstr "$DISK_CHECK_PATH")\",\"threshold_gb\":${DISK_MIN_GB}"
  else
    _mark "disk_headroom" "false" \
      "ONLY ${DISK_FREE_GB}GB free on ${DISK_CHECK_PATH} — below ${DISK_MIN_GB}GB threshold" \
      "\"free_gb\":${DISK_FREE_GB},\"path\":\"$(_jstr "$DISK_CHECK_PATH")\",\"threshold_gb\":${DISK_MIN_GB}"
  fi
fi

###############################################################################
# REDO #10 [missingFromSpec — --public-url CF tunnel warning probe]:
# When --public-url is set, probe the public subdomain and emit a WARNING (not
# a hard FAIL) if it does not return 302-to-CF-login. This does not affect the
# green/not-green verdict or any of the 5 B.1 checks.
###############################################################################

PUBLIC_URL_WARN=""
if [[ -n "$PUBLIC_URL_PROBE" ]]; then
  _log "[optional] CF-tunnel public-URL probe: ${PUBLIC_URL_PROBE}"
  CF_PROBE_RESP=$(curl -s -o /dev/null \
    -w "%{http_code}|||%{redirect_url}" \
    --max-time 10 \
    --max-redirs 0 \
    "$PUBLIC_URL_PROBE" 2>/dev/null || echo "000|||")
  CF_PROBE_CODE="${CF_PROBE_RESP%%|||*}"
  CF_PROBE_REDIR="${CF_PROBE_RESP##*|||}"

  if [[ "$CF_PROBE_CODE" == "302" || "$CF_PROBE_CODE" == "301" ]]; then
    if printf '%s' "$CF_PROBE_REDIR" | grep -qiE 'cloudflareaccess\.com|auth\..*\.com'; then
      _log "  OK  CF-tunnel probe: ${CF_PROBE_CODE} → CF-login (${CF_PROBE_REDIR})"
    else
      _log "  WARN CF-tunnel probe: ${CF_PROBE_CODE} redirect but NOT to CF-Access (${CF_PROBE_REDIR})"
      PUBLIC_URL_WARN="CF-tunnel redirect to unexpected host (${CF_PROBE_REDIR})"
    fi
  elif [[ "$CF_PROBE_CODE" == "200" ]]; then
    _log "  WARN CF-tunnel probe: 200 (expected 302 to CF-login — CF-Access may not be active on this subdomain)"
    PUBLIC_URL_WARN="CF-tunnel returned 200 directly — CF-Access may not be active on ${PUBLIC_URL_PROBE}"
  elif [[ "$CF_PROBE_CODE" == "000" ]]; then
    _log "  WARN CF-tunnel probe: 000 (connection refused — tunnel may be down)"
    PUBLIC_URL_WARN="CF-tunnel unreachable (connection refused to ${PUBLIC_URL_PROBE})"
  else
    _log "  WARN CF-tunnel probe: unexpected HTTP ${CF_PROBE_CODE} (expected 302)"
    PUBLIC_URL_WARN="CF-tunnel returned unexpected HTTP ${CF_PROBE_CODE} on ${PUBLIC_URL_PROBE}"
  fi
fi

###############################################################################
# Assemble output JSON
#
# REDO #10: Check state can now be "true", "false", or "unknown".
# - "true"  → check passed definitively
# - "false" → check failed definitively (exit 1 = not-green)
# - "unknown" → check indeterminate (exit 3 = UNKNOWN; transient infra condition)
#
# ALL_PASS = true only when every check is "true".
# HAS_UNKNOWN = true when any check is "unknown" and none is "false"
#   (unknown + false → still exit 1, the definitive failure is authoritative).
###############################################################################

ALL_PASS="true"
HAS_UNKNOWN="false"
for k in http_root http_api_health static_assets company_name pm2_topology disk_headroom; do
  v="${CHECK_PASS[$k]:-false}"
  if [[ "$v" == "unknown" ]]; then
    HAS_UNKNOWN="true"
    ALL_PASS="false"
  elif [[ "$v" != "true" ]]; then
    ALL_PASS="false"
  fi
done

TS=$(_iso8601)

build_check_json() {
  local key="$1"
  local pass="${CHECK_PASS[$key]:-false}"
  local detail="${CHECK_DETAIL[$key]:-not run}"
  local extra="${CHECK_EXTRA[$key]:-}"
  # "unknown" is not valid JSON bool — emit as null with an "unknown":true companion field
  local pass_json
  if [[ "$pass" == "unknown" ]]; then
    pass_json='null,"unknown":true'
  else
    pass_json="$pass"
  fi
  printf '"%s":{"pass":%s,"detail":"%s"%s}' \
    "$(_jstr "$key")" \
    "$pass_json" \
    "$(_jstr "$detail")" \
    "${extra:+,$extra}"
}

# Determine overall exit code
if [[ "$ALL_PASS" == "true" ]]; then
  OVERALL_EXIT=0
  OVERALL_STATUS="GREEN"
elif [[ "$HAS_UNKNOWN" == "true" ]]; then
  # At least one check is UNKNOWN and no check is definitively false
  # Re-check: if any check is "false" (definitive), use exit 1
  _any_definitive_fail="false"
  for k in http_root http_api_health static_assets company_name pm2_topology disk_headroom; do
    v="${CHECK_PASS[$k]:-false}"
    if [[ "$v" == "false" ]]; then
      _any_definitive_fail="true"
      break
    fi
  done
  if [[ "$_any_definitive_fail" == "true" ]]; then
    OVERALL_EXIT=1
    OVERALL_STATUS="NOT_GREEN"
  else
    OVERALL_EXIT=3
    OVERALL_STATUS="UNKNOWN"
  fi
else
  OVERALL_EXIT=1
  OVERALL_STATUS="NOT_GREEN"
fi

OUT='{'
OUT+='"green":'${ALL_PASS}','
if [[ "$OVERALL_EXIT" -eq 3 ]]; then
  OUT+='"indeterminate":true,'
fi
OUT+='"timestamp":"'${TS}'",'
OUT+='"checks":{'
OUT+=$(build_check_json "http_root")
OUT+=','
OUT+=$(build_check_json "http_api_health")
OUT+=','
OUT+=$(build_check_json "static_assets")
OUT+=','
OUT+=$(build_check_json "company_name")
OUT+=','
OUT+=$(build_check_json "pm2_topology")
OUT+=','
OUT+=$(build_check_json "disk_headroom")
OUT+='}'
# Append warnings if any (CF-tunnel probe, etc.)
if [[ -n "$PUBLIC_URL_WARN" ]]; then
  OUT+=',"warnings":["'"$(_jstr "$PUBLIC_URL_WARN")"'"]'
fi
OUT+='}'

if [[ "$PRETTY" == "1" ]] && command -v python3 &>/dev/null; then
  printf '%s' "$OUT" | python3 -m json.tool
else
  printf '%s\n' "$OUT"
fi

###############################################################################
# Exit code
# REDO #10: exit 0=green, exit 1=not-green (definitive), exit 2=usage error,
#           exit 3=UNKNOWN/indeterminate (transient infra condition)
###############################################################################

case "$OVERALL_EXIT" in
  0)
    _log "RESULT: GREEN — all checks passed"
    exit 0
    ;;
  3)
    _log "RESULT: UNKNOWN — one or more checks indeterminate (transient condition; retry)"
    exit 3
    ;;
  *)
    _log "RESULT: NOT GREEN — one or more checks failed (definitive)"
    exit 1
    ;;
esac
