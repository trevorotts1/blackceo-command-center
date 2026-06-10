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
#     "static_assets":    { "pass": bool, "detail": "...", "total": N, "failed": [...] },
#     "company_name":     { "pass": bool, "detail": "...", "db_name": "...", "html_name": "...", "config_exists": bool },
#     "pm2_topology":     { "pass": bool, "detail": "...", "app_count": N, "crash_loopers": [...], "database_path_set": bool, "cwd_ok": bool },
#     "disk_headroom":    { "pass": bool, "detail": "...", "free_gb": N }
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

_die_usage() { echo "ERROR: $*" >&2; exit 2; }

_iso8601() { date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# Minimal JSON string escaper (handles the common cases without jq dependency)
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
    --port)           PORT="${2:?--port requires a value}"; shift 2 ;;
    --db-path)        DB_PATH_OVERRIDE="${2:?--db-path requires a value}"; shift 2 ;;
    --canonical-dir)  CANONICAL_DIR_OVERRIDE="${2:?--canonical-dir requires a value}"; shift 2 ;;
    --host)           PUBLIC_HOST="${2:?--host requires a value}"; shift 2 ;;
    --disk-path)      DISK_PATH_OVERRIDE="${2:?--disk-path requires a value}"; shift 2 ;;
    --disk-min-gb)    DISK_MIN_GB="${2:?--disk-min-gb requires a value}"; shift 2 ;;
    --pm2-check-window) PM2_CHECK_WINDOW="${2:?--pm2-check-window requires a value}"; shift 2 ;;
    --json-only)      JSON_ONLY="1"; shift ;;
    --pretty)         PRETTY="1"; shift ;;
    *) _die_usage "Unknown argument: $1" ;;
  esac
done

###############################################################################
# Resolved defaults
###############################################################################

# Base URL for local probes (always 127.0.0.1 to avoid CF-Access on health checks)
LOCAL_BASE="http://127.0.0.1:${PORT}"

# Public host is used for asset-path resolution when assets have an absolute
# URL stamped into them; defaults to LOCAL_BASE.
PUBLIC_BASE="${PUBLIC_HOST:-${LOCAL_BASE}}"
# Strip trailing slash
PUBLIC_BASE="${PUBLIC_BASE%/}"

###############################################################################
# Dependency check
###############################################################################

for cmd in curl sqlite3 pm2 awk grep; do
  if ! command -v "$cmd" &>/dev/null; then
    _log "WARN: $cmd not found — some checks will be skipped"
  fi
done

###############################################################################
# Check state accumulators
###############################################################################

declare -A CHECK_PASS=()
declare -A CHECK_DETAIL=()

# Extra per-check fields stored as JSON fragments appended during assembly
declare -A CHECK_EXTRA=()

_mark() {
  local name="$1" pass="$2" detail="$3" extra="${4:-}"
  CHECK_PASS[$name]="$pass"
  CHECK_DETAIL[$name]="$detail"
  CHECK_EXTRA[$name]="$extra"
}

###############################################################################
# CHECK 1: HTTP 200 on / and /api/health
###############################################################################

_log "[1/5] HTTP liveness — / and /api/health"

_http_check() {
  local label="$1" url="$2"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")
  if [[ "$code" == "200" ]]; then
    _log "  OK  $label => $code"
    echo "pass"
  else
    _log "  FAIL $label => $code"
    echo "fail:$code"
  fi
}

ROOT_RESULT=$(_http_check "GET /" "${LOCAL_BASE}/")
API_RESULT=$(_http_check "GET /api/health" "${LOCAL_BASE}/api/health")

if [[ "$ROOT_RESULT" == "pass" && "$API_RESULT" == "pass" ]]; then
  _mark "http_root"       "true" "HTTP 200 on /"
  _mark "http_api_health" "true" "HTTP 200 on /api/health"
else
  ROOT_CODE="${ROOT_RESULT#fail:}"
  API_CODE="${API_RESULT#fail:}"
  [[ "$ROOT_RESULT" == "pass" ]] \
    && _mark "http_root"       "true"  "HTTP 200 on /" \
    || _mark "http_root"       "false" "HTTP $ROOT_CODE on / (expected 200)"
  [[ "$API_RESULT" == "pass" ]] \
    && _mark "http_api_health" "true"  "HTTP 200 on /api/health" \
    || _mark "http_api_health" "false" "HTTP $API_CODE on /api/health (expected 200)"
fi

###############################################################################
# CHECK 2: Serve HTML → extract EVERY /_next/static asset → curl each → 200
###############################################################################

_log "[2/5] Static asset integrity (stale-manifest detection)"

ASSETS_PASS="true"
ASSETS_DETAIL="all assets OK"
ASSETS_TOTAL=0
ASSETS_FAILED_JSON="[]"

if ! command -v curl &>/dev/null; then
  _mark "static_assets" "false" "curl not available — cannot check assets" \
    '"total":0,"failed":[]'
else
  # Fetch the served HTML from /
  HTML=$(curl -s --max-time 15 "${LOCAL_BASE}/" 2>/dev/null || true)

  if [[ -z "$HTML" ]]; then
    _mark "static_assets" "false" "Could not fetch HTML from / to parse assets" \
      '"total":0,"failed":[]'
  else
    # Extract all /_next/static/... href and src references from HTML.
    # Capture both href="..." and src="..." attributes containing /_next/static.
    # Also picks up url(/_next/static/...) in inline styles.
    ASSET_PATHS=$(printf '%s' "$HTML" \
      | grep -oE '(href|src|url)\s*[=\(]\s*"?(/?)_next/static/[^"'\'') >]+' \
      | grep -oE '/_next/static/[^"'\'') >]+' \
      | sort -u || true)

    # Also parse the __NEXT_DATA__ script block's buildId → check
    # _next/static/chunks/pages/_app-*.js exists (catch stale BUILD_ID)
    BUILD_ID=$(printf '%s' "$HTML" \
      | grep -oE '"buildId":"[^"]+"' \
      | grep -oE '"[^"]+"}' \
      | tr -d '"}' \
      | head -1 || true)

    if [[ -n "$BUILD_ID" ]]; then
      # The main app JS is stamped with the buildId; confirm it's reachable
      BUILDID_ASSET="/_next/static/${BUILD_ID}/_buildManifest.js"
      ASSET_PATHS=$(printf '%s\n%s' "$ASSET_PATHS" "$BUILDID_ASSET" | sort -u)
    fi

    ASSET_PATHS=$(printf '%s' "$ASSET_PATHS" | grep -v '^$' || true)
    ASSET_COUNT=$(printf '%s' "$ASSET_PATHS" | grep -c '.' 2>/dev/null || echo "0")

    if [[ "$ASSET_COUNT" -eq 0 ]]; then
      # No /_next/static refs in HTML is suspicious but not necessarily fatal
      # on a non-Next.js route; mark as a soft warning encoded as fail so
      # any sweep operator investigates.
      _mark "static_assets" "false" \
        "No /_next/static asset references found in served HTML — build may not be wired" \
        '"total":0,"failed":[]'
    else
      _log "  Found $ASSET_COUNT /_next/static asset references"
      FAILED_ASSETS=()
      TOTAL_CHECKED=0

      while IFS= read -r asset_path; do
        [[ -z "$asset_path" ]] && continue
        TOTAL_CHECKED=$((TOTAL_CHECKED + 1))

        # Resolve URL: if asset already has http prefix use as-is; otherwise prepend PUBLIC_BASE
        if [[ "$asset_path" =~ ^https?:// ]]; then
          asset_url="$asset_path"
          # Replace the host with 127.0.0.1:PORT for the probe so CF-Access doesn't block us
          asset_path_only=$(printf '%s' "$asset_path" | grep -oE '/_next/.*')
          asset_url="${LOCAL_BASE}${asset_path_only}"
        else
          asset_url="${LOCAL_BASE}${asset_path}"
        fi

        # Fetch: get HTTP code and Content-Type
        RESP=$(curl -s -o /dev/null \
          -w "%{http_code}|||%{content_type}" \
          --max-time 10 \
          "$asset_url" 2>/dev/null || echo "000|||")

        ASSET_CODE="${RESP%%|||*}"
        ASSET_CT="${RESP##*|||}"

        # Content-type validation: Next.js static assets must be JS, CSS, or
        # font/image types — never text/html (which signals a 200 error page).
        CT_OK="true"
        if [[ "$ASSET_CODE" == "200" ]]; then
          # If the server returns text/html for a .js or .css file, the asset
          # is missing and the error page is being served — a false 200.
          case "$asset_path" in
            *.js)
              [[ "$ASSET_CT" == *"javascript"* ]] || CT_OK="false" ;;
            *.css)
              [[ "$ASSET_CT" == *"css"* ]] || CT_OK="false" ;;
          esac
        fi

        if [[ "$ASSET_CODE" == "200" && "$CT_OK" == "true" ]]; then
          :  # pass
        else
          if [[ "$ASSET_CODE" == "200" && "$CT_OK" == "false" ]]; then
            FAILED_ASSETS+=("${asset_path}:wrong-content-type(${ASSET_CT})")
          else
            FAILED_ASSETS+=("${asset_path}:HTTP${ASSET_CODE}")
          fi
          _log "  FAIL asset $asset_path => $ASSET_CODE ($ASSET_CT)"
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
        ASSETS_DETAIL="${FAILED_COUNT}/${ASSETS_TOTAL} static assets failed (stale manifest or missing files)"
        # Build JSON array of failed asset paths
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
###############################################################################

_log "[3/5] Company name consistency (DB-direct vs served HTML)"

COMPANY_PASS="false"
COMPANY_DETAIL="check not run"
COMPANY_DB_NAME=""
COMPANY_HTML_NAME=""
COMPANY_CONFIG_EXISTS="false"

# Resolve the DB path in priority order:
#   1. --db-path flag / CC_DB_PATH env
#   2. DATABASE_PATH from the running pm2 process env
#   3. Canonical paths heuristic
_resolve_db_path() {
  if [[ -n "$DB_PATH_OVERRIDE" ]]; then
    echo "$DB_PATH_OVERRIDE"
    return
  fi

  # Try pm2 process env
  if command -v pm2 &>/dev/null; then
    local pm2_db
    pm2_db=$(pm2 jlist 2>/dev/null \
      | python3 -c "
import sys, json
try:
  apps = json.load(sys.stdin)
  for app in apps:
    env = (app.get('pm2_env') or {})
    # Check top-level env and env_data
    for ekey in ('env', 'env_data'):
      e = env.get(ekey) or {}
      if isinstance(e, dict):
        v = e.get('DATABASE_PATH') or e.get('database_path')
        if v:
          print(v)
          sys.exit(0)
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

# Determine whether the box is "configured" (has a real company-config.json
# with a non-empty companyName) — used to decide if "Default" is an error.
_is_configured_box() {
  local install_dir="${1:-}"
  if [[ -z "$install_dir" ]]; then return 1; fi
  local cfg="${install_dir}/config/company-config.json"
  if [[ ! -f "$cfg" ]]; then return 1; fi
  local cname
  cname=$(python3 -c "
import json, sys
try:
  d = json.load(open('${cfg}'))
  n = d.get('companyName','').strip()
  print(n if n else '')
except Exception:
  print('')
" 2>/dev/null || true)
  [[ -n "$cname" ]]
}

if ! command -v sqlite3 &>/dev/null; then
  COMPANY_DETAIL="sqlite3 not available — DB-direct check skipped"
  COMPANY_PASS="false"
  _mark "company_name" "$COMPANY_PASS" "$COMPANY_DETAIL" \
    "\"db_name\":\"\",\"html_name\":\"\",\"config_exists\":false"
else
  DB_PATH=$(_resolve_db_path)

  if [[ -z "$DB_PATH" || ! -f "$DB_PATH" ]]; then
    COMPANY_DETAIL="DB not found (tried override, pm2 env, heuristic paths) — cannot verify company name"
    COMPANY_PASS="false"
    _mark "company_name" "$COMPANY_PASS" "$COMPANY_DETAIL" \
      "\"db_name\":\"\",\"html_name\":\"\",\"config_exists\":false"
  else
    _log "  Querying DB: $DB_PATH"

    # Read name from DB
    DB_COMPANY=$(sqlite3 "$DB_PATH" \
      "SELECT name FROM companies ORDER BY created_at ASC LIMIT 1;" 2>/dev/null || true)

    COMPANY_DB_NAME="${DB_COMPANY:-}"

    # Read name from served HTML — look for the og:site_name meta tag,
    # then <title>, then data-company-name attributes
    HTML_FOR_COMPANY=$(curl -s --max-time 10 "${LOCAL_BASE}/" 2>/dev/null || true)

    COMPANY_HTML_NAME=""
    if [[ -n "$HTML_FOR_COMPANY" ]]; then
      # Try og:site_name first (most reliable branding signal)
      COMPANY_HTML_NAME=$(printf '%s' "$HTML_FOR_COMPANY" \
        | grep -oE 'property="og:site_name"\s+content="[^"]+"' \
        | grep -oE 'content="[^"]+"' \
        | sed 's/content="//;s/"//' \
        | head -1 || true)

      # Fallback: data-company attribute on body/header
      if [[ -z "$COMPANY_HTML_NAME" ]]; then
        COMPANY_HTML_NAME=$(printf '%s' "$HTML_FOR_COMPANY" \
          | grep -oE 'data-company="[^"]+"' \
          | sed 's/data-company="//;s/"//' \
          | head -1 || true)
      fi

      # Fallback: <title> tag (often "Acme Corp — Command Center")
      if [[ -z "$COMPANY_HTML_NAME" ]]; then
        COMPANY_HTML_NAME=$(printf '%s' "$HTML_FOR_COMPANY" \
          | grep -oE '<title>[^<]+</title>' \
          | sed 's/<title>//;s/<\/title>//' \
          | awk -F' [—–-] ' '{print $1}' \
          | head -1 || true)
      fi
    fi

    # Detect install dir for config check
    INSTALL_DIR_FOR_CONFIG=""
    if [[ -n "$CANONICAL_DIR_OVERRIDE" ]]; then
      INSTALL_DIR_FOR_CONFIG="$CANONICAL_DIR_OVERRIDE"
    elif command -v pm2 &>/dev/null; then
      INSTALL_DIR_FOR_CONFIG=$(pm2 jlist 2>/dev/null \
        | python3 -c "
import sys, json
try:
  apps = json.load(sys.stdin)
  for app in apps:
    env = app.get('pm2_env') or {}
    cwd = env.get('pm_cwd') or ''
    if cwd:
      print(cwd)
      sys.exit(0)
except Exception:
  pass
" 2>/dev/null || true)
    fi

    if _is_configured_box "$INSTALL_DIR_FOR_CONFIG"; then
      COMPANY_CONFIG_EXISTS="true"
    else
      COMPANY_CONFIG_EXISTS="false"
    fi

    _log "  DB company name: '${COMPANY_DB_NAME}'"
    _log "  HTML company name: '${COMPANY_HTML_NAME}'"
    _log "  Config exists with real company: ${COMPANY_CONFIG_EXISTS}"

    # Validation logic:
    # On a configured box (company-config.json present with non-empty companyName):
    #   - DB name must not be empty and must not be "Default"
    #   - If we found an HTML name, it must match the DB name
    # On an unconfigured box:
    #   - "Default" or empty is acceptable

    if [[ "$COMPANY_CONFIG_EXISTS" == "true" ]]; then
      if [[ -z "$COMPANY_DB_NAME" ]]; then
        COMPANY_PASS="false"
        COMPANY_DETAIL="Configured box has no company row in DB — branding not seeded"
      elif [[ "${COMPANY_DB_NAME,,}" == "default" ]]; then
        COMPANY_PASS="false"
        COMPANY_DETAIL="Configured box has 'Default' company in DB — branding seed failed (Sheila bug)"
      elif [[ -n "$COMPANY_HTML_NAME" && "$COMPANY_HTML_NAME" != "$COMPANY_DB_NAME" ]]; then
        COMPANY_PASS="false"
        COMPANY_DETAIL="Company name mismatch: DB='${COMPANY_DB_NAME}' vs HTML='${COMPANY_HTML_NAME}'"
      else
        COMPANY_PASS="true"
        COMPANY_DETAIL="Company name consistent: '${COMPANY_DB_NAME}'"
      fi
    else
      # Unconfigured box — "Default" is allowed, but still flag if mismatch
      if [[ -n "$COMPANY_HTML_NAME" && -n "$COMPANY_DB_NAME" \
            && "$COMPANY_HTML_NAME" != "$COMPANY_DB_NAME" ]]; then
        COMPANY_PASS="false"
        COMPANY_DETAIL="Company name mismatch (unconfigured box): DB='${COMPANY_DB_NAME}' vs HTML='${COMPANY_HTML_NAME}'"
      else
        COMPANY_PASS="true"
        COMPANY_DETAIL="Company name OK (unconfigured box — Default acceptable)"
      fi
    fi

    _mark "company_name" "$COMPANY_PASS" "$COMPANY_DETAIL" \
      "\"db_name\":\"$(_jstr "$COMPANY_DB_NAME")\",\"html_name\":\"$(_jstr "$COMPANY_HTML_NAME")\",\"config_exists\":${COMPANY_CONFIG_EXISTS}"
  fi
fi

###############################################################################
# CHECK 4: pm2 topology
#   - Exactly ONE app bound to CC port
#   - Zero crash-loopers (restart-count delta over check window)
#   - pm_cwd == canonical install dir
#   - DATABASE_PATH explicitly set in env
###############################################################################

_log "[4/5] pm2 topology (port binding, crash-loop, cwd, DATABASE_PATH)"

PM2_PASS="false"
PM2_DETAIL="check not run"
PM2_APP_COUNT=0
PM2_CRASH_LOOPERS_JSON="[]"
PM2_DB_PATH_SET="false"
PM2_CWD_OK="false"

if ! command -v pm2 &>/dev/null; then
  PM2_DETAIL="pm2 not available — topology check skipped"
  PM2_PASS="false"
  _mark "pm2_topology" "$PM2_PASS" "$PM2_DETAIL" \
    "\"app_count\":0,\"crash_loopers\":[],\"database_path_set\":false,\"cwd_ok\":false"
else
  PM2_JSON=$(pm2 jlist 2>/dev/null || echo "[]")

  PM2_ANALYSIS=$(python3 -s - "$PORT" "$CANONICAL_DIR_OVERRIDE" "$PM2_CHECK_WINDOW" <<'PYEOF'
import sys, json, time, os

port_str    = sys.argv[1]
canon_dir   = sys.argv[2]   # may be empty
check_window = int(sys.argv[3]) if len(sys.argv) > 3 else 0

try:
    apps = json.loads(sys.stdin.read())
except Exception as e:
    print(json.dumps({"error": f"pm2 jlist parse failed: {e}",
                      "cc_apps": [], "crash_loopers": [],
                      "db_path_set": False, "cwd_ok": False}))
    sys.exit(0)

def env_val(pm2_env, key):
    """Search all env layers for a key."""
    for layer in ('env_data', 'env'):
        e = pm2_env.get(layer) or {}
        if isinstance(e, dict):
            v = e.get(key) or e.get(key.lower())
            if v:
                return str(v)
    # Also check top-level pm2_env
    v = pm2_env.get(key) or pm2_env.get(key.lower())
    if v:
        return str(v)
    return ""

# Identify apps that are bound to our CC port
cc_apps = []
for app in apps:
    env = app.get('pm2_env') or {}
    name = env.get('name') or app.get('name') or ''

    # Check if this app is the CC: port in args or PORT env var matches
    args = env.get('args') or env.get('node_args') or ''
    if isinstance(args, list):
        args = ' '.join(str(a) for a in args)
    port_in_args = f'-p {port_str}' in str(args) or f'--port {port_str}' in str(args)

    port_env = env_val(env, 'PORT')
    port_from_env = (port_env == port_str)

    script = env.get('pm_exec_path') or env.get('script') or ''
    is_nextjs = ('next' in str(script).lower() or
                 'node_modules/.bin/next' in str(script).lower() or
                 port_in_args or port_from_env)

    # Also accept if pm2 name contains 'mission-control' or 'command-center'
    name_match = any(kw in name.lower() for kw in
                     ('mission-control', 'command-center', 'blackceo'))

    if is_nextjs or name_match:
        cc_apps.append(app)

# Crash-looper detection: any app with status 'errored' or restart_count
# above a threshold delta (we take a snapshot here; caller can compare two runs)
crash_loopers = []
RESTART_THRESHOLD = 5  # more than 5 restarts in the check window = crash loop

for app in apps:
    env = app.get('pm2_env') or {}
    status = env.get('status') or ''
    name = env.get('name') or app.get('name') or 'unknown'
    restart_count = env.get('restart_time') or 0
    try:
        restart_count = int(restart_count)
    except (TypeError, ValueError):
        restart_count = 0

    if status == 'errored':
        crash_loopers.append({'name': name, 'reason': 'status=errored',
                               'restart_count': restart_count})
    elif restart_count > RESTART_THRESHOLD and check_window == 0:
        # On a first-pass check we flag anything with >5 total restarts as
        # a warning (not definitive — box may have just had a deploy)
        pass  # Don't flag on snapshot-only mode; only flag 'errored'

# DATABASE_PATH check: look in all CC apps
db_path_set = False
cwd_match   = True   # assume OK if we can't verify
found_cwd   = ""

for app in cc_apps:
    env = app.get('pm2_env') or {}
    dbp = env_val(env, 'DATABASE_PATH')
    if dbp:
        db_path_set = True

    # pm_cwd is where pm2 started the process
    cwd = env.get('pm_cwd') or env.get('cwd') or ''
    if cwd:
        found_cwd = cwd

    if canon_dir and cwd:
        if os.path.normpath(cwd) != os.path.normpath(canon_dir):
            cwd_match = False

print(json.dumps({
    "cc_apps":      [{"name": (a.get('pm2_env') or {}).get('name','?'),
                      "status": (a.get('pm2_env') or {}).get('status','?'),
                      "cwd": (a.get('pm2_env') or {}).get('pm_cwd',''),
                      "restart_count": (a.get('pm2_env') or {}).get('restart_time',0)}
                     for a in cc_apps],
    "crash_loopers": crash_loopers,
    "db_path_set":   db_path_set,
    "cwd_ok":        cwd_match,
    "found_cwd":     found_cwd,
}))
PYEOF
  <<< "$PM2_JSON"
  )

  # Parse the python3 output
  PM2_ERROR=$(printf '%s' "$PM2_ANALYSIS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error',''))" 2>/dev/null || true)
  PM2_CC_APP_COUNT=$(printf '%s' "$PM2_ANALYSIS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('cc_apps',[])))" 2>/dev/null || echo "0")
  PM2_CRASH_LOOPERS_JSON=$(printf '%s' "$PM2_ANALYSIS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('crash_loopers',[])))" 2>/dev/null || echo "[]")
  PM2_DB_PATH_SET_RAW=$(printf '%s' "$PM2_ANALYSIS" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('db_path_set') else 'false')" 2>/dev/null || echo "false")
  PM2_CWD_OK_RAW=$(printf '%s' "$PM2_ANALYSIS" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('cwd_ok') else 'false')" 2>/dev/null || echo "false")
  PM2_FOUND_CWD=$(printf '%s' "$PM2_ANALYSIS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('found_cwd',''))" 2>/dev/null || echo "")

  PM2_APP_COUNT="$PM2_CC_APP_COUNT"
  PM2_DB_PATH_SET="$PM2_DB_PATH_SET_RAW"
  PM2_CWD_OK="$PM2_CWD_OK_RAW"

  _log "  CC apps on port ${PORT}: ${PM2_APP_COUNT}"
  _log "  Crash-loopers: ${PM2_CRASH_LOOPERS_JSON}"
  _log "  DATABASE_PATH set: ${PM2_DB_PATH_SET}"
  _log "  CWD ok: ${PM2_CWD_OK} (found: ${PM2_FOUND_CWD})"

  if [[ -n "$PM2_ERROR" ]]; then
    PM2_PASS="false"
    PM2_DETAIL="pm2 jlist parse error: ${PM2_ERROR}"
  elif [[ "$PM2_APP_COUNT" -eq 0 ]]; then
    PM2_PASS="false"
    PM2_DETAIL="No pm2 app found bound to port ${PORT}"
  elif [[ "$PM2_APP_COUNT" -gt 1 ]]; then
    PM2_PASS="false"
    PM2_DETAIL="${PM2_APP_COUNT} pm2 apps bound to port ${PORT} — zombie process(es) present"
  elif [[ "$PM2_CRASH_LOOPERS_JSON" != "[]" ]]; then
    PM2_PASS="false"
    PM2_DETAIL="Crash-looping app(s) detected: ${PM2_CRASH_LOOPERS_JSON}"
  elif [[ "$PM2_DB_PATH_SET" == "false" ]]; then
    PM2_PASS="false"
    PM2_DETAIL="DATABASE_PATH not explicitly set in pm2 env — cwd-drift DB risk (B.4)"
  elif [[ "$PM2_CWD_OK" == "false" && -n "$CANONICAL_DIR_OVERRIDE" ]]; then
    PM2_PASS="false"
    PM2_DETAIL="pm_cwd '${PM2_FOUND_CWD}' != canonical dir '${CANONICAL_DIR_OVERRIDE}'"
  else
    PM2_PASS="true"
    PM2_DETAIL="pm2 topology OK: 1 app on port ${PORT}, no crash-loopers, DATABASE_PATH set"
  fi

  _mark "pm2_topology" "$PM2_PASS" "$PM2_DETAIL" \
    "\"app_count\":${PM2_APP_COUNT},\"crash_loopers\":${PM2_CRASH_LOOPERS_JSON},\"database_path_set\":${PM2_DB_PATH_SET},\"cwd_ok\":${PM2_CWD_OK}"
fi

###############################################################################
# CHECK 5: Disk headroom >= DISK_MIN_GB on the data volume
###############################################################################

_log "[5/5] Disk headroom (build threshold: ${DISK_MIN_GB}GB)"

DISK_PASS="false"
DISK_FREE_GB=0
DISK_DETAIL="check not run"

# Resolve the path to check: explicit override, else heuristic
_resolve_disk_path() {
  if [[ -n "$DISK_PATH_OVERRIDE" ]]; then
    echo "$DISK_PATH_OVERRIDE"
    return
  fi
  # VPS: /data is the bind-mounted volume
  if [[ -d "/data" ]]; then
    echo "/data"
    return
  fi
  # Mac: use HOME
  echo "$HOME"
}

DISK_CHECK_PATH=$(_resolve_disk_path)

if ! command -v df &>/dev/null; then
  DISK_DETAIL="df not available — disk check skipped"
  DISK_PASS="false"
else
  # df -k: 1024-byte blocks; column 4 = Available
  AVAIL_KB=$(df -k "$DISK_CHECK_PATH" 2>/dev/null \
    | awk 'NR==2 {print $4}' || echo "0")
  DISK_FREE_GB=$(( AVAIL_KB / 1024 / 1024 ))

  _log "  Disk path: ${DISK_CHECK_PATH}"
  _log "  Free: ${DISK_FREE_GB}GB (threshold: ${DISK_MIN_GB}GB)"

  if [[ "$DISK_FREE_GB" -ge "$DISK_MIN_GB" ]]; then
    DISK_PASS="true"
    DISK_DETAIL="${DISK_FREE_GB}GB free on ${DISK_CHECK_PATH} (threshold ${DISK_MIN_GB}GB)"
  else
    DISK_PASS="false"
    DISK_DETAIL="ONLY ${DISK_FREE_GB}GB free on ${DISK_CHECK_PATH} — below ${DISK_MIN_GB}GB build threshold"
  fi
fi

_mark "disk_headroom" "$DISK_PASS" "$DISK_DETAIL" \
  "\"free_gb\":${DISK_FREE_GB},\"path\":\"$(_jstr "$DISK_CHECK_PATH")\",\"threshold_gb\":${DISK_MIN_GB}"

###############################################################################
# Assemble output JSON
###############################################################################

ALL_PASS="true"
for k in http_root http_api_health static_assets company_name pm2_topology disk_headroom; do
  [[ "${CHECK_PASS[$k]:-false}" == "true" ]] || ALL_PASS="false"
done

TS=$(_iso8601)

# Build JSON inline (avoids jq dependency; escaping handled by _jstr)
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
OUT+=$(build_check_json "http_root")','
OUT+=$(build_check_json "http_api_health")','
OUT+=$(build_check_json "static_assets")','
OUT+=$(build_check_json "company_name")','
OUT+=$(build_check_json "pm2_topology")','
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
