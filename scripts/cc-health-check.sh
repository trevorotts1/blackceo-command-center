#!/usr/bin/env bash
# cc-health-check.sh — THE single definition of "green" for a deployed CC instance.
# PRD Addendum B.1 (P0).  All app-checkable logic lives in /api/health/deep.
# This script only handles: (a) pm2 topology, (b) one outside-in asset probe.
#
# EXIT CONTRACT (callers MUST honour all codes):
#   0 = green  1 = red (definitive)  3 = UNKNOWN (transient — never rollback on 3)  2 = usage error
# CF-REDIRECT GUARD: curl --max-redirs 0 so CF login-redirect is caught as non-200.

set -uo pipefail

PORT="${CC_PORT:-4000}"; CANONICAL_DIR="${CC_CANONICAL_DIR:-}"; SKIP_PM2=0; JSON_ONLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)          PORT="$2";          shift 2 ;;
    --canonical-dir) CANONICAL_DIR="$2"; shift 2 ;;
    --disk-min-gb)                       shift 2 ;;  # owned by deep endpoint; accepted, ignored
    --skip-pm2)      SKIP_PM2=1;         shift   ;;
    --json-only)     JSON_ONLY=1;        shift   ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

BASE_URL="http://127.0.0.1:${PORT}"
log() { [[ "$JSON_ONLY" -eq 0 ]] && printf '[cc-health] %s\n' "$*" >&2 || true; }

# ── (a) /api/health/deep ──────────────────────────────────────────────────────
log "Probing /api/health/deep on port ${PORT}..."
DEEP_RAW=$(curl --silent --max-time 15 --max-redirs 0 \
  --write-out '\n{"_http_code":%{http_code}}' "${BASE_URL}/api/health/deep" 2>/dev/null \
  || echo '{"_error":"curl_failed"}')
# POSIX-safe split — awk instead of GNU-only head -n -1
DEEP_BODY=$(printf '%s\n' "$DEEP_RAW" | awk 'NR>1{print prev} {prev=$0}')
HTTP_CODE=$(printf '%s\n' "$DEEP_RAW" | awk 'END{print}' \
  | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(d.get('_http_code',0))" 2>/dev/null || echo 0)

if [[ "$HTTP_CODE" == "0" ]]; then
  log "UNKNOWN: server unreachable on port ${PORT}"
  printf '{"pass":false,"indeterminate":true,"timestamp":"%s","checks":{},"source":"cc-health-check.sh","detail":"server unreachable"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit 3
fi
if [[ "$HTTP_CODE" != "200" ]]; then
  log "FAIL: /api/health/deep returned HTTP ${HTTP_CODE}"
  printf '{"pass":false,"indeterminate":false,"timestamp":"%s","checks":{},"source":"cc-health-check.sh","detail":"HTTP %s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$HTTP_CODE"
  exit 1
fi

py_field() { python3 -s -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null || echo "$2"; }
DEEP_PASS=$(printf '%s' "$DEEP_BODY" | py_field "'true' if d.get('pass') else 'false'" "false")
DEEP_INDET=$(printf '%s' "$DEEP_BODY" | py_field "'true' if d.get('indeterminate') else 'false'" "false")
[[ "$DEEP_INDET" == "true" ]] && { log "UNKNOWN: /api/health/deep indeterminate"; printf '%s\n' "$DEEP_BODY"; exit 3; }
[[ "$DEEP_PASS"  != "true"  ]] && { log "FAIL: /api/health/deep not-green";       printf '%s\n' "$DEEP_BODY"; exit 1; }
log "/api/health/deep: PASS"

# ── (b1) pm2 topology — CC-scoped ────────────────────────────────────────────
PM2_PASS="skip"; PM2_JSON='{"app_count":0,"crash_loopers":[],"db_path_set":false,"cwd_ok":false,"null_cwd_count":0}'
if [[ "$SKIP_PM2" -eq 1 ]]; then
  log "pm2 topology: skipped (--skip-pm2)"
elif ! command -v pm2 &>/dev/null || ! command -v python3 &>/dev/null; then
  log "WARN: pm2 or python3 unavailable — topology check skipped"
else
  PM2_RAW=$(pm2 jlist 2>/dev/null || echo "[]")
  PM2_JSON=$(printf '%s\n' "$PM2_RAW" | python3 -s << PYEOF
import sys, json, os, re
port_str = "$PORT"; canon_dir = "$CANONICAL_DIR"
def ev(env, key):
    for layer in ('env_data','env'):
        e=env.get(layer) or {}
        if isinstance(e,dict):
            v=e.get(key) or e.get(key.lower())
            if v: return str(v)
    v=env.get(key) or env.get(key.lower()); return str(v) if v else ''
def pm(a,p):
    env=a.get('pm2_env') or {}
    if ev(env,'PORT')==p: return True
    args=env.get('args') or ''
    if isinstance(args,list): args=' '.join(str(x) for x in args)
    return bool(re.search(r'(?:--port|-p)\s+'+re.escape(p)+r'(?!\d)',str(args)))
def nm(a,p):
    env=a.get('pm2_env') or {}
    name=(env.get('name') or a.get('name') or '').lower()
    if not any(kw in name for kw in ('mission-control','command-center','blackceo')): return False
    pe=ev(env,'PORT'); return not (pe and pe!=p)
def gcwd(a):
    env=a.get('pm2_env') or {}; return env.get('pm_cwd') or env.get('cwd') or ''
try:
    apps=json.loads(sys.stdin.read()) or []
    cc=[a for a in apps if pm(a,port_str) or nm(a,port_str)]
    crash=[]
    for a in cc:
        env=a.get('pm2_env') or {}; st=env.get('status') or ''
        if st in ('errored','stopped'): crash.append({'name':env.get('name') or 'unknown','reason':f'status={st}'})
    db_set=any(ev(a.get('pm2_env') or {},'DATABASE_PATH') for a in cc)
    null_c=[a for a in cc if not gcwd(a)]
    if null_c: cwd_ok=False
    elif cc and canon_dir: cwd_ok=all(os.path.normpath(gcwd(a))==os.path.normpath(canon_dir) for a in cc)
    else: cwd_ok=bool(cc)
    print(json.dumps({'app_count':len(cc),'crash_loopers':crash,'db_path_set':db_set,'cwd_ok':cwd_ok,'null_cwd_count':len(null_c)}))
except Exception as e:
    print(json.dumps({'error':str(e),'app_count':0,'crash_loopers':[],'db_path_set':False,'cwd_ok':False,'null_cwd_count':0}))
PYEOF
)

  PM2_COUNT=$(printf '%s' "$PM2_JSON" | py_field "json.load(sys.stdin).get('app_count',0)" 0)
  PM2_CRASH=$(printf '%s' "$PM2_JSON" | py_field "cl=json.load(sys.stdin).get('crash_loopers',[]); '[]' if not cl else json.dumps(cl)" "[]")
  NULL_CWD=$(printf '%s' "$PM2_JSON"  | py_field "json.load(sys.stdin).get('null_cwd_count',0)" 0)

  if   [[ "$PM2_COUNT" -eq 0 ]];       then log "FAIL: no pm2 CC app on port ${PORT}"; PM2_PASS="fail"
  elif [[ "$PM2_COUNT" -gt 1 ]];       then log "FAIL: ${PM2_COUNT} CC apps (zombie)"; PM2_PASS="fail"
  elif [[ "$PM2_CRASH" != "[]" ]];     then log "FAIL: crash-looping CC app(s)";       PM2_PASS="fail"
  elif [[ "$NULL_CWD"  -gt 0 ]];       then log "FAIL: CC app has null cwd (drift)";   PM2_PASS="fail"
  else log "pm2 topology: PASS"; PM2_PASS="pass"; fi
fi

# ── (b2) outside-in asset probe ───────────────────────────────────────────────
log "Outside-in asset probe..."
ROOT_HTML=$(curl --silent --max-time 10 --max-redirs 0 "${BASE_URL}/" 2>/dev/null || echo "")
ASSET_REF=$(printf '%s' "$ROOT_HTML" | grep -oE '/_next/static/[^"'"'"' >]+\.(js|css)' | head -1 || echo "")
ASSET_PASS="skip"
if [[ -n "$ASSET_REF" ]]; then
  ASSET_CODE=$(curl --silent --max-time 10 --max-redirs 0 --write-out '%{http_code}' --output /dev/null "${BASE_URL}${ASSET_REF}" 2>/dev/null || echo "000")
  ASSET_CT=$(curl --silent --max-time 10 --max-redirs 0 --head "${BASE_URL}${ASSET_REF}" 2>/dev/null | grep -i 'content-type:' | head -1 || echo "")
  if [[ "$ASSET_CODE" == "200" ]] && printf '%s' "$ASSET_CT" | grep -qiE 'javascript|css|text'; then
    log "Outside-in probe: PASS (${ASSET_REF} → ${ASSET_CODE})"; ASSET_PASS="pass"
  else
    log "FAIL: asset ${ASSET_REF} → HTTP ${ASSET_CODE}"; ASSET_PASS="fail"
  fi
else
  log "WARN: no /_next/static ref in HTML — outside-in probe skipped"
fi

# ── verdict ───────────────────────────────────────────────────────────────────
FINAL_PASS=true; EXIT_CODE=0
[[ "$PM2_PASS"   == "fail" ]] && FINAL_PASS=false && EXIT_CODE=1
[[ "$ASSET_PASS" == "fail" ]] && FINAL_PASS=false && EXIT_CODE=1
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' "$DEEP_BODY" | python3 -s -c "
import sys, json
deep=json.load(sys.stdin)
deep['pass']=$(printf '%s' "$FINAL_PASS"); deep['source']='cc-health-check.sh'
deep['pm2_topology']=json.loads(sys.argv[1])
deep['outside_in_asset']={'pass': sys.argv[2]!='fail','asset_ref':sys.argv[3]}
print(json.dumps(deep,indent=2))
" "$PM2_JSON" "$ASSET_PASS" "${ASSET_REF:-none}" 2>/dev/null || \
  printf '{"pass":%s,"timestamp":"%s","pm2_pass":"%s","asset_pass":"%s"}\n' "$FINAL_PASS" "$TIMESTAMP" "$PM2_PASS" "$ASSET_PASS"
exit "$EXIT_CODE"
