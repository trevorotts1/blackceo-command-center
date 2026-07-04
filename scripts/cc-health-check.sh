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

# ── interview-lock redirect reconciliation (Wave 5 src/middleware.ts) ─────────
# The Wave-5 interview-mode shell lock 302-redirects EVERY page GET to /interview
# (an in-app, lock-exempt path) until the AI Workforce interview is complete. That
# is a HEALTHY app that is correctly gating — NOT a Cloudflare/tunnel misconfig.
# These helpers let the outside-in and CF probes tell that in-app gate redirect
# apart from a genuine off-origin Cloudflare Access login redirect, so both CI and
# a real mid-interview box read GREEN instead of a false RED.
# host of a URL, lowercased, port stripped (scheme is always lowercase http/https)
url_host() { printf '%s' "$1" | sed -E 's#^[a-z]+://##;s#[/?].*$##;s#:.*$##' | tr 'A-Z' 'a-z'; }
# path component of an absolute URL ('/' if none)
url_path() { local p; p=$(printf '%s' "$1" | sed -E 's#^[a-z]+://[^/]*##;s#\?.*$##'); printf '%s' "${p:-/}"; }
# True iff $1 (a 3xx redirect target) is a SAME-ORIGIN redirect (vs $2 = the base
# URL we probed) to a middleware-exempt in-app path (/interview or /onboarding) —
# i.e. the interview lock on a live app, not an off-origin CF Access login page.
is_interview_gate_redirect() {
  local target="$1" base="$2"
  [[ -n "$target" ]] || return 1
  [[ "$(url_host "$target")" == "$(url_host "$base")" ]] || return 1
  printf '%s' "$(url_path "$target")" | grep -qE '^/(interview|onboarding)(/|$)'
}
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
# FIX (Issue 2): 5xx from /api/health/deep → exit 3 UNKNOWN, not exit 1.
# route.ts comment mandates: 500 = internal error, treat as indeterminate by caller.
if [[ "$HTTP_CODE" -ge 500 && "$HTTP_CODE" -le 599 ]] 2>/dev/null; then
  log "UNKNOWN: /api/health/deep returned HTTP ${HTTP_CODE} (server error — indeterminate)"
  printf '{"pass":false,"indeterminate":true,"timestamp":"%s","checks":{},"source":"cc-health-check.sh","detail":"HTTP %s (5xx indeterminate)"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$HTTP_CODE"
  exit 3
fi
if [[ "$HTTP_CODE" != "200" ]]; then
  printf '{"pass":false,"indeterminate":false,"timestamp":"%s","checks":{},"detail":"HTTP %s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$HTTP_CODE"
  exit 1
fi

# P3 FIX: HTTP 200 + non-JSON body → exit 3 UNKNOWN (ambiguous, not definitively red).
# A proxy splash page or error page returned as 200 means we cannot determine health.
if ! python3 -s -c "import sys,json; json.loads(sys.stdin.read())" <<< "$DEEP_BODY" 2>/dev/null; then
  log "UNKNOWN: /api/health/deep returned HTTP 200 but body is not valid JSON (P3 fix)"
  printf '{"pass":false,"indeterminate":true,"timestamp":"%s","checks":{},"source":"cc-health-check.sh","detail":"HTTP 200 but non-JSON body — ambiguous (P3: exit 3 UNKNOWN)"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  exit 3
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
  # Delegate to scripts/pm2-analyze-cc.py (extracted for testability —
  # vitest tests in tests/unit/cc-probe-pm2.test.ts exercise the logic
  # directly using fixture JSON; no real pm2 required in CI).
  # Write pm2 output to a temp file rather than piping it to Python's stdin
  # (a heredoc on the same process would bind stdin first, causing
  # sys.stdin.read() to return '' — the root cause fixed in REDO #2).
  _J=$(mktemp /tmp/pm2_raw_XXXXXX.json)
  pm2 jlist 2>/dev/null > "$_J" || echo "[]" > "$_J"
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PM2_JSON=$(python3 -s "$SCRIPT_DIR/pm2-analyze-cc.py" \
    --port "$PORT" ${CANONICAL_DIR:+--canonical-dir "$CANONICAL_DIR"} < "$_J" 2>/dev/null \
    || echo '{"error":"pm2-analyze-cc.py failed","app_count":0,"crash_loopers":[],"db_path_set":false,"cwd_ok":false,"null_cwd_count":0}')
  rm -f "$_J"

  PM2_COUNT=$(printf '%s' "$PM2_JSON" | py "d.get('app_count',0)" 0)
  PM2_CRASH=$(printf '%s' "$PM2_JSON" | py "cl=d.get('crash_loopers',[]); '[]' if not cl else json.dumps(cl)" "[]")
  NULL_CWD=$(printf '%s'  "$PM2_JSON" | py "d.get('null_cwd_count',0)" 0)
  # FIX (Issue 1): also extract cwd_ok — null-cwd is caught above, but a
  # wrong-but-non-null cwd (app running from wrong dir with --canonical-dir
  # set) requires its own FAIL branch.  Without this, cwd_ok=false is
  # computed but never acted on → wrong-cwd exits 0 GREEN.
  CWD_OK=$(printf '%s'     "$PM2_JSON" | py "'true' if d.get('cwd_ok') else 'false'" "false")

  if   [[ "$PM2_COUNT" -eq 0 ]];     then log "FAIL: no pm2 CC app"; PM2_PASS="fail"
  elif [[ "$PM2_COUNT" -gt 1 ]];     then log "FAIL: ${PM2_COUNT} CC apps (zombie)"; PM2_PASS="fail"
  elif [[ "$PM2_CRASH" != "[]" ]];   then log "FAIL: crash-looping CC app"; PM2_PASS="fail"
  elif [[ "$NULL_CWD"  -gt 0 ]];     then log "FAIL: CC app null cwd (drift)"; PM2_PASS="fail"
  elif [[ "$CWD_OK"    != "true" ]]; then log "FAIL: CC app cwd mismatch (wrong dir)"; PM2_PASS="fail"
  else log "pm2: PASS"; PM2_PASS="pass"; fi
fi

# ── (b2) outside-in asset probe ───────────────────────────────────────────────
# Probe the page the browser actually renders. While the Wave-5 interview lock
# (src/middleware.ts) is engaged, GET / 302s to the in-app, lock-exempt /interview
# page (which carries the real /_next/static refs). Follow that SAME-ORIGIN in-app
# redirect ONE hop so the asset check probes the served page instead of an empty
# 302 body. --max-redirs 0 is retained so an off-origin CF login redirect is NOT
# followed (it stays visible as a redirect and the probe verifies nothing → UNKNOWN).
PROBE_PATH="/"
ROOT_WO=$(curl -s --max-time 10 --max-redirs 0 -o /dev/null -w '%{http_code} %{redirect_url}' "${BASE_URL}/" 2>/dev/null || echo "000 ")
ROOT_CODE="${ROOT_WO%% *}"; ROOT_LOC="${ROOT_WO#* }"
if [[ "$ROOT_CODE" =~ ^3 ]] && is_interview_gate_redirect "$ROOT_LOC" "$BASE_URL"; then
  PROBE_PATH="$(url_path "$ROOT_LOC")"
  log "outside-in: / 302→${PROBE_PATH} (interview lock); probing gated page for asset refs"
fi
ROOT_HTML=$(curl -s --max-time 10 --max-redirs 0 "${BASE_URL}${PROBE_PATH}" 2>/dev/null || echo "")
ASSET_REF=$(printf '%s' "$ROOT_HTML" | grep -oE '/_next/static/[^"'"'"' >]+\.(js|css)' | head -1 || echo "")
ASSET_PASS="skip"; ASSET_INDET=false
if [[ -n "$ASSET_REF" ]]; then
  ASSET_CODE=$(curl -s --max-time 10 --max-redirs 0 -w '%{http_code}' -o /dev/null "${BASE_URL}${ASSET_REF}" 2>/dev/null || echo "000")
  ASSET_CT=$(curl -s --max-time 10 --max-redirs 0 -I "${BASE_URL}${ASSET_REF}" 2>/dev/null | grep -i 'content-type:' | head -1 || echo "")
  if [[ "$ASSET_CODE" == "200" ]] && printf '%s' "$ASSET_CT" | grep -qiE 'javascript|css|text'; then
    log "outside-in: PASS"; ASSET_PASS="pass"
  else log "FAIL: asset ${ASSET_REF} → HTTP ${ASSET_CODE}"; ASSET_PASS="fail"; fi
else
  # P2 FIX: a probe that verified nothing must not green.
  # 'skip' was leaking as pass=true; set ASSET_INDET=true → exit 3 UNKNOWN.
  log "UNKNOWN: no /_next/static ref in root HTML — outside-in probe verified nothing (P2 fix: exit 3)"
  ASSET_INDET=true
fi

# ── (c) CF public-URL probe (truth-table rows 25-27 + CF-Access-policy row) ──
# CC_PUBLIC_URL unset → row 27 UNKNOWN (never FAIL; tunnel may be off).
# 3xx → row 26 FAIL, UNLESS it is the in-app interview-lock gate (see below).
# 000 → row 27 UNKNOWN.  200+CF-challenge → new row UNKNOWN.
CF_PASS="skip"; CF_INDET=false; CF_DETAIL="public URL not configured (row 27: UNKNOWN)"
if [[ -n "$PUBLIC_URL" ]]; then
  _CF=$(mktemp /tmp/cf_probe_XXXXXX.html)
  # Capture BOTH the status code and the redirect target (Location resolved to an
  # absolute URL) so an in-app interview-lock 302 can be told apart from a genuine
  # off-origin CF Access login redirect. --max-redirs 0 keeps CF login-redirects
  # visible as a 3xx rather than silently followed.
  CF_WO=$(curl -s --max-time 15 --max-redirs 0 -w '%{http_code} %{redirect_url}' -o "$_CF" "$PUBLIC_URL" 2>/dev/null || echo "000 ")
  CF_HTTP="${CF_WO%% *}"; CF_LOC="${CF_WO#* }"
  CF_BODY=$(cat "$_CF" 2>/dev/null || echo ""); rm -f "$_CF"
  if   [[ "$CF_HTTP" == "000" ]]; then CF_INDET=true; CF_DETAIL="CF tunnel unreachable (row 27: UNKNOWN)"
  elif [[ "$CF_HTTP" =~ ^3 ]]; then
    # Wave-5 interview-lock reconciliation: a SAME-ORIGIN 302 to a middleware-exempt
    # in-app path (/interview, /onboarding) means the app is UP and correctly gating
    # the pre-closeout dashboard — PASS. Any OTHER 3xx (off-origin CF Access login
    # host, or an unexpected path) stays row-26 FAIL.
    if is_interview_gate_redirect "$CF_LOC" "$PUBLIC_URL"; then
      CF_PASS="pass"; CF_DETAIL="CF public URL → HTTP ${CF_HTTP} to $(url_path "$CF_LOC") (in-app interview-lock gate; app up: PASS)"
    else
      CF_PASS="fail"; CF_DETAIL="CF redirected HTTP ${CF_HTTP} → ${CF_LOC:-<no location>} (row 26: FAIL)"
    fi
  elif [[ "$CF_HTTP" == "200" ]] && printf '%s' "$CF_BODY" | grep -qi 'cloudflare access\|cf-access-login\|cf_chl'; then
    CF_INDET=true; CF_DETAIL="CF Access policy misconfigured: public URL returns CF challenge (UNKNOWN)"
  elif [[ "$CF_HTTP" == "200" ]]; then CF_PASS="pass"; CF_DETAIL="CF public URL → HTTP 200: PASS"
  else CF_PASS="fail"; CF_DETAIL="CF public URL → HTTP ${CF_HTTP}: FAIL"; fi
else CF_INDET=true; fi
[[ "$CF_INDET" == "true" ]] && log "UNKNOWN: ${CF_DETAIL}" || log "CF probe: ${CF_PASS} — ${CF_DETAIL}"

# ── verdict ───────────────────────────────────────────────────────────────────
FINAL_PASS=true; EXIT_CODE=0; FINAL_INDET=false
[[ "$PM2_PASS"   == "fail" ]]  && FINAL_PASS=false && EXIT_CODE=1
[[ "$ASSET_PASS" == "fail" ]]  && FINAL_PASS=false && EXIT_CODE=1
[[ "$CF_PASS"    == "fail" ]]  && FINAL_PASS=false && EXIT_CODE=1
[[ "$CF_INDET"   == "true" ]]  && FINAL_INDET=true
[[ "$ASSET_INDET" == "true" ]] && FINAL_INDET=true  # P2 FIX: no-ref path → exit 3
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
