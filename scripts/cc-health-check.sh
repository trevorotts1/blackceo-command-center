#!/usr/bin/env bash
# cc-health-check.sh — B.1 single definition of "green". App checks in /api/health/deep.
# Handles: (a) pm2 topology  (b) outside-in asset probe  (c) CF public-URL probe (rows 25-27+new).
# EXIT: 0=green  1=red  3=UNKNOWN (transient—never rollback on 3)  2=usage error
# CF-REDIRECT GUARD: --max-redirs 0 catches CF login-redirect as non-200.

set -uo pipefail
PORT="${CC_PORT:-4000}"; CANONICAL_DIR="${CC_CANONICAL_DIR:-}"; SKIP_PM2=0; JSON_ONLY=0
PUBLIC_URL="${CC_PUBLIC_URL:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)          PORT="$2";          shift 2 ;;
    --canonical-dir) CANONICAL_DIR="$2"; shift 2 ;;
    --public-url)    PUBLIC_URL="$2";    shift 2 ;;
    --disk-min-gb)                       shift 2 ;;
    --skip-pm2)      SKIP_PM2=1;         shift   ;;
    --json-only)     JSON_ONLY=1;        shift   ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

BASE_URL="http://127.0.0.1:${PORT}"
log() { [[ "$JSON_ONLY" -eq 0 ]] && printf '[cc-health] %s\n' "$*" >&2 || true; }
py() { python3 -s -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null || echo "$2"; }
# ── (a) /api/health/deep ──────────────────────────────────────────────────────
DEEP_RAW=$(curl -s --max-time 15 --max-redirs 0 \
  --write-out '\n{"_http_code":%{http_code}}' "${BASE_URL}/api/health/deep" 2>/dev/null \
  || echo '{"_error":"curl_failed"}')
DEEP_BODY=$(printf '%s\n' "$DEEP_RAW" | awk 'NR>1{print prev} {prev=$0}')
HTTP_CODE=$(printf '%s\n' "$DEEP_RAW" | awk 'END{print}' | py "d.get('_http_code',0)" 0)

if [[ "$HTTP_CODE" == "0" ]]; then
  printf '{"pass":false,"indeterminate":true,"timestamp":"%s","checks":{},"detail":"server unreachable"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit 3
fi
if [[ "$HTTP_CODE" != "200" ]]; then
  printf '{"pass":false,"indeterminate":false,"timestamp":"%s","checks":{},"detail":"HTTP %s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$HTTP_CODE"
  exit 1
fi

DEEP_PASS=$(printf '%s' "$DEEP_BODY" | py "'true' if d.get('pass') else 'false'" "false")
DEEP_INDET=$(printf '%s' "$DEEP_BODY" | py "'true' if d.get('indeterminate') else 'false'" "false")
[[ "$DEEP_INDET" == "true" ]] && { printf '%s\n' "$DEEP_BODY"; exit 3; }
[[ "$DEEP_PASS"  != "true"  ]] && { printf '%s\n' "$DEEP_BODY"; exit 1; }
log "/api/health/deep: PASS"

# ── (b1) pm2 topology — CC-scoped ────────────────────────────────────────────
# FIX: write PM2_RAW and Python to temp files — heredoc binds stdin, pipe data
# is discarded; Python sys.stdin.read() returns '' when heredoc is present.
PM2_PASS="skip"; PM2_JSON='{"app_count":0,"crash_loopers":[],"db_path_set":false,"cwd_ok":false,"null_cwd_count":0}'
if [[ "$SKIP_PM2" -eq 1 ]]; then
  log "pm2 topology: skipped"
elif ! command -v pm2 &>/dev/null || ! command -v python3 &>/dev/null; then
  log "WARN: pm2/python3 unavailable — pm2 check skipped"
else
  _J=$(mktemp /tmp/pm2_raw_$$.json); _P=$(mktemp /tmp/pm2_py_$$.py)
  pm2 jlist 2>/dev/null > "$_J" || echo "[]" > "$_J"
  cat > "$_P" << 'PY'
import sys,json,os,re
f,p,c=sys.argv[1],sys.argv[2],sys.argv[3]
def ev(e,k):
    for l in('env_data','env'):
        x=e.get(l) or {}
        if isinstance(x,dict):
            v=x.get(k) or x.get(k.lower())
            if v: return str(v)
    v=e.get(k) or e.get(k.lower()); return str(v) if v else ''
def pm(a):
    e=a.get('pm2_env') or {}
    if ev(e,'PORT')==p: return True
    ar=e.get('args') or ''
    if isinstance(ar,list): ar=' '.join(str(x) for x in ar)
    return bool(re.search(r'(?:--port|-p)\s+'+re.escape(p)+r'(?!\d)',str(ar)))
def nm(a):
    e=a.get('pm2_env') or {}; n=(e.get('name') or a.get('name') or '').lower()
    if not any(k in n for k in('mission-control','command-center','blackceo')): return False
    pe=ev(e,'PORT'); return not(pe and pe!=p)
def cwd(a): e=a.get('pm2_env') or {}; return e.get('pm_cwd') or e.get('cwd') or ''
try:
    apps=json.loads(open(f).read()) or []
    cc=[a for a in apps if pm(a) or nm(a)]
    cr=[{'name':(a.get('pm2_env') or {}).get('name','?'),'reason':'status='+(a.get('pm2_env') or {}).get('status','')} for a in cc if (a.get('pm2_env') or {}).get('status') in('errored','stopped')]
    db=any(ev(a.get('pm2_env') or {},'DATABASE_PATH') for a in cc)
    nc=[a for a in cc if not cwd(a)]
    if nc: ok=False
    elif cc and c: ok=all(os.path.normpath(cwd(a))==os.path.normpath(c) for a in cc)
    else: ok=bool(cc)
    print(json.dumps({'app_count':len(cc),'crash_loopers':cr,'db_path_set':db,'cwd_ok':ok,'null_cwd_count':len(nc)}))
except Exception as e: print(json.dumps({'error':str(e),'app_count':0,'crash_loopers':[],'db_path_set':False,'cwd_ok':False,'null_cwd_count':0}))
PY
  PM2_JSON=$(python3 -s "$_P" "$_J" "$PORT" "$CANONICAL_DIR" 2>/dev/null \
    || echo '{"error":"python3 failed","app_count":0,"crash_loopers":[],"db_path_set":false,"cwd_ok":false,"null_cwd_count":0}')
  rm -f "$_J" "$_P"
  PM2_COUNT=$(printf '%s' "$PM2_JSON" | py "d.get('app_count',0)" 0)
  PM2_CRASH=$(printf '%s' "$PM2_JSON" | py "cl=d.get('crash_loopers',[]); '[]' if not cl else json.dumps(cl)" "[]")
  NULL_CWD=$(printf '%s'  "$PM2_JSON" | py "d.get('null_cwd_count',0)" 0)
  if   [[ "$PM2_COUNT" -eq 0 ]];   then log "FAIL: no pm2 CC app"; PM2_PASS="fail"
  elif [[ "$PM2_COUNT" -gt 1 ]];   then log "FAIL: ${PM2_COUNT} CC apps (zombie)"; PM2_PASS="fail"
  elif [[ "$PM2_CRASH" != "[]" ]]; then log "FAIL: crash-looping CC app"; PM2_PASS="fail"
  elif [[ "$NULL_CWD"  -gt 0 ]];   then log "FAIL: CC app null cwd (drift)"; PM2_PASS="fail"
  else log "pm2: PASS"; PM2_PASS="pass"; fi
fi

# ── (b2) outside-in asset probe ───────────────────────────────────────────────
ROOT_HTML=$(curl -s --max-time 10 --max-redirs 0 "${BASE_URL}/" 2>/dev/null || echo "")
ASSET_REF=$(printf '%s' "$ROOT_HTML" | grep -oE '/_next/static/[^"'"'"' >]+\.(js|css)' | head -1 || echo "")
ASSET_PASS="skip"
if [[ -n "$ASSET_REF" ]]; then
  ASSET_CODE=$(curl -s --max-time 10 --max-redirs 0 -w '%{http_code}' -o /dev/null "${BASE_URL}${ASSET_REF}" 2>/dev/null || echo "000")
  ASSET_CT=$(curl -s --max-time 10 --max-redirs 0 -I "${BASE_URL}${ASSET_REF}" 2>/dev/null | grep -i 'content-type:' | head -1 || echo "")
  if [[ "$ASSET_CODE" == "200" ]] && printf '%s' "$ASSET_CT" | grep -qiE 'javascript|css|text'; then
    log "outside-in: PASS"; ASSET_PASS="pass"
  else log "FAIL: asset ${ASSET_REF} → HTTP ${ASSET_CODE}"; ASSET_PASS="fail"; fi
else log "WARN: no /_next/static ref — outside-in skipped"; fi

# ── (c) CF public-URL probe (truth-table rows 25-27 + CF-Access-policy row) ──
# CC_PUBLIC_URL unset → row 27 UNKNOWN (never FAIL; tunnel may be off).
# 3xx → row 26 FAIL.  000 → row 27 UNKNOWN.  200+CF-challenge → new row UNKNOWN.
CF_PASS="skip"; CF_INDET=false; CF_DETAIL="public URL not configured (row 27: UNKNOWN)"
if [[ -n "$PUBLIC_URL" ]]; then
  _CF=$(mktemp /tmp/cf_probe_$$.html)
  CF_HTTP=$(curl -s --max-time 15 --max-redirs 0 -w '%{http_code}' -o "$_CF" "$PUBLIC_URL" 2>/dev/null || echo "000")
  CF_BODY=$(cat "$_CF" 2>/dev/null || echo ""); rm -f "$_CF"
  if   [[ "$CF_HTTP" == "000" ]]; then CF_INDET=true; CF_DETAIL="CF tunnel unreachable (row 27: UNKNOWN)"
  elif [[ "$CF_HTTP" =~ ^3 ]];   then CF_PASS="fail"; CF_DETAIL="CF redirected HTTP ${CF_HTTP} (row 26: FAIL)"
  elif [[ "$CF_HTTP" == "200" ]] && printf '%s' "$CF_BODY" | grep -qi 'cloudflare access\|cf-access-login\|cf_chl'; then
    CF_INDET=true; CF_DETAIL="CF Access policy misconfigured: public URL returns CF challenge (UNKNOWN)"
  elif [[ "$CF_HTTP" == "200" ]]; then CF_PASS="pass"; CF_DETAIL="CF public URL → HTTP 200: PASS"
  else CF_PASS="fail"; CF_DETAIL="CF public URL → HTTP ${CF_HTTP}: FAIL"; fi
else CF_INDET=true; fi
[[ "$CF_INDET" == "true" ]] && log "UNKNOWN: ${CF_DETAIL}" || log "CF probe: ${CF_PASS} — ${CF_DETAIL}"

# ── verdict ───────────────────────────────────────────────────────────────────
FINAL_PASS=true; EXIT_CODE=0; FINAL_INDET=false
[[ "$PM2_PASS"  == "fail" ]] && FINAL_PASS=false && EXIT_CODE=1
[[ "$ASSET_PASS" == "fail" ]] && FINAL_PASS=false && EXIT_CODE=1
[[ "$CF_PASS"    == "fail" ]] && FINAL_PASS=false && EXIT_CODE=1
[[ "$CF_INDET"   == "true" ]] && FINAL_INDET=true
[[ "$FINAL_INDET" == "true" && "$EXIT_CODE" -eq 0 ]] && FINAL_PASS=false && EXIT_CODE=3
printf '%s\n' "$DEEP_BODY" | python3 -s -c "
import sys,json
d=json.load(sys.stdin)
d['pass']=(sys.argv[1]=='true'); d['source']='cc-health-check.sh'
d['pm2_topology']=json.loads(sys.argv[2])
d['outside_in_asset']={'pass':sys.argv[3]!='fail','asset_ref':sys.argv[4]}
d['cf_probe']={'pass':sys.argv[5]=='pass','indeterminate':sys.argv[6]=='true','detail':sys.argv[7]}
print(json.dumps(d,indent=2))
" "$FINAL_PASS" "$PM2_JSON" "$ASSET_PASS" "${ASSET_REF:-none}" "$CF_PASS" "$FINAL_INDET" "$CF_DETAIL" 2>/dev/null || \
  printf '{"pass":%s,"indeterminate":%s,"timestamp":"%s"}\n' "$FINAL_PASS" "$FINAL_INDET" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
exit "$EXIT_CODE"
