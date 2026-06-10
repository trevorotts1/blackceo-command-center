#!/usr/bin/env bash
# cc-health-check.sh — THE single definition of "green" for a deployed
# BlackCEO Command Center instance.  PRD Addendum B.1 (P0).
#
# ARCHITECTURE (§5 guidance):
#   This script is intentionally thin (~100 lines).  All app-checkable logic
#   (asset-manifest, DB branding, migrations, disk) lives in /api/health/deep.
#   This script handles only the two things the app CANNOT self-report:
#     (a) pm2 topology — process manager is outside the app's process space
#     (b) outside-in asset probe — proves the RUNNING server serves the on-disk
#         build (the app proved manifest-vs-disk; this proves served-vs-disk)
#
# EXIT CONTRACT (callers MUST honour all three codes):
#   0 = green  (all checks pass)
#   1 = red    (definitive failure — caller may rollback)
#   3 = indeterminate/UNKNOWN (transient: DB busy, server starting, exit 3 from
#       /api/health/deep).  Callers MUST NOT rollback on 3; sleep+retry instead.
#   2 = usage error
#
# USAGE
#   bash scripts/cc-health-check.sh [--port N] [--canonical-dir DIR]
#                                   [--disk-min-gb N] [--json-only]
#
# CF-REDIRECT GUARD: curl uses --max-redirs 0 so a CF redirect to login
# is detected as a non-200 rather than silently followed.

set -uo pipefail

# ── defaults ─────────────────────────────────────────────────────────────────
PORT="${CC_PORT:-4000}"
CANONICAL_DIR="${CC_CANONICAL_DIR:-}"
DISK_MIN_GB="${CC_DISK_MIN_GB:-0.5}"
JSON_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)          PORT="$2";          shift 2 ;;
    --canonical-dir) CANONICAL_DIR="$2"; shift 2 ;;
    --disk-min-gb)   DISK_MIN_GB="$2";   shift 2 ;;
    --json-only)     JSON_ONLY=1;        shift   ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

BASE_URL="http://127.0.0.1:${PORT}"
log() { [[ "$JSON_ONLY" -eq 0 ]] && printf '[cc-health] %s\n' "$*" >&2 || true; }

# ── (a) curl /api/health/deep and relay its verdict ──────────────────────────
log "Probing /api/health/deep on port ${PORT}..."

DEEP_RAW=$(curl --silent --max-time 15 --max-redirs 0 \
  --write-out '\n{"_http_code":%{http_code}}' \
  "${BASE_URL}/api/health/deep" 2>/dev/null || echo '{"_error":"curl_failed"}')

# Separate body from the appended http_code line
DEEP_BODY=$(printf '%s' "$DEEP_RAW" | head -n -1)
HTTP_LINE=$(printf '%s' "$DEEP_RAW" | tail -n 1)
HTTP_CODE=$(printf '%s' "$HTTP_LINE" | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(d.get('_http_code',0))" 2>/dev/null || echo 0)

if [[ "$HTTP_CODE" == "0" ]]; then
  # Connection refused / timeout — server may be starting (UNKNOWN)
  log "UNKNOWN: server unreachable on port ${PORT} (connection refused or curl failed)"
  printf '{"pass":false,"indeterminate":true,"timestamp":"%s","checks":{},"source":"cc-health-check.sh","detail":"server unreachable on port %s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PORT"
  exit 3
fi

if [[ "$HTTP_CODE" != "200" ]]; then
  log "FAIL: /api/health/deep returned HTTP ${HTTP_CODE}"
  printf '{"pass":false,"indeterminate":false,"timestamp":"%s","checks":{},"source":"cc-health-check.sh","detail":"HTTP %s from /api/health/deep"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$HTTP_CODE"
  exit 1
fi

# Parse /api/health/deep verdict
DEEP_PASS=$(printf '%s' "$DEEP_BODY" | python3 -s -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('pass') else 'false')" 2>/dev/null || echo "false")
DEEP_INDET=$(printf '%s' "$DEEP_BODY" | python3 -s -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('indeterminate') else 'false')" 2>/dev/null || echo "false")

if [[ "$DEEP_INDET" == "true" ]]; then
  log "UNKNOWN: /api/health/deep reports indeterminate (transient condition)"
  printf '%s\n' "$DEEP_BODY"
  exit 3
fi

if [[ "$DEEP_PASS" != "true" ]]; then
  log "FAIL: /api/health/deep reports not-green"
  printf '%s\n' "$DEEP_BODY"
  exit 1
fi

log "/api/health/deep: PASS"

# ── (b1) pm2 topology — CC-scoped, proven Python from donor PR #78 ────────────
log "Checking pm2 topology (CC-scoped)..."

if ! command -v pm2 &>/dev/null || ! command -v python3 &>/dev/null; then
  log "WARN: pm2 or python3 unavailable — topology check skipped"
  PM2_PASS="skip"
else
  PM2_RAW=$(pm2 jlist 2>/dev/null || echo "[]")

  PM2_JSON=$(printf '%s\n' "$PM2_RAW" | python3 -s -c "
import sys, json, os, re

port_str   = sys.argv[1]
canon_dir  = sys.argv[2] if len(sys.argv) > 2 else ''

def env_val(env, key):
    for layer in ('env_data', 'env'):
        e = env.get(layer) or {}
        if isinstance(e, dict):
            v = e.get(key) or e.get(key.lower())
            if v: return str(v)
    v = env.get(key) or env.get(key.lower())
    return str(v) if v else ''

def port_matches(app, p):
    env = app.get('pm2_env') or {}
    if env_val(env, 'PORT') == p: return True
    args = env.get('args') or ''
    if isinstance(args, list): args = ' '.join(str(a) for a in args)
    if re.search(r'(?:^|\s)-p\s+' + re.escape(p) + r'(?:\s|\$)', str(args)): return True
    if re.search(r'--port\s+' + re.escape(p) + r'(?!\d)', str(args)):        return True
    return False

def name_matches(app, p):
    env = app.get('pm2_env') or {}
    name = (env.get('name') or app.get('name') or '').lower()
    if not any(kw in name for kw in ('mission-control', 'command-center', 'blackceo')): return False
    pe = env_val(env, 'PORT')
    return not (pe and pe != p)

def get_cwd(app):
    env = app.get('pm2_env') or {}
    return env.get('pm_cwd') or env.get('cwd') or ''

try:
    apps  = json.loads(sys.stdin.read()) or []
    cc    = [a for a in apps if port_matches(a, port_str) or name_matches(a, port_str)]
    crash = []
    for a in cc:
        env    = a.get('pm2_env') or {}
        status = env.get('status') or ''
        rc     = int(env.get('restart_time') or 0)
        name   = env.get('name') or a.get('name') or 'unknown'
        if status in ('errored', 'stopped'):
            crash.append({'name': name, 'reason': f'status={status}', 'restart_count': rc})
    db_set = any(env_val(a.get('pm2_env') or {}, 'DATABASE_PATH') for a in cc)
    if cc and canon_dir:
        cwd_ok = all(os.path.normpath(get_cwd(a)) == os.path.normpath(canon_dir) for a in cc)
    elif cc and not canon_dir:
        cwd_ok = False
    else:
        cwd_ok = False
    null_cwd = [a for a in cc if not get_cwd(a)]
    if null_cwd:
        cwd_ok = False
    print(json.dumps({'app_count': len(cc), 'crash_loopers': crash,
                      'db_path_set': db_set, 'cwd_ok': cwd_ok}))
except Exception as e:
    print(json.dumps({'error': str(e), 'app_count': 0, 'crash_loopers': [],
                      'db_path_set': False, 'cwd_ok': False}))
" "$PORT" "$CANONICAL_DIR" 2>/dev/null || echo '{"error":"pm2 python failed","app_count":0,"crash_loopers":[],"db_path_set":false,"cwd_ok":false}')

  PM2_COUNT=$(printf '%s' "$PM2_JSON" | python3 -s -c "import sys,json; print(json.load(sys.stdin).get('app_count',0))" 2>/dev/null || echo 0)
  PM2_CRASH=$(printf '%s' "$PM2_JSON" | python3 -s -c "import sys,json; cl=json.load(sys.stdin).get('crash_loopers',[]); print('[]' if not cl else json.dumps(cl))" 2>/dev/null || echo "[]")

  if [[ "$PM2_COUNT" -eq 0 ]]; then
    log "FAIL: no pm2 CC app found on port ${PORT}"
    PM2_PASS="fail"
  elif [[ "$PM2_COUNT" -gt 1 ]]; then
    log "FAIL: ${PM2_COUNT} pm2 CC apps on port ${PORT} (zombie conflict)"
    PM2_PASS="fail"
  elif [[ "$PM2_CRASH" != "[]" ]]; then
    log "FAIL: crash-looping CC app(s) detected"
    PM2_PASS="fail"
  else
    log "pm2 topology: PASS (${PM2_COUNT} app, no crash-loopers)"
    PM2_PASS="pass"
  fi
fi

# ── (b2) outside-in asset probe ───────────────────────────────────────────────
# Fetch /, extract the first hashed /_next/static ref, curl it — proves the
# RUNNING server actually serves the on-disk build (not a stale old server).
log "Outside-in asset probe..."

ROOT_HTML=$(curl --silent --max-time 10 --max-redirs 0 "${BASE_URL}/" 2>/dev/null || echo "")
ASSET_REF=$(printf '%s' "$ROOT_HTML" | grep -oE '/_next/static/[^"'"'"' >]+\.(js|css)' | head -1 || echo "")

ASSET_PASS="skip"
if [[ -n "$ASSET_REF" ]]; then
  ASSET_CODE=$(curl --silent --max-time 10 --max-redirs 0 --write-out '%{http_code}' \
    --output /dev/null "${BASE_URL}${ASSET_REF}" 2>/dev/null || echo "000")
  ASSET_CT=$(curl --silent --max-time 10 --max-redirs 0 \
    --head "${BASE_URL}${ASSET_REF}" 2>/dev/null | grep -i 'content-type:' | head -1 || echo "")
  if [[ "$ASSET_CODE" == "200" ]] && printf '%s' "$ASSET_CT" | grep -qiE 'javascript|css|text'; then
    log "Outside-in asset probe: PASS (${ASSET_REF} → HTTP ${ASSET_CODE})"
    ASSET_PASS="pass"
  else
    log "FAIL: asset ${ASSET_REF} returned HTTP ${ASSET_CODE} (expected 200+JS/CSS content-type)"
    ASSET_PASS="fail"
  fi
else
  log "WARN: no /_next/static asset ref found in / HTML — skipping outside-in probe"
fi

# ── verdict ───────────────────────────────────────────────────────────────────
FINAL_PASS=true
EXIT_CODE=0

[[ "$PM2_PASS"    == "fail" ]] && FINAL_PASS=false && EXIT_CODE=1
[[ "$ASSET_PASS"  == "fail" ]] && FINAL_PASS=false && EXIT_CODE=1

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' "$DEEP_BODY" | python3 -s -c "
import sys, json
deep = json.load(sys.stdin)
deep['pass']         = ${FINAL_PASS}
deep['source']       = 'cc-health-check.sh'
deep['pm2_topology'] = json.loads(sys.argv[1])
deep['outside_in_asset'] = {'pass': sys.argv[2] != 'fail', 'asset_ref': sys.argv[3]}
print(json.dumps(deep, indent=2))
" "$PM2_JSON" "$ASSET_PASS" "${ASSET_REF:-none}" 2>/dev/null || \
  printf '{"pass":%s,"timestamp":"%s","pm2_pass":"%s","asset_pass":"%s"}\n' \
    "$FINAL_PASS" "$TIMESTAMP" "$PM2_PASS" "$ASSET_PASS"

exit "$EXIT_CODE"
