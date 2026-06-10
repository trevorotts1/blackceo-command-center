#!/usr/bin/env bash
# cc-health-check.sh — THE single definition of "green" for a deployed
# BlackCEO Command Center instance.
#
# PRD Addendum B, item B.1 (P0)
#
# REQUIRES: bash 4+ (hard guard below), curl, sqlite3, pm2, python3, df
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
#     "static_assets":    { "pass": bool, "detail": "...", "total": N, "failed": ["/_next/static/…:HTTP404"] },
#     "company_name":     { "pass": bool, "detail": "...", "db_name": "Acme", "html_name": "Acme", "config_exists": bool },
#     "pm2_topology":     { "pass": bool, "detail": "...", "app_count": 1, "crash_loopers": [], "database_path_set": bool, "cwd_ok": bool },
#     "disk_headroom":    { "pass": bool, "detail": "...", "free_gb": 12, "path": "/data", "threshold_gb": 5 }
#   }
# }
#
# Exit codes: 0 = green, 1 = not green, 2 = usage error
#
# PARAMETERS (env vars or flags — flags take precedence)
# -------------------------------------------------------
#   --port PORT            TCP port the CC listens on          (default: 4000)
#   --db-path PATH         Absolute path to mission-control.db (default: resolve from pm2/env)
#   --canonical-dir DIR    Canonical install directory (REQUIRED or auto-derived)
#   --host HOST            Public hostname/URL for display only (default: http://127.0.0.1:PORT)
#   --disk-path PATH       Path to check for disk headroom     (default: data-volume heuristic)
#   --disk-min-gb N        Minimum free GB required            (default: 5)
#   --pm2-check-window N   Seconds between restart-count snapshots for delta check (default: 15)
#   --max-assets N         Max /_next/static assets to probe   (default: 50)
#   --json-only            Suppress all stderr progress lines
#   --pretty               Pretty-print the JSON output
#
# Env-var equivalents (lower priority than flags):
#   CC_PORT, CC_DB_PATH, CC_CANONICAL_DIR, CC_PUBLIC_HOST,
#   CC_DISK_PATH, CC_DISK_MIN_GB, CC_PM2_CHECK_WINDOW, CC_MAX_ASSETS
#
# CONSUMED BY
# -----------
#   scripts/deploy.sh (B.2)          — post-restart verification + auto-rollback trigger
#   fleet-refresh verification        — B.2 canary gate
#   Sunday cron                       — B.1 weekly fleet sweep
#   watchdogs                         — continuous crash detection
#   Any sweep script                  — stop writing your own green signature; call this

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

###############################################################################
# Argument parsing
###############################################################################

PORT="${CC_PORT:-4000}"
DB_PATH_OVERRIDE="${CC_DB_PATH:-}"
CANONICAL_DIR_OVERRIDE="${CC_CANONICAL_DIR:-}"
PUBLIC_HOST="${CC_PUBLIC_HOST:-}"
DISK_PATH_OVERRIDE="${CC_DISK_PATH:-}"
DISK_MIN_GB="${CC_DISK_MIN_GB:-5}"
PM2_CHECK_WINDOW="${CC_PM2_CHECK_WINDOW:-15}"
MAX_ASSETS="${CC_MAX_ASSETS:-50}"
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
    --json-only)        JSON_ONLY="1"; shift ;;
    --pretty)           PRETTY="1"; shift ;;
    *) _die_usage "Unknown argument: $1" ;;
  esac
done

###############################################################################
# Resolved defaults
###############################################################################

# Base URL for local probes (always 127.0.0.1 to bypass CF-Access on health checks)
LOCAL_BASE="http://127.0.0.1:${PORT}"

# Public host used only for display; probes always hit 127.0.0.1
PUBLIC_BASE="${PUBLIC_HOST:-${LOCAL_BASE}}"
PUBLIC_BASE="${PUBLIC_BASE%/}"

###############################################################################
# Dependency check (warn but continue — we report per-check failures, not abort)
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
# CHECK 1: HTTP 200 on / and /api/health (with redirect following)
###############################################################################

_log "[1/5] HTTP liveness — / and /api/health"

_http_check() {
  local label="$1" url="$2"
  local code
  # -L follows redirects; --max-time 10; write only the final status code
  code=$(curl -s -L -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")
  local display_code
  display_code=$(printf '%d' "$code" 2>/dev/null || echo "$code")
  if [[ "$code" == "200" ]]; then
    _log "  OK  $label => $display_code"
    echo "pass"
  else
    _log "  FAIL $label => $display_code"
    echo "fail:${display_code}"
  fi
}

ROOT_RESULT=$(_http_check "GET /" "${LOCAL_BASE}/")
API_RESULT=$(_http_check "GET /api/health" "${LOCAL_BASE}/api/health")

ROOT_CODE="${ROOT_RESULT#fail:}"
API_CODE="${API_RESULT#fail:}"

if [[ "$ROOT_RESULT" == "pass" ]]; then
  _mark "http_root" "true" "HTTP 200 on /"
else
  _mark "http_root" "false" "HTTP ${ROOT_CODE} on / (expected 200)"
fi

if [[ "$API_RESULT" == "pass" ]]; then
  _mark "http_api_health" "true" "HTTP 200 on /api/health"
else
  _mark "http_api_health" "false" "HTTP ${API_CODE} on /api/health (expected 200)"
fi

###############################################################################
# CHECK 2: Serve HTML → extract EVERY /_next/static asset → curl each → 200
#          This is the Sheila bug detector: stale manifest hash absent on disk.
#          --max-assets limits probe count to avoid blocking callers indefinitely.
###############################################################################

_log "[2/5] Static asset integrity (stale-manifest detection, max assets: ${MAX_ASSETS})"

if ! command -v curl &>/dev/null; then
  _mark "static_assets" "false" "curl not available — cannot check assets" \
    '"total":0,"failed":[]'
else
  # Fetch the served HTML from / via 127.0.0.1 so CF-Access cannot block the probe
  HTML=$(curl -s -L --max-time 15 "${LOCAL_BASE}/" 2>/dev/null || true)

  if [[ -z "$HTML" ]]; then
    _mark "static_assets" "false" "Could not fetch HTML from / to parse assets" \
      '"total":0,"failed":[]'
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

    # Count only non-blank lines
    ASSET_COUNT=$(printf '%s' "$ASSET_PATHS" \
      | grep -v '^[[:space:]]*$' | grep -c '.' 2>/dev/null || echo "0")

    if [[ "$ASSET_COUNT" -eq 0 ]]; then
      # No /_next/static refs in HTML is suspicious — Next.js always injects them.
      # Flag as fail so sweeps don't silently pass a non-Next-JS response.
      _mark "static_assets" "false" \
        "No /_next/static asset references found in served HTML — build may not be wired or server is returning an error page" \
        '"total":0,"failed":[]'
    else
      _log "  Found $ASSET_COUNT /_next/static asset references (probing up to ${MAX_ASSETS})"
      FAILED_ASSETS=()
      TOTAL_CHECKED=0

      while IFS= read -r asset_path; do
        [[ -z "$asset_path" ]] && continue

        # Enforce per-run asset cap to bound wall-clock time
        if [[ "$TOTAL_CHECKED" -ge "$MAX_ASSETS" ]]; then
          _log "  INFO: asset probe cap (${MAX_ASSETS}) reached — remaining assets not probed"
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

      ASSETS_TOTAL="$TOTAL_CHECKED"

      if [[ ${#FAILED_ASSETS[@]} -eq 0 ]]; then
        ASSETS_PASS="true"
        ASSETS_DETAIL="all ${ASSETS_TOTAL} static assets returned 200 with correct content-type"
        FAILED_JSON_ARR="[]"
      else
        ASSETS_PASS="false"
        FAILED_COUNT=${#FAILED_ASSETS[@]}
        ASSETS_DETAIL="${FAILED_COUNT}/${ASSETS_TOTAL} static assets failed (stale manifest or missing files on disk)"
        FAILED_JSON_ARR="["
        first=1
        for fa in "${FAILED_ASSETS[@]}"; do
          [[ $first -eq 0 ]] && FAILED_JSON_ARR+=","
          FAILED_JSON_ARR+="\"$(_jstr "$fa")\""
          first=0
        done
        FAILED_JSON_ARR+="]"
      fi

      _mark "static_assets" "$ASSETS_PASS" "$ASSETS_DETAIL" \
        "\"total\":${ASSETS_TOTAL},\"failed\":${FAILED_JSON_ARR}"
    fi
  fi
fi

###############################################################################
# CHECK 3: Company name — DB-direct AND served HTML; must match; not "Default"
#          on a box with company-config.json present.
#
# CRITICAL: "configured box" status is determined by a DIRECT DISK PROBE of
# heuristic paths — NOT from pm2 state. pm2 being stopped must not cause
# a false-green when company-config.json and a Default DB row exist on disk.
###############################################################################

_log "[3/5] Company name consistency (DB-direct vs served HTML)"

# Resolve the DB path in priority order:
#   1. --db-path flag / CC_DB_PATH env
#   2. DATABASE_PATH from the running pm2 process env (resolved against pm_cwd for relative paths)
#   3. Canonical paths heuristic
_resolve_db_path() {
  if [[ -n "$DB_PATH_OVERRIDE" ]]; then
    echo "$DB_PATH_OVERRIDE"
    return
  fi

  # Try pm2 process env (pipe pm2 output through python3)
  if command -v pm2 &>/dev/null && command -v python3 &>/dev/null; then
    local pm2_raw pm2_db
    pm2_raw=$(timeout 15 pm2 jlist 2>/dev/null || echo "[]")
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

  # Heuristic: common install paths (kept in sync with _heuristic_install_dirs)
  while IFS= read -r candidate_dir; do
    local candidate="${candidate_dir}/mission-control.db"
    if [[ -f "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done < <(_heuristic_install_dirs)

  echo ""
}

# Determine whether the box has a real company-config.json with a non-empty companyName.
# Uses the same heuristic paths as DB resolution — no pm2 dependency.
_get_config_company_name() {
  local install_dir="${1:-}"
  [[ -z "$install_dir" ]] && echo "" && return
  local cfg="${install_dir}/config/company-config.json"
  [[ ! -f "$cfg" ]] && echo "" && return
  python3 -s -c "
import json, sys
try:
  d = json.load(open('${cfg}'))
  n = (d.get('companyName') or '').strip()
  print(n)
except Exception:
  print('')
" 2>/dev/null || echo ""
}

# DISK-DIRECT config probe: find company-config.json from disk, independent of pm2 state.
# Uses: --canonical-dir if set, then heuristic install dirs.
# This is the single source of truth for COMPANY_CONFIG_EXISTS.
_find_config_company_name_from_disk() {
  # Priority 1: explicit canonical dir
  if [[ -n "$CANONICAL_DIR_OVERRIDE" ]]; then
    local result
    result=$(_get_config_company_name "$CANONICAL_DIR_OVERRIDE")
    echo "$result"
    return
  fi

  # Priority 2: heuristic dirs (same list as DB resolution)
  while IFS= read -r candidate_dir; do
    if [[ -f "${candidate_dir}/config/company-config.json" ]]; then
      local result
      result=$(_get_config_company_name "$candidate_dir")
      if [[ -n "$result" ]]; then
        echo "$result"
        return
      fi
    fi
  done < <(_heuristic_install_dirs)

  echo ""
}

# sqlite3 query with retry on SQLITE_BUSY (up to 3 attempts, 5000ms timeout each)
_sqlite3_query() {
  local db_path="$1" query="$2"
  local attempt result
  for attempt in 1 2 3; do
    result=$(sqlite3 -cmd '.timeout 5000' "$db_path" "$query" 2>/dev/null || true)
    if [[ -n "$result" || "$attempt" -eq 3 ]]; then
      echo "$result"
      return
    fi
    sleep 1
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

    # Read name from DB with retry on lock
    DB_COMPANY=$(_sqlite3_query "$DB_PATH" \
      "SELECT name FROM companies WHERE name IS NOT NULL AND name != '' ORDER BY created_at ASC LIMIT 1;")
    # Fallback: any row
    if [[ -z "$DB_COMPANY" ]]; then
      DB_COMPANY=$(_sqlite3_query "$DB_PATH" \
        "SELECT name FROM companies ORDER BY created_at ASC LIMIT 1;")
    fi
    COMPANY_DB_NAME="${DB_COMPANY:-}"

    # Read name from served HTML.
    HTML_FOR_COMPANY=$(curl -s -L --max-time 10 "${LOCAL_BASE}/" 2>/dev/null || true)

    COMPANY_HTML_NAME=""
    if [[ -n "$HTML_FOR_COMPANY" ]]; then
      # og:site_name — handle both attribute orderings
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
        COMPANY_HTML_NAME=$(printf '%s' "$HTML_FOR_COMPANY" \
          | grep -oE '<title>[^<]+</title>' \
          | sed 's/<title>//;s/<\/title>//' \
          | awk -F' [—–|-] ' '{print $1}' \
          | head -1 || true)
      fi
    fi

    # DISK-DIRECT: determine configured-box status from filesystem, not pm2.
    # This means pm2 being stopped never silently passes a Default-seeded configured box.
    CONFIG_COMPANY_NAME=$(_find_config_company_name_from_disk)
    if [[ -n "$CONFIG_COMPANY_NAME" ]]; then
      COMPANY_CONFIG_EXISTS="true"
    else
      COMPANY_CONFIG_EXISTS="false"
    fi

    _log "  DB company name:   '${COMPANY_DB_NAME}'"
    _log "  HTML company name: '${COMPANY_HTML_NAME}'"
    _log "  Config exists (disk-direct): ${COMPANY_CONFIG_EXISTS}"

    if [[ "$COMPANY_CONFIG_EXISTS" == "true" ]]; then
      if [[ -z "$COMPANY_DB_NAME" ]]; then
        _mark "company_name" "false" \
          "Configured box has no company row in DB — branding not seeded (run B.3 seed)" \
          "\"db_name\":\"\",\"html_name\":\"$(_jstr "$COMPANY_HTML_NAME")\",\"config_exists\":true"
      elif [[ "${COMPANY_DB_NAME,,}" == "default" ]]; then
        _mark "company_name" "false" \
          "Configured box shows 'Default' company in DB — branding seed failed (Sheila bug)" \
          "\"db_name\":\"$(_jstr "$COMPANY_DB_NAME")\",\"html_name\":\"$(_jstr "$COMPANY_HTML_NAME")\",\"config_exists\":true"
      elif [[ -n "$COMPANY_HTML_NAME" && "$COMPANY_HTML_NAME" != "$COMPANY_DB_NAME" ]]; then
        _mark "company_name" "false" \
          "Company name mismatch: DB='${COMPANY_DB_NAME}' vs HTML='${COMPANY_HTML_NAME}'" \
          "\"db_name\":\"$(_jstr "$COMPANY_DB_NAME")\",\"html_name\":\"$(_jstr "$COMPANY_HTML_NAME")\",\"config_exists\":true"
      else
        _mark "company_name" "true" \
          "Company name consistent: '${COMPANY_DB_NAME}'" \
          "\"db_name\":\"$(_jstr "$COMPANY_DB_NAME")\",\"html_name\":\"$(_jstr "$COMPANY_HTML_NAME")\",\"config_exists\":true"
      fi
    else
      # Unconfigured box — Default is allowed but mismatch is still a fail
      if [[ -n "$COMPANY_HTML_NAME" && -n "$COMPANY_DB_NAME" \
            && "$COMPANY_HTML_NAME" != "$COMPANY_DB_NAME" ]]; then
        _mark "company_name" "false" \
          "Company name mismatch (unconfigured box): DB='${COMPANY_DB_NAME}' vs HTML='${COMPANY_HTML_NAME}'" \
          "\"db_name\":\"$(_jstr "$COMPANY_DB_NAME")\",\"html_name\":\"$(_jstr "$COMPANY_HTML_NAME")\",\"config_exists\":false"
      else
        _mark "company_name" "true" \
          "Company name OK (unconfigured box — Default acceptable): '${COMPANY_DB_NAME:-empty}'" \
          "\"db_name\":\"$(_jstr "$COMPANY_DB_NAME")\",\"html_name\":\"$(_jstr "$COMPANY_HTML_NAME")\",\"config_exists\":false"
      fi
    fi
  fi
fi

###############################################################################
# CHECK 4: pm2 topology
#   - Exactly ONE app bound to CC port
#   - Zero crash-looping apps (errored status OR restart-count DELTA > 0 over window)
#   - pm_cwd == canonical install dir (ALWAYS checked; auto-derived if not specified)
#   - DATABASE_PATH explicitly set in env (B.4 pin)
#   - App must be in 'online' or 'launching' status (stopped = fail)
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
  # If not supplied via flag/env, auto-derive from the same heuristic paths used for DB.
  # We NEVER default to cwd_match=True — the spec requires this check unconditionally.
  EFFECTIVE_CANON_DIR="$CANONICAL_DIR_OVERRIDE"
  if [[ -z "$EFFECTIVE_CANON_DIR" ]]; then
    while IFS= read -r candidate_dir; do
      if [[ -d "$candidate_dir" ]]; then
        EFFECTIVE_CANON_DIR="$candidate_dir"
        break
      fi
    done < <(_heuristic_install_dirs)
  fi
  _log "  Canonical dir for cwd check: '${EFFECTIVE_CANON_DIR}'"

  # -------------------------------------------------------------------------
  # Build the Python analysis script once to a temp file.
  # The script takes the pm2 jlist JSON on stdin and two snapshots are taken
  # when PM2_CHECK_WINDOW > 0 to detect restart-count delta (crash-loopers).
  # -------------------------------------------------------------------------
  _PM2_SCRIPT=$(mktemp /tmp/cc-pm2-check-XXXXXX.py)
  trap 'rm -f "$_PM2_SCRIPT"' EXIT

  cat > "$_PM2_SCRIPT" << 'PYEOF'
import sys
import json
import os
import re

port_str     = sys.argv[1]
canon_dir    = sys.argv[2]   # may be empty string
# snapshot_label is 'first' or 'second'; used to emit per-snapshot data for delta
snapshot_label = sys.argv[3] if len(sys.argv) > 3 else 'single'

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
    # Word-boundary match: port_str must not be adjacent to another digit
    pattern = r'(?<![0-9])' + re.escape(port_str) + r'(?![0-9])'
    if re.search(r'(?:^|\s)-p\s+' + re.escape(port_str) + r'(?:\s|$)', args_str):
        return True
    if re.search(r'--port\s+' + re.escape(port_str) + r'(?!\d)', args_str):
        return True
    return False


def name_matches_cc(app, port_str):
    """Name match is only used as a SECONDARY signal, and only when the app also
    binds to the expected port (checked via port_matches) — OR when there is no
    PORT env at all (legacy apps registered without explicit PORT).
    This prevents 'blackceo-staging' on a different port from being counted."""
    env = app.get('pm2_env') or {}
    name = get_name(app).lower()
    name_kw = any(kw in name for kw in ('mission-control', 'command-center', 'blackceo'))
    if not name_kw:
        return False
    # Only count name match if the app also binds this port OR has no PORT set at all
    port_env = env_val(env, 'PORT')
    if port_env and port_env != port_str:
        return False  # app explicitly targets a different port
    return True


raw_input = sys.stdin.read()
apps, parse_error = parse_apps(raw_input)
if apps is None:
    print(json.dumps({
        "error": parse_error,
        "cc_apps": [], "crash_loopers": [],
        "db_path_set": False, "cwd_ok": False, "found_cwd": "",
        "app_restarts": {}
    }))
    sys.exit(0)

cc_apps = []
for app in apps:
    if port_matches(app, port_str) or name_matches_cc(app, port_str):
        cc_apps.append(app)

# Crash-looper detection — includes stopped apps as failing
crash_loopers = []
for app in apps:
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
cwd_match   = True   # will be re-evaluated below (never defaults to True without a check)
found_cwd   = ""

for app in cc_apps:
    env = app.get('pm2_env') or {}
    db_raw = env_val(env, 'DATABASE_PATH')
    if db_raw:
        # Resolve relative DATABASE_PATH against pm_cwd
        cwd_a = get_cwd(app)
        if db_raw and not os.path.isabs(db_raw) and cwd_a:
            db_raw = os.path.normpath(os.path.join(cwd_a, db_raw))
        db_path_set = True

    cwd = get_cwd(app)
    if cwd:
        found_cwd = cwd

# CWD check: always performed — never defaults True without a canon_dir match
if cc_apps and canon_dir:
    cwd_match = all(
        os.path.normpath(get_cwd(a)) == os.path.normpath(canon_dir)
        for a in cc_apps if get_cwd(a)
    )
elif cc_apps and not canon_dir:
    # canon_dir was not derivable — report as unknown (False) so operator notices
    cwd_match = False
else:
    cwd_match = True  # no cc_apps at all — topology already fails on app_count

# Emit restart counts for delta comparison (keyed by app name)
app_restarts = {get_name(a): get_restart_count(a) for a in apps}

print(json.dumps({
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
    "cwd_ok":         cwd_match,
    "found_cwd":      found_cwd,
    "app_restarts":   app_restarts,
}))
PYEOF

  # -----------------------------------------------------------------------
  # Two-snapshot restart-count delta for crash-loop detection.
  # If PM2_CHECK_WINDOW == 0 we still take a real first snapshot but skip sleep.
  # Any app whose restart_count increased between snapshots is a crash-looper.
  # -----------------------------------------------------------------------
  _run_pm2_snapshot() {
    local label="$1"
    local raw
    raw=$(timeout 15 pm2 jlist 2>/dev/null || echo "[]")
    printf '%s\n' "$raw" \
      | python3 -s "$_PM2_SCRIPT" "$PORT" "$EFFECTIVE_CANON_DIR" "$label" 2>/dev/null \
      || echo '{"error":"pm2 analysis script failed","cc_apps":[],"crash_loopers":[],"db_path_set":false,"cwd_ok":false,"found_cwd":"","app_restarts":{}}'
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

  # Compute delta-based crash-loopers from the two snapshots
  DELTA_CRASHERS=$(python3 -s -c "
import sys, json
try:
  snap1 = json.loads(sys.argv[1])
  snap2 = json.loads(sys.argv[2])
  r1 = snap1.get('app_restarts') or {}
  r2 = snap2.get('app_restarts') or {}
  extra = []
  for name, rc2 in r2.items():
    rc1 = r1.get(name, rc2)
    if rc2 > rc1:
      extra.append({'name': name, 'reason': f'restart_count increased {rc1}->{rc2} during window', 'restart_count': rc2})
  print(json.dumps(extra))
except Exception as e:
  print('[]')
" "$SNAP1" "$SNAP2" 2>/dev/null || echo "[]")

  # Use SNAP2 as the authoritative topology source (most recent state)
  PM2_ANALYSIS="$SNAP2"

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
" "$PM2_ANALYSIS" "$DELTA_CRASHERS" 2>/dev/null || echo "$PM2_ANALYSIS")

  rm -f "$_PM2_SCRIPT"
  trap - EXIT

  # Parse results
  _pm2_field() {
    local field="$1" default="$2"
    printf '%s' "$PM2_ANALYSIS" \
      | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(d.get('${field}','${default}'))" \
      2>/dev/null || echo "$default"
  }

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
  _log "  Crash-loopers: ${PM2_CRASH_LOOPERS_JSON}"
  _log "  DATABASE_PATH set: ${PM2_DB_PATH_SET}"
  _log "  CWD ok: ${PM2_CWD_OK} (found: ${PM2_FOUND_CWD}, canonical: ${EFFECTIVE_CANON_DIR})"

  PM2_PASS="true"
  PM2_DETAIL="pm2 topology OK: 1 app on port ${PORT}, no crash-loopers, DATABASE_PATH set, cwd OK"

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
    PM2_DETAIL="Crash-looping or stopped app(s) detected: ${PM2_CRASH_LOOPERS_JSON}"
  elif [[ "$PM2_DB_PATH_SET" == "false" ]]; then
    PM2_PASS="false"
    PM2_DETAIL="DATABASE_PATH not explicitly set in pm2 env — cwd-drift silent-empty-DB risk (B.4)"
  elif [[ "$PM2_CWD_OK" == "false" ]]; then
    if [[ -n "$EFFECTIVE_CANON_DIR" ]]; then
      PM2_PASS="false"
      PM2_DETAIL="pm_cwd '${PM2_FOUND_CWD}' != canonical dir '${EFFECTIVE_CANON_DIR}'"
    else
      PM2_PASS="false"
      PM2_DETAIL="pm_cwd check: canonical dir could not be auto-derived — manual --canonical-dir required"
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
  # df -k gives 1024-byte blocks; column 4 = Available.
  AVAIL_KB=$(df -k "$DISK_CHECK_PATH" 2>/dev/null \
    | awk 'NR==2 {print $4}' || echo "0")
  DISK_FREE_GB=$(( ${AVAIL_KB:-0} / 1024 / 1024 ))

  _log "  Disk path: ${DISK_CHECK_PATH}"
  _log "  Free: ${DISK_FREE_GB}GB (threshold: ${DISK_MIN_GB}GB)"

  if [[ "$DISK_FREE_GB" -ge "$DISK_MIN_GB" ]]; then
    _mark "disk_headroom" "true" \
      "${DISK_FREE_GB}GB free on ${DISK_CHECK_PATH} (threshold ${DISK_MIN_GB}GB)" \
      "\"free_gb\":${DISK_FREE_GB},\"path\":\"$(_jstr "$DISK_CHECK_PATH")\",\"threshold_gb\":${DISK_MIN_GB}"
  else
    _mark "disk_headroom" "false" \
      "ONLY ${DISK_FREE_GB}GB free on ${DISK_CHECK_PATH} — below ${DISK_MIN_GB}GB build threshold" \
      "\"free_gb\":${DISK_FREE_GB},\"path\":\"$(_jstr "$DISK_CHECK_PATH")\",\"threshold_gb\":${DISK_MIN_GB}"
  fi
fi

###############################################################################
# Assemble output JSON
###############################################################################

ALL_PASS="true"
for k in http_root http_api_health static_assets company_name pm2_topology disk_headroom; do
  [[ "${CHECK_PASS[$k]:-false}" == "true" ]] || ALL_PASS="false"
done

TS=$(_iso8601)

build_check_json() {
  local key="$1"
  local pass="${CHECK_PASS[$key]:-false}"
  local detail="${CHECK_DETAIL[$key]:-not run}"
  local extra="${CHECK_EXTRA[$key]:-}"
  printf '"%s":{"pass":%s,"detail":"%s"%s}' \
    "$(_jstr "$key")" \
    "$pass" \
    "$(_jstr "$detail")" \
    "${extra:+,$extra}"
}

OUT='{'
OUT+='"green":'${ALL_PASS}','
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
OUT+='}}'

if [[ "$PRETTY" == "1" ]] && command -v python3 &>/dev/null; then
  printf '%s' "$OUT" | python3 -m json.tool
else
  printf '%s\n' "$OUT"
fi

###############################################################################
# Exit code
###############################################################################

if [[ "$ALL_PASS" == "true" ]]; then
  _log "RESULT: GREEN — all checks passed"
  exit 0
else
  _log "RESULT: NOT GREEN — one or more checks failed"
  exit 1
fi
