#!/usr/bin/env bash
# cc-health-check.sh — B.1 single definition of "green". App checks in /api/health/deep.
# Handles: (a) pm2 topology  (b) outside-in asset probe  (c) CF public-URL probe (rows 25-27+new).
# EXIT: 0=green  1=red  3=UNKNOWN (transient—never rollback on 3)  2=usage error
# CF-REDIRECT GUARD: --max-redirs 0 catches CF login-redirect as non-200; a
# genuine Cloudflare Access login-challenge redirect (team.cloudflareaccess.com
# /cdn-cgi/access/login/...) is then recognized as PASS, not FAIL (U51 fix).
#
# U014: added --remote mode (iterates registered clients, probes /api/health/deep
# via each gateway) and --dry-run (prints probes, writes nothing).

set -uo pipefail
PORT="${CC_PORT:-4000}"; CANONICAL_DIR="${CC_CANONICAL_DIR:-}"; SKIP_PM2=0; JSON_ONLY=0
PUBLIC_URL="${CC_PUBLIC_URL:-}"
DRY_RUN=0; REMOTE_MODE=0
DATABASE_PATH="${DATABASE_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/mission-control.db}"
# Trap-4: the pm2 gate scopes to THE TARGET APP (this name + this port), not to
# "every CC-ish process on the box". Boxes legitimately run demo/staging CC
# instances on other ports; those WARN, they never fail a production deploy.
PM2_APP_NAME="${CC_PM2_APP_NAME:-mission-control}"
# U51 build item: cc_port fact + override_ack_set fact, read-only, snapshotted
# at invocation time — reported in every JSON shape this script emits so a
# sweep can ledger "did this box report canonical port 4000 with no override
# ACK set" without a second probe. override_ack_set only reflects whether the
# ACK is set in THIS script's own environment right now; it is not a claim
# about what env the running pm2 process was actually launched with.
PORT_OVERRIDE_ACK_SET="false"
[[ "${CC_PORT_OVERRIDE_ACK:-0}" == "1" ]] && PORT_OVERRIDE_ACK_SET="true"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)          PORT="$2";          shift 2 ;;
    --canonical-dir) CANONICAL_DIR="$2"; shift 2 ;;
    --app-name)      PM2_APP_NAME="$2";  shift 2 ;;
    --public-url)    PUBLIC_URL="$2";    shift 2 ;;
    --disk-min-gb)                       shift 2 ;;
    --skip-pm2)      SKIP_PM2=1;         shift   ;;
    --json-only)     JSON_ONLY=1;        shift   ;;
    --dry-run)       DRY_RUN=1;          shift   ;;
    --remote)        REMOTE_MODE=1;      shift   ;;
    --db-path)       DATABASE_PATH="$2"; shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

BASE_URL="http://127.0.0.1:${PORT}"
py() { python3 -s -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null || echo "$2"; }
if [[ "$DRY_RUN" -eq 1 ]]; then
  log() { printf '[cc-health] DRY-RUN: %s\n' "$*" >&2; }
else
  log() { [[ "$JSON_ONLY" -eq 0 ]] && printf '[cc-health] %s\n' "$*" >&2 || true; }
fi

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
# U51 regression fix: True iff $1 (a 3xx redirect target, absolute URL) is
# Cloudflare Access's OWN login-challenge redirect — the documented flow CF
# Access uses to gate an unauthenticated request at the edge, BEFORE it ever
# reaches the origin: https://<team>.cloudflareaccess.com/cdn-cgi/access/login/<app-host>?...
# Reproduced live against this box after Access was newly enabled (was
# previously untested against this code path): a 302 to exactly this
# shape is a REAL, correct security control firing — the tunnel/DNS resolved,
# Cloudflare routed the request, and Access intercepted it pre-origin. That
# is "reachable and correctly protected," not "broken/unreachable," and must
# not be scored the same as a dead origin, wrong DNS, or a captive-portal /
# expired-domain redirect.
#
# Deliberately narrow: only CF's own reserved cloudflareaccess.com host PLUS
# its fixed /cdn-cgi/access/login/ path qualify — not "any off-origin 3xx"
# (scripts/cloudflare/probe-access-login.sh answers that broader, narrower-
# purpose "is Access gating this hostname at all" question elsewhere in this
# repo; cc-health-check.sh's public_probe is the fleet-wide green/red gate
# and stays conservative so a genuinely misdirected redirect — bad DNS, an
# ISP captive portal, an expired-domain parking page — still falls through
# to FAIL below instead of going green).
is_cloudflare_access_login_redirect() {
  local target="$1"
  [[ -n "$target" ]] || return 1
  [[ "$(url_host "$target")" == *.cloudflareaccess.com ]] || return 1
  printf '%s' "$(url_path "$target")" | grep -qE '^/cdn-cgi/access/login/'
}
# ── (a) /api/health/deep ──────────────────────────────────────────────────────
if [[ "$DRY_RUN" -eq 1 ]]; then
  log "DRY-RUN MODE: would probe ${BASE_URL}/api/health/deep (self-box deep health)"
  log "DRY-RUN: skipping all live probes — printing mock JSON and exiting"
  printf '{"pass":true,"indeterminate":false,"timestamp":"%s","checks":{},"detail":"dry-run — no probes executed","cc_port":%s,"override_ack_set":%s,"dry_run":true}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${PORT:-null}" "$PORT_OVERRIDE_ACK_SET"
  exit 0
fi

DEEP_RAW=$(curl -s --max-time 15 --max-redirs 0 \
  --write-out '\n{"_http_code":%{http_code}}' "${BASE_URL}/api/health/deep" 2>/dev/null \
  || echo '{"_error":"curl_failed"}')
DEEP_BODY=$(printf '%s\n' "$DEEP_RAW" | awk 'NR>1{print prev} {prev=$0}')
HTTP_CODE=$(printf '%s\n' "$DEEP_RAW" | awk 'END{print}' | py "d.get('_http_code',0)" 0)

if [[ "$HTTP_CODE" == "0" ]]; then
  printf '{"pass":false,"indeterminate":true,"timestamp":"%s","checks":{},"detail":"server unreachable","cc_port":%s,"override_ack_set":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${PORT:-null}" "$PORT_OVERRIDE_ACK_SET"
  exit 3
fi
# FIX (Issue 2): 5xx from /api/health/deep → exit 3 UNKNOWN, not exit 1.
# route.ts comment mandates: 500 = internal error, treat as indeterminate by caller.
if [[ "$HTTP_CODE" -ge 500 && "$HTTP_CODE" -le 599 ]] 2>/dev/null; then
  log "UNKNOWN: /api/health/deep returned HTTP ${HTTP_CODE} (server error — indeterminate)"
  printf '{"pass":false,"indeterminate":true,"timestamp":"%s","checks":{},"source":"cc-health-check.sh","detail":"HTTP %s (5xx indeterminate)","cc_port":%s,"override_ack_set":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$HTTP_CODE" "${PORT:-null}" "$PORT_OVERRIDE_ACK_SET"
  exit 3
fi
if [[ "$HTTP_CODE" != "200" ]]; then
  printf '{"pass":false,"indeterminate":false,"timestamp":"%s","checks":{},"detail":"HTTP %s","cc_port":%s,"override_ack_set":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$HTTP_CODE" "${PORT:-null}" "$PORT_OVERRIDE_ACK_SET"
  exit 1
fi

# P3 FIX: HTTP 200 + non-JSON body → exit 3 UNKNOWN (ambiguous, not definitively red).
# A proxy splash page or error page returned as 200 means we cannot determine health.
if ! python3 -s -c "import sys,json; json.loads(sys.stdin.read())" <<< "$DEEP_BODY" 2>/dev/null; then
  log "UNKNOWN: /api/health/deep returned HTTP 200 but body is not valid JSON (P3 fix)"
  printf '{"pass":false,"indeterminate":true,"timestamp":"%s","checks":{},"source":"cc-health-check.sh","detail":"HTTP 200 but non-JSON body — ambiguous (P3: exit 3 UNKNOWN)","cc_port":%s,"override_ack_set":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${PORT:-null}" "$PORT_OVERRIDE_ACK_SET"
  exit 3
fi

DEEP_PASS=$(printf '%s' "$DEEP_BODY" | py "'true' if d.get('pass') else 'false'" "false")
DEEP_INDET=$(printf '%s' "$DEEP_BODY" | py "'true' if d.get('indeterminate') else 'false'" "false")

# FIX (exit-3 structural defect, U51 priority two): the previous form here was
#   [[ "$DEEP_INDET" == "true" ]] && { printf ...; exit 3; }
#   [[ "$DEEP_PASS"  != "true"  ]] && { printf ...; exit 1; }
# which had two bugs, both proved live against the healthy baseline box:
#   1. It exits the instant ANY gating check (e.g. html_title finding no
#      pre-rendered HTML — a routine, permanent condition on a middleware-
#      gated root route, not a transient one) is indeterminate — BEFORE the
#      pm2 topology, outside-in asset probe, and CF public-URL probe below
#      ever run. html_title's own detail string says "use cc-health-check.sh
#      outside-in probe for live-server title verification" — the very stage
#      this short-circuit skipped past. So a fully healthy box reported
#      exit 3 (UNKNOWN) forever, and a genuinely dead box ALSO reports exit 3
#      (line ~61 above) — the fleet's health verdict could not tell the two
#      apart.
#   2. Checking DEEP_INDET before DEEP_PASS meant a GENUINE, definitive
#      gating failure on one check (e.g. company_branding returning
#      pass:false, indeterminate:false) was masked as UNKNOWN whenever ANY
#      OTHER gating check (e.g. html_title) was merely indeterminate — a real
#      red was silently downgraded to a channel this script's own header
#      defines as transient and both standup-heartbeat.sh and
#      sunday-cron-sweep.sh are built to ignore.
# Fix: detect a genuine hard fail — a `checks.*` entry with pass:false and
# indeterminate NOT true — FIRST and independently of DEEP_INDET; that is
# always definitive RED. Only when no check is a genuine hard fail does an
# indeterminate verdict get DEFERRED (not exited on) to the verdict section
# below, after pm2/outside-in/CF have had a chance to run and contribute.
DEEP_HARD_FAIL=$(printf '%s' "$DEEP_BODY" | py \
  "'true' if any((v.get('pass') is False and v.get('indeterminate') is not True) for v in d.get('checks',{}).values()) else 'false'" \
  "false")
if [[ "$DEEP_HARD_FAIL" == "true" ]]; then
  log "RED: /api/health/deep reports a genuine gating check failure (not masked by a co-occurring indeterminate on a different check)"
  printf '%s' "$DEEP_BODY" | python3 -s -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
try:
    d['cc_port'] = int(sys.argv[1])
except Exception:
    d['cc_port'] = None
d['override_ack_set'] = (sys.argv[2] == 'true')
print(json.dumps(d, indent=2))
" "$PORT" "$PORT_OVERRIDE_ACK_SET" 2>/dev/null || printf '%s\n' "$DEEP_BODY"
  exit 1
elif [[ "$DEEP_INDET" == "true" ]]; then
  log "UNKNOWN (deferred): /api/health/deep indeterminate on a non-hard-fail check — continuing to pm2/outside-in/CF probes before a final verdict"
elif [[ "$DEEP_PASS" != "true" ]]; then
  # Defensive fallback: should be unreachable given route.ts's aggregation
  # (pass=false with indeterminate=false implies a hard fail, caught above),
  # but never silently swallow an unexpected shape as a false PASS.
  printf '%s\n' "$DEEP_BODY"; exit 1
else
  log "/api/health/deep: PASS"
fi

# ── (b1) pm2 topology — CC-scoped ────────────────────────────────────────────
# FIX: write PM2_RAW and Python to temp files — heredoc binds stdin, pipe data
# is discarded; Python sys.stdin.read() returns '' when heredoc is present.
PM2_PASS="skip"; PM2_JSON='{"app_count":0,"crash_loopers":[],"db_path_set":false,"cwd_ok":false,"null_cwd_count":0,"other_cc_apps":[],"other_cc_count":0}'
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
    --port "$PORT" --app-name "$PM2_APP_NAME" \
    ${CANONICAL_DIR:+--canonical-dir "$CANONICAL_DIR"} < "$_J" 2>/dev/null \
    || echo '{"error":"pm2-analyze-cc.py failed","app_count":0,"crash_loopers":[],"db_path_set":false,"cwd_ok":false,"null_cwd_count":0,"other_cc_apps":[],"other_cc_count":0}')
  rm -f "$_J"

  PM2_COUNT=$(printf '%s' "$PM2_JSON" | py "d.get('app_count',0)" 0)
  PM2_CRASH=$(printf '%s' "$PM2_JSON" | py "cl=d.get('crash_loopers',[]); '[]' if not cl else json.dumps(cl)" "[]")
  NULL_CWD=$(printf '%s'  "$PM2_JSON" | py "d.get('null_cwd_count',0)" 0)
  # FIX (Issue 1): also extract cwd_ok — null-cwd is caught above, but a
  # wrong-but-non-null cwd (app running from wrong dir with --canonical-dir
  # set) requires its own FAIL branch.  Without this, cwd_ok=false is
  # computed but never acted on → wrong-cwd exits 0 GREEN.
  CWD_OK=$(printf '%s'     "$PM2_JSON" | py "'true' if d.get('cwd_ok') else 'false'" "false")
  # Trap-4: OTHER CC-ish apps (demo/staging on other ports) are reported, never gated on.
  # Modelled on the embedding_health WARN below: operational information that the
  # operator must see, but which does NOT change the green/red verdict or EXIT_CODE.
  OTHER_CC=$(printf '%s'   "$PM2_JSON" | py "d.get('other_cc_count',0)" 0)
  OTHER_LINE=$(printf '%s' "$PM2_JSON" | py "', '.join('%s(port=%s,%s)' % (o.get('name'),o.get('port'),o.get('status')) for o in d.get('other_cc_apps',[])) or 'none'" "unparseable")
  if [[ "$OTHER_CC" -gt 0 ]]; then
    log "WARN: ${OTHER_CC} other CC app(s) present on this box — ${OTHER_LINE} (not the deploy target ${PM2_APP_NAME}:${PORT}; non-gating)"
  fi

  # ZOMBIE means: two or more apps claim THE TARGET (same port, or the target
  # name with no port pm2 can see) — a real duplicate that must still FAIL.
  # It does NOT mean "more than one CC app exists on the machine".
  if   [[ "$PM2_COUNT" -eq 0 ]];     then log "FAIL: no pm2 app for target ${PM2_APP_NAME}:${PORT} (other CC apps seen: ${OTHER_LINE})"; PM2_PASS="fail"
  elif [[ "$PM2_COUNT" -gt 1 ]];     then log "FAIL: ${PM2_COUNT} pm2 apps claim target ${PM2_APP_NAME}:${PORT} (duplicate/zombie)"; PM2_PASS="fail"
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
# 3xx → row 26 FAIL, UNLESS it is the in-app interview-lock gate OR a genuine
# Cloudflare Access login-challenge redirect (both see below).
# 000 → row 27 UNKNOWN.  200+CF-challenge → new row UNKNOWN.
# U51 regression fix: Cloudflare Access newly enabled on a box now correctly
# 302s every unauthenticated request to its own off-origin login page BEFORE
# this script's own interview-lock check could ever see it — the old code
# scored that as row-26 FAIL (indistinguishable from a dead origin). Reachable
# + correctly gated by Access is a real security improvement, not an outage.
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
    elif is_cloudflare_access_login_redirect "$CF_LOC"; then
      # U51 fix: genuine off-origin Cloudflare Access login-challenge redirect.
      # The origin answered, Cloudflare routed the request, and Access
      # correctly intercepted it pre-origin — reachable + protected: PASS.
      CF_PASS="pass"; CF_DETAIL="CF public URL → HTTP ${CF_HTTP} to Cloudflare Access login (${CF_LOC}) — reachable, correctly gated by CF Access: PASS"
    else
      CF_PASS="fail"; CF_DETAIL="CF redirected HTTP ${CF_HTTP} → ${CF_LOC:-<no location>} (row 26: FAIL)"
    fi
  elif [[ "$CF_HTTP" == "200" ]] && printf '%s' "$CF_BODY" | grep -qi 'cloudflare access\|cf-access-login\|cf_chl'; then
    CF_INDET=true; CF_DETAIL="CF Access policy misconfigured: public URL returns CF challenge (UNKNOWN)"
  elif [[ "$CF_HTTP" == "200" ]]; then CF_PASS="pass"; CF_DETAIL="CF public URL → HTTP 200: PASS"
  else CF_PASS="fail"; CF_DETAIL="CF public URL → HTTP ${CF_HTTP}: FAIL"; fi
else CF_INDET=true; fi
[[ "$CF_INDET" == "true" ]] && log "UNKNOWN: ${CF_DETAIL}" || log "CF probe: ${CF_PASS} — ${CF_DETAIL}"

# ── (d) dual-store embedding health (F2.3 / DEP-11) — NON-GATING WARN ─────────
# Surfaces the persona index (Gemini-only) and the SOP/routing index side-by-side
# so an asymmetric degradation (e.g. an OpenAI-only box: semantic SOP routing but
# keyword-only persona Layer-5) is VISIBLE in the heartbeat. This is operational,
# not a correctness fault — keyword fallback still serves — so it NEVER changes the
# green/red verdict or EXIT_CODE. It only logs a WARN and is attached to the JSON.
_SDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EMB_SCRIPT="${EMBEDDING_HEALTH_SCRIPT:-$(cd "$_SDIR/.." && pwd)/shared-utils/embedding_health.py}"
EMB_JSON='{"check":"dual_store_embedding_health","degraded":true,"asymmetric":false,"asymmetric_detail":"embedding_health.py not found","source":"missing"}'
if [[ -f "$EMB_SCRIPT" ]]; then
  EMB_JSON=$(python3 -s "$EMB_SCRIPT" --format json --sop-db "${DATABASE_PATH:-$(pwd)/mission-control.db}" 2>/dev/null \
    || echo '{"check":"dual_store_embedding_health","degraded":true,"asymmetric":false,"asymmetric_detail":"embedding_health.py probe failed","source":"error"}')
  EMB_LINE=$(printf '%s' "$EMB_JSON" | python3 -s -c "
import sys,json
d=json.load(sys.stdin)
def one(s):
    if not s: return 'unavailable'
    return '%s=%s/%s rows=%s stale=%s semantic=%s' % (s.get('store'), s.get('provider') or 'none', s.get('model') or '-', s.get('total_rows'), s.get('stale_rows'), 'yes' if s.get('semantic_ready') else 'NO')
print('%s | %s' % (one(d.get('persona_index')), one(d.get('sop_index'))))
" 2>/dev/null || echo "unparseable")
  EMB_ASYM=$(printf '%s' "$EMB_JSON" | py "'true' if d.get('asymmetric') else 'false'" "false")
  EMB_DEG=$(printf '%s' "$EMB_JSON" | py "'true' if d.get('degraded') else 'false'" "false")
  if [[ "$EMB_ASYM" == "true" ]]; then
    log "WARN: embedding stores ASYMMETRIC — $EMB_LINE (operational; keyword fallback active)"
  elif [[ "$EMB_DEG" == "true" ]]; then
    log "WARN: embedding stores degraded — $EMB_LINE"
  else
    log "embedding health: OK — $EMB_LINE"
  fi
else
  log "WARN: embedding_health.py not found at $EMB_SCRIPT — dual-store health not reported"
fi

# ── verdict ───────────────────────────────────────────────────────────────────
FINAL_PASS=true; EXIT_CODE=0; FINAL_INDET=false
[[ "$PM2_PASS"   == "fail" ]]  && FINAL_PASS=false && EXIT_CODE=1
[[ "$ASSET_PASS" == "fail" ]]  && FINAL_PASS=false && EXIT_CODE=1
[[ "$CF_PASS"    == "fail" ]]  && FINAL_PASS=false && EXIT_CODE=1
[[ "$CF_INDET"   == "true" ]]  && FINAL_INDET=true
[[ "$ASSET_INDET" == "true" ]] && FINAL_INDET=true  # P2 FIX: no-ref path → exit 3
# U51 fix: DEEP_INDET (deferred above, not exited on) now feeds the SAME
# verdict aggregation as CF_INDET/ASSET_INDET instead of forcing an early
# exit that skipped pm2/outside-in/CF entirely. A deep-check indeterminate
# still yields exit 3 UNKNOWN if nothing else resolves it — but the box now
# gets a real chance for its OTHER probes to confirm health first, and the
# emitted JSON always carries pm2_topology/outside_in_asset/cf_probe so a
# ledger consumer never sees a payload that stopped before those stages ran.
[[ "$DEEP_INDET"  == "true" ]] && FINAL_INDET=true
[[ "$FINAL_INDET" == "true" && "$EXIT_CODE" -eq 0 ]] && FINAL_PASS=false && EXIT_CODE=3
printf '%s\n' "$DEEP_BODY" | python3 -s -c "
import sys,json
d=json.load(sys.stdin)
d['pass']=(sys.argv[1]=='true'); d['source']='cc-health-check.sh'
d['pm2_topology']=json.loads(sys.argv[2])
d['outside_in_asset']={'pass':sys.argv[3]!='fail','asset_ref':sys.argv[4]}
d['cf_probe']={'pass':sys.argv[5]=='pass','indeterminate':sys.argv[6]=='true','detail':sys.argv[7]}
try:
    d['embedding_health']=json.loads(sys.argv[8])
except Exception:
    d['embedding_health']=None
try:
    d['cc_port']=int(sys.argv[9])
except Exception:
    d['cc_port']=None
d['override_ack_set']=(sys.argv[10]=='true')
print(json.dumps(d,indent=2))
" "$FINAL_PASS" "$PM2_JSON" "$ASSET_PASS" "${ASSET_REF:-none}" "$CF_PASS" "$FINAL_INDET" "$CF_DETAIL" "${EMB_JSON:-null}" "$PORT" "$PORT_OVERRIDE_ACK_SET" 2>/dev/null || \
  printf '{"pass":%s,"indeterminate":%s,"timestamp":"%s","cc_port":%s,"override_ack_set":%s}\n' "$FINAL_PASS" "$FINAL_INDET" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${PORT:-null}" "$PORT_OVERRIDE_ACK_SET"

# ── U014: remote client health probe ────────────────────────────────────────
gateway_to_http_base() {
  local gw="$1"
  printf '"'"'%s'"'"' "$gw" | sed -E '"'"'s#^ws://#http://#;s#^wss://#https://#'"'"'
}

probe_remote_client() {
  local client_id="$1" client_name="$2" gateway_url="$3"
  local http_base probe_url probe_json probe_code probe_pass probe_indet ts
  http_base="$(gateway_to_http_base "$gateway_url")"
  probe_url="${http_base}/api/health/deep"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "DRY-RUN: would probe remote client '"'"'${client_name}'"'"' (${client_id}) via ${probe_url}"
    printf '"'"'{"client_id":"%s","client_name":"%s","gateway_url":"%s","probe_url":"%s","pass":true,"indeterminate":false,"timestamp":"%s","detail":"dry-run — no probes executed"}\n'"'"'       "$client_id" "$client_name" "$gateway_url" "$probe_url" "$ts"
    return 0
  fi

  log "remote: probing client '"'"'${client_name}'"'"' (${client_id}) via ${probe_url}"

  probe_json=$(curl -s --max-time 15 --max-redirs 0     --write-out '"'"'{"_http_code":%{http_code}}'"'"'     "${probe_url}" 2>/dev/null || echo '"'"'{"_error":"curl_failed"}'"'"')

  probe_body=$(printf '"'"'%s\n'"'"' "$probe_json" | awk '"'"'NR>1{print prev} {prev=$0}'"'"')
  probe_code=$(printf '"'"'%s\n'"'"' "$probe_json" | awk '"'"'END{print}'"'"' | py "d.get('"'"'_http_code'"'"',0)" 0)

  if [[ "$probe_code" == "0" ]]; then
    log "remote: client '"'"'${client_name}'"'"' UNREACHABLE"
    printf '"'"'{"client_id":"%s","client_name":"%s","gateway_url":"%s","probe_url":"%s","pass":false,"indeterminate":true,"timestamp":"%s","detail":"unreachable","http_code":0}\n'"'"'       "$client_id" "$client_name" "$gateway_url" "$probe_url" "$ts"
    return 3
  fi

  if [[ "$probe_code" != "200" ]]; then
    log "remote: client '"'"'${client_name}'"'"' → HTTP ${probe_code}"
    probe_pass="false"; probe_indet="false"
    case "$probe_code" in
      500|502|503|504) probe_indet="true" ;;
    esac
    printf '"'"'{"client_id":"%s","client_name":"%s","gateway_url":"%s","probe_url":"%s","pass":%s,"indeterminate":%s,"timestamp":"%s","detail":"HTTP %s","http_code":%s}\n'"'"'       "$client_id" "$client_name" "$gateway_url" "$probe_url" "$probe_pass" "$probe_indet" "$ts" "$probe_code" "$probe_code"
    [[ "$probe_indet" == "true" ]] && return 3 || return 1
  fi

  probe_pass=$(printf '"'"'%s'"'"' "$probe_body" | py "'"'"'true'"'"' if d.get('"'"'pass'"'"') else '"'"'false'"'"'" "false")
  probe_indet=$(printf '"'"'%s'"'"' "$probe_body" | py "'"'"'true'"'"' if d.get('"'"'indeterminate'"'"') else '"'"'false'"'"'" "false")
  log "remote: client '"'"'${client_name}'"'"' → pass=${probe_pass} indeterminate=${probe_indet}"
  printf '"'"'{"client_id":"%s","client_name":"%s","gateway_url":"%s","probe_url":"%s","pass":%s,"indeterminate":%s,"timestamp":"%s","detail":"probed","http_code":200}\n'"'"'     "$client_id" "$client_name" "$gateway_url" "$probe_url" "$probe_pass" "$probe_indet" "$ts"
  [[ "$probe_pass" == "true" ]] && return 0
  [[ "$probe_indet" == "true" ]] && return 3
  return 1
}

run_remote_health() {
  log "remote: reading registered clients from ${DATABASE_PATH}"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "remote: DRY-RUN — would query clients table in ${DATABASE_PATH}"
  fi

  if ! command -v sqlite3 &>/dev/null; then
    log "remote: sqlite3 not found — cannot read clients table"
    return 0
  fi

  if [[ ! -f "$DATABASE_PATH" ]]; then
    log "remote: database not found at ${DATABASE_PATH} — no remote clients to probe"
    return 0
  fi

  local clients_json
  clients_json=$(sqlite3 -json "$DATABASE_PATH"     "SELECT id, name, gateway_url FROM clients WHERE is_self = 0 ORDER BY name ASC" 2>/dev/null || echo "[]")

  local client_count
  client_count=$(printf '"'"'%s'"'"' "$clients_json" | py "len(d)" 0)

  if [[ "$client_count" -eq 0 ]]; then
    log "remote: no remote clients registered"
    return 0
  fi

  log "remote: found ${client_count} remote client(s)"

  local client_ids=() client_names=() client_gws=() idx count cid cname cgw line IFS_OLD
  IFS_OLD="$IFS"
  while IFS= read -r line; do
    IFS=$'"'"'\t'"'"' read -r cid cname cgw <<< "$line"
    client_ids+=("$cid")
    client_names+=("$cname")
    client_gws+=("$cgw")
  done < <(printf '"'"'%s'"'"' "$clients_json" | python3 -s -c "
import sys, json
clients = json.load(sys.stdin)
for c in clients:
    print('"'"'\t'"'"'.join([c.get('"'"'id'"'"','"'"''"'"'), c.get('"'"'name'"'"','"'"''"'"'), c.get('"'"'gateway_url'"'"','"'"''"'"')]))
" 2>/dev/null)
  IFS="$IFS_OLD"

  count=${#client_ids[@]}
  for ((idx=0; idx<count; idx++)); do
    probe_remote_client "${client_ids[$idx]}" "${client_names[$idx]}" "${client_gws[$idx]}"
  done
}

if [[ "$REMOTE_MODE" -eq 1 ]]; then
  run_remote_health
fi

exit "$EXIT_CODE"
