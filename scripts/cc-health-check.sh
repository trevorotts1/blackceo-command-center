#!/usr/bin/env bash
# cc-health-check.sh — THE single definition of "green" for a deployed
# BlackCEO Command Center instance.
#
# PRD Addendum B, item B.1 (P0)
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
#   --canonical-dir DIR    Canonical install directory         (default: auto-detect from pm2)
#   --host HOST            Public hostname/URL for asset fetch  (default: http://127.0.0.1:PORT)
#   --disk-path PATH       Path to check for disk headroom     (default: data-volume heuristic)
#   --disk-min-gb N        Minimum free GB required            (default: 5)
#   --pm2-check-window N   Seconds between restart-count snap  (default: 0 = snapshot-only)
#   --json-only            Suppress all stderr progress lines
#   --pretty               Pretty-print the JSON output
#
# Env-var equivalents (lower priority than flags):
#   CC_PORT, CC_DB_PATH, CC_CANONICAL_DIR, CC_PUBLIC_HOST,
#   CC_DISK_PATH, CC_DISK_MIN_GB, CC_PM2_CHECK_WINDOW
#
# CONSUMED BY
# -----------
#   scripts/deploy.sh (B.2)          — post-restart verification + auto-rollback trigger
#   fleet-refresh verification        — B.2 canary gate
#   Sunday cron                       — B.1 weekly fleet sweep
#   watchdogs                         — continuous crash detection
#   Any sweep script                  — stop writing your own green signature; call this

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
PM2_CHECK_WINDOW="${CC_PM2_CHECK_WINDOW:-0}"
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
# Dependency check
###############################################################################

for cmd in curl sqlite3 pm2 awk grep python3 df; do
  if ! command -v "$cmd" &>/dev/null; then
    _log "WARN: $cmd not found — some checks will be skipped"
  fi
done

###############################################################################
# Check state accumulators
###############################################################################

# Using parallel arrays instead of declare -A for bash 3.x compatibility on
# macOS system bash (3.2), though fleet VPS boxes run bash 4+.
CHECK_KEYS=()
declare -A CHECK_PASS=()
declare -A CHECK_DETAIL=()
declare -A CHECK_EXTRA=()

_mark() {
  local name="$1" pass="$2" detail="$3" extra="${4:-}"
  CHECK_PASS["$name"]="$pass"
  CHECK_DETAIL["$name"]="$detail"
  CHECK_EXTRA["$name"]="$extra"
  # Track order
  for k in "${CHECK_KEYS[@]:-}"; do
    [[ "$k" == "$name" ]] && return
  done
  CHECK_KEYS+=("$name")
}

###############################################################################
# CHECK 1: HTTP 200 on / and /api/health
###############################################################################

_log "[1/5] HTTP liveness — / and /api/health"

_http_check() {
  local label="$1" url="$2"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")
  # Normalize to decimal integer to handle curl's "000000" on connection-refused
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
###############################################################################

_log "[2/5] Static asset integrity (stale-manifest detection)"

if ! command -v curl &>/dev/null; then
  _mark "static_assets" "false" "curl not available — cannot check assets" \
    '"total":0,"failed":[]'
else
  # Fetch the served HTML from / via 127.0.0.1 so CF-Access cannot block the probe
  HTML=$(curl -s --max-time 15 "${LOCAL_BASE}/" 2>/dev/null || true)

  if [[ -z "$HTML" ]]; then
    _mark "static_assets" "false" "Could not fetch HTML from / to parse assets" \
      '"total":0,"failed":[]'
  else
    # Extract all /_next/static/... href, src, and url() references from HTML.
    # The pattern covers: href="/....", src="/_next...", url(/_next...),
    # and JSON-embedded paths like "src":"/_next/...".
    ASSET_PATHS=$(printf '%s' "$HTML" \
      | grep -oE '/_next/static/[^"'"'"') >\\]+' \
      | grep -v '^[[:space:]]*$' \
      | sort -u || true)

    # Also extract the buildId from __NEXT_DATA__ and probe the _buildManifest.js.
    # This is the critical catch: a stale buildId means the manifest hash on disk
    # no longer matches what the server serves in the HTML.
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
      _log "  Found $ASSET_COUNT /_next/static asset references"
      FAILED_ASSETS=()
      TOTAL_CHECKED=0

      while IFS= read -r asset_path; do
        [[ -z "$asset_path" ]] && continue
        TOTAL_CHECKED=$((TOTAL_CHECKED + 1))

        # Always probe via 127.0.0.1:PORT regardless of how the path was stamped.
        # If the path has an absolute URL, extract just the path component.
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
###############################################################################

_log "[3/5] Company name consistency (DB-direct vs served HTML)"

# Resolve the DB path in priority order:
#   1. --db-path flag / CC_DB_PATH env
#   2. DATABASE_PATH from the running pm2 process env
#   3. Canonical paths heuristic
_resolve_db_path() {
  if [[ -n "$DB_PATH_OVERRIDE" ]]; then
    echo "$DB_PATH_OVERRIDE"
    return
  fi

  # Try pm2 process env (pipe pm2 output through python3)
  if command -v pm2 &>/dev/null && command -v python3 &>/dev/null; then
    local pm2_raw pm2_db
    pm2_raw=$(pm2 jlist 2>/dev/null || echo "[]")
    pm2_db=$(printf '%s\n' "$pm2_raw" | python3 -s -c "
import sys, json
try:
  apps = json.load(sys.stdin)
  for app in apps:
    env = app.get('pm2_env') or {}
    for ekey in ('env_data', 'env'):
      e = env.get(ekey) or {}
      if isinstance(e, dict):
        v = e.get('DATABASE_PATH') or e.get('database_path')
        if v:
          print(v)
          raise SystemExit(0)
    v = env.get('DATABASE_PATH') or env.get('database_path')
    if v:
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
  for candidate in \
      "${HOME}/projects/command-center/mission-control.db" \
      "/data/projects/command-center/mission-control.db" \
      "/data/mission-control/mission-control.db" \
      "${HOME}/projects/mission-control/mission-control.db"; do
    if [[ -f "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done

  echo ""
}

# Determine whether the box has a real company-config.json with a non-empty companyName.
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

    # Read name from DB — first non-null row by created_at
    DB_COMPANY=$(sqlite3 "$DB_PATH" \
      "SELECT name FROM companies WHERE name IS NOT NULL AND name != '' ORDER BY created_at ASC LIMIT 1;" \
      2>/dev/null || true)
    # Fallback: any row
    if [[ -z "$DB_COMPANY" ]]; then
      DB_COMPANY=$(sqlite3 "$DB_PATH" \
        "SELECT name FROM companies ORDER BY created_at ASC LIMIT 1;" \
        2>/dev/null || true)
    fi
    COMPANY_DB_NAME="${DB_COMPANY:-}"

    # Read name from served HTML.
    # Strategy: try og:site_name (order-independent), data-company, then <title>.
    HTML_FOR_COMPANY=$(curl -s --max-time 10 "${LOCAL_BASE}/" 2>/dev/null || true)

    COMPANY_HTML_NAME=""
    if [[ -n "$HTML_FOR_COMPANY" ]]; then
      # og:site_name — handle both attribute orderings (property= before or after content=)
      COMPANY_HTML_NAME=$(printf '%s' "$HTML_FOR_COMPANY" \
        | grep -oiE '<meta[^>]*og:site_name[^>]*>' \
        | grep -oiE 'content="[^"]+"' \
        | sed 's/[Cc]ontent="//;s/"//' \
        | head -1 || true)

      # Fallback: data-company attribute on any element
      if [[ -z "$COMPANY_HTML_NAME" ]]; then
        COMPANY_HTML_NAME=$(printf '%s' "$HTML_FOR_COMPANY" \
          | grep -oE 'data-company="[^"]+"' \
          | sed 's/data-company="//;s/"//' \
          | head -1 || true)
      fi

      # Fallback: <title> tag — strip the " — Command Center" / " - Dashboard" suffix
      if [[ -z "$COMPANY_HTML_NAME" ]]; then
        COMPANY_HTML_NAME=$(printf '%s' "$HTML_FOR_COMPANY" \
          | grep -oE '<title>[^<]+</title>' \
          | sed 's/<title>//;s/<\/title>//' \
          | awk -F' [—–|-] ' '{print $1}' \
          | head -1 || true)
      fi
    fi

    # Resolve install dir for config check
    INSTALL_DIR_FOR_CONFIG=""
    if [[ -n "$CANONICAL_DIR_OVERRIDE" ]]; then
      INSTALL_DIR_FOR_CONFIG="$CANONICAL_DIR_OVERRIDE"
    elif command -v pm2 &>/dev/null && command -v python3 &>/dev/null; then
      PM2_RAW_FOR_CONFIG=$(pm2 jlist 2>/dev/null || echo "[]")
      INSTALL_DIR_FOR_CONFIG=$(printf '%s\n' "$PM2_RAW_FOR_CONFIG" | python3 -s -c "
import sys, json
try:
  apps = json.load(sys.stdin)
  for app in apps:
    env = app.get('pm2_env') or {}
    cwd = env.get('pm_cwd') or env.get('cwd') or ''
    if cwd:
      print(cwd)
      raise SystemExit(0)
except SystemExit:
  pass
except Exception:
  pass
" 2>/dev/null || true)
    fi

    CONFIG_COMPANY_NAME=$(_get_config_company_name "$INSTALL_DIR_FOR_CONFIG")
    if [[ -n "$CONFIG_COMPANY_NAME" ]]; then
      COMPANY_CONFIG_EXISTS="true"
    else
      COMPANY_CONFIG_EXISTS="false"
    fi

    _log "  DB company name:   '${COMPANY_DB_NAME}'"
    _log "  HTML company name: '${COMPANY_HTML_NAME}'"
    _log "  Config exists (non-empty name): ${COMPANY_CONFIG_EXISTS}"

    # Validation:
    # Configured box (company-config.json with non-empty companyName):
    #   - DB must have a non-empty name
    #   - DB name must not be "Default" (case-insensitive)
    #   - If HTML name found, it must match DB name
    # Unconfigured box:
    #   - "Default" is allowed
    #   - If both names found they must still match

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
#   - Zero crash-loopers (errored status OR high restart-count delta over window)
#   - pm_cwd == canonical install dir (when --canonical-dir set)
#   - DATABASE_PATH explicitly set in env (B.4 pin)
###############################################################################

_log "[4/5] pm2 topology (port binding, crash-loop, cwd, DATABASE_PATH)"

if ! command -v pm2 &>/dev/null; then
  _mark "pm2_topology" "false" "pm2 not available — topology check skipped" \
    '"app_count":0,"crash_loopers":[],"database_path_set":false,"cwd_ok":false'
elif ! command -v python3 &>/dev/null; then
  _mark "pm2_topology" "false" "python3 not available — pm2 topology analysis skipped" \
    '"app_count":0,"crash_loopers":[],"database_path_set":false,"cwd_ok":false'
else
  PM2_JSON=$(pm2 jlist 2>/dev/null || echo "[]")

  # FIX: pipe PM2_JSON to python3 via stdin (printf | python3), with the Python
  # script sourced from a temp file. This avoids the heredoc+herestring conflict
  # where bash would feed the heredoc as stdin to python3 and the <<< herestring
  # would be ignored or vice versa — both cannot redirect the same fd simultaneously.
  _PM2_SCRIPT=$(mktemp /tmp/cc-pm2-check-XXXXXX.py)
  trap 'rm -f "$_PM2_SCRIPT"' EXIT

  cat > "$_PM2_SCRIPT" << 'PYEOF'
import sys
import json
import os

port_str     = sys.argv[1]
canon_dir    = sys.argv[2]   # may be empty string
check_window = int(sys.argv[3]) if len(sys.argv) > 3 else 0

# Configurable: apps with restart_time above this threshold (and status != 'online')
# are flagged as crash-loopers even without a delta window.
RESTART_CRASH_THRESHOLD = 10

try:
    apps = json.load(sys.stdin)
except Exception as e:
    print(json.dumps({
        "error": f"pm2 jlist parse failed: {e}",
        "cc_apps": [], "crash_loopers": [],
        "db_path_set": False, "cwd_ok": False, "found_cwd": ""
    }))
    sys.exit(0)


def env_val(pm2_env, key):
    """Search all env layers for a key (case-sensitive then case-lower fallback)."""
    for layer in ('env_data', 'env'):
        e = pm2_env.get(layer) or {}
        if isinstance(e, dict):
            v = e.get(key) or e.get(key.lower())
            if v:
                return str(v)
    # Also check direct pm2_env keys
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


# Identify apps bound to the CC port.
# Matching rules (any one sufficient):
#   a) PORT env var == port_str
#   b) app was started with -p <port> or --port <port> in its args
#   c) pm2 app name contains mission-control, command-center, or blackceo
# We do NOT use "next in script path" alone because that would match any Next.js app.
cc_apps = []
for app in apps:
    env = app.get('pm2_env') or {}
    name = get_name(app).lower()

    port_env = env_val(env, 'PORT')
    port_from_env = (port_env == port_str)

    args = env.get('args') or env.get('node_args') or ''
    if isinstance(args, list):
        args = ' '.join(str(a) for a in args)
    port_in_args = (f'-p {port_str}' in str(args) or
                    f'--port {port_str}' in str(args))

    name_match = any(kw in name for kw in
                     ('mission-control', 'command-center', 'blackceo'))

    if port_from_env or port_in_args or name_match:
        cc_apps.append(app)

# Crash-looper detection across ALL pm2 apps (not just cc_apps):
#   1. status == 'errored'  — definitive crash
#   2. status != 'online' AND restart_time > RESTART_CRASH_THRESHOLD — unstable
# The "restart-delta over a window" feature: if check_window > 0, the caller
# should run this script twice separated by check_window seconds and compare
# the restart_count fields. For a single-shot health check (check_window == 0)
# we flag definitively errored apps only, plus high-restart-count non-online apps.
crash_loopers = []
for app in apps:
    name   = get_name(app)
    status = get_status(app)
    rc     = get_restart_count(app)

    if status == 'errored':
        crash_loopers.append({
            'name': name,
            'reason': 'status=errored',
            'restart_count': rc
        })
    elif status not in ('online', 'launching', '') and rc > RESTART_CRASH_THRESHOLD:
        crash_loopers.append({
            'name': name,
            'reason': f'status={status} with restart_count={rc} > {RESTART_CRASH_THRESHOLD}',
            'restart_count': rc
        })

# Per-app checks on cc_apps: DATABASE_PATH set, pm_cwd matches canonical dir
db_path_set = False
cwd_match   = True   # assume OK when canonical dir not specified
found_cwd   = ""

for app in cc_apps:
    env = app.get('pm2_env') or {}
    if env_val(env, 'DATABASE_PATH'):
        db_path_set = True

    cwd = env.get('pm_cwd') or env.get('cwd') or ''
    if cwd:
        found_cwd = cwd

    if canon_dir and cwd:
        if os.path.normpath(cwd) != os.path.normpath(canon_dir):
            cwd_match = False

print(json.dumps({
    "cc_apps": [
        {
            "name":          get_name(a),
            "status":        get_status(a),
            "cwd":           (a.get('pm2_env') or {}).get('pm_cwd', ''),
            "restart_count": get_restart_count(a),
        }
        for a in cc_apps
    ],
    "crash_loopers":  crash_loopers,
    "db_path_set":    db_path_set,
    "cwd_ok":         cwd_match,
    "found_cwd":      found_cwd,
}))
PYEOF

  PM2_ANALYSIS=$(printf '%s\n' "$PM2_JSON" | python3 -s "$_PM2_SCRIPT" "$PORT" "$CANONICAL_DIR_OVERRIDE" "$PM2_CHECK_WINDOW" 2>/dev/null || echo '{"error":"pm2 analysis script failed","cc_apps":[],"crash_loopers":[],"db_path_set":false,"cwd_ok":false,"found_cwd":""}')
  rm -f "$_PM2_SCRIPT"
  trap - EXIT

  # Parse results
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
  _log "  CWD ok: ${PM2_CWD_OK} (found: ${PM2_FOUND_CWD})"

  PM2_PASS="true"
  PM2_DETAIL="pm2 topology OK: 1 app on port ${PORT}, no crash-loopers, DATABASE_PATH set"

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
    PM2_DETAIL="Crash-looping app(s) detected: ${PM2_CRASH_LOOPERS_JSON}"
  elif [[ "$PM2_DB_PATH_SET" == "false" ]]; then
    PM2_PASS="false"
    PM2_DETAIL="DATABASE_PATH not explicitly set in pm2 env — cwd-drift silent-empty-DB risk (B.4)"
  elif [[ "$PM2_CWD_OK" == "false" && -n "$CANONICAL_DIR_OVERRIDE" ]]; then
    PM2_PASS="false"
    PM2_DETAIL="pm_cwd '${PM2_FOUND_CWD}' != canonical dir '${CANONICAL_DIR_OVERRIDE}'"
  fi

  _mark "pm2_topology" "$PM2_PASS" "$PM2_DETAIL" \
    "\"app_count\":${PM2_APP_COUNT},\"crash_loopers\":${PM2_CRASH_LOOPERS_JSON},\"database_path_set\":${PM2_DB_PATH_SET},\"cwd_ok\":${PM2_CWD_OK}"
fi

###############################################################################
# CHECK 5: Disk headroom >= DISK_MIN_GB on the data volume
###############################################################################

_log "[5/5] Disk headroom (build threshold: ${DISK_MIN_GB}GB)"

# Resolve the path to check: explicit override, then VPS heuristic, then HOME
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
  # Works on both Linux and macOS (POSIX df).
  AVAIL_KB=$(df -k "$DISK_CHECK_PATH" 2>/dev/null \
    | awk 'NR==2 {print $4}' || echo "0")
  # Convert KB to GB using integer arithmetic; minimum 0
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
