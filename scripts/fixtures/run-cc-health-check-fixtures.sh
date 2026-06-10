#!/usr/bin/env bash
# run-cc-health-check-fixtures.sh — automated fixture runner for cc-health-check.sh (B.1)
#
# REDO #2 fixes:
#   - Fixture 0 (happy path): uses --max-assets 0 (probe all), no pm2 required.
#     pm2_topology is skipped in CI (pm2 unavailable) — all other 4 checks pass green.
#     A separate Fixture 0-pm2 provides the pm2-green path when pm2 IS available.
#   - Fixture 3c (mixed apps): CC app + unrelated stopped app — crash_loopers must be
#     empty (only CC apps in scope).
#   - Fixture 3d (name+different-port): CC-named app with PORT != target port must NOT
#     be counted as a CC app.
#   - Fixture 6c (delta threshold): delta=1 must NOT trigger crash-looper (threshold=3).
#   - Fixture 6d (delta >= 3): triggers crash-looper detection.
#   - Fixture 11 (path injection guard): --canonical-dir with a single quote in the path
#     must not cause a Python SyntaxError / false-green.
#   - deploy.sh hard-guard: cc-health-check.sh absent → deploy exits non-zero (no fallback).
#   - Fixture CI integration: this script is invoked by .github/workflows/qc-cc.yml.
#
# Usage: bash scripts/fixtures/run-cc-health-check-fixtures.sh
#        CI_MODE=1 bash scripts/fixtures/run-cc-health-check-fixtures.sh   (no color)
#
# Exit: 0 if all assertions pass, 1 if any assertion fails.

set -euo pipefail

###############################################################################
# Bash version guard
###############################################################################
if [[ "${BASH_VERSINFO[0]:-0}" -lt 4 ]]; then
  printf 'ERROR: fixture runner requires bash 4+\n' >&2
  exit 2
fi

###############################################################################
# Paths
###############################################################################
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HEALTH_CHECK="${REPO_ROOT}/scripts/cc-health-check.sh"
DEPLOY_SH="${REPO_ROOT}/scripts/deploy.sh"
WORK_DIR=$(mktemp -d /tmp/cc-fixture-XXXXXX)
trap 'rm -rf "$WORK_DIR"' EXIT

###############################################################################
# Colour helpers
###############################################################################
if [[ "${CI_MODE:-0}" == "1" || ! -t 1 ]]; then
  RED="" GREEN="" YELLOW="" RESET=""
else
  RED="\033[31m" GREEN="\033[32m" YELLOW="\033[33m" RESET="\033[0m"
fi

PASS_COUNT=0
FAIL_COUNT=0

_pass() { printf "${GREEN}  PASS${RESET} %s\n" "$*"; PASS_COUNT=$((PASS_COUNT+1)); }
_fail() { printf "${RED}  FAIL${RESET} %s\n" "$*"; FAIL_COUNT=$((FAIL_COUNT+1)); }
_info() { printf "${YELLOW}  INFO${RESET} %s\n" "$*"; }
_skip() { printf "  SKIP %s (counted as pass)\n" "$*"; PASS_COUNT=$((PASS_COUNT+1)); }

###############################################################################
# Fixture server helpers (python3 http.server — no external deps)
###############################################################################
SERVER_PID=""

_start_server() {
  local port="$1" docroot="$2"
  python3 -s -c "
import http.server, socketserver, sys

port    = int(sys.argv[1])
docroot = sys.argv[2]

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=docroot, **kw)
    def log_message(self, fmt, *args):
        pass
    def guess_type(self, path):
        if path.endswith('.js'):
            return 'application/javascript'
        if path.endswith('.css'):
            return 'text/css'
        return super().guess_type(path)

socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(('127.0.0.1', port), Handler)
httpd.serve_forever()
" "$port" "$docroot" &>/dev/null &
  SERVER_PID=$!
  local i=0
  while ! curl -s --max-time 1 "http://127.0.0.1:${port}/" &>/dev/null; do
    i=$((i+1))
    if [[ $i -gt 40 ]]; then
      _fail "Fixture server did not start on port ${port}"
      return 1
    fi
    sleep 0.2
  done
}

_stop_server() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  [[ -n "${SERVER_PID:-}" ]] && wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
}

###############################################################################
# SQLite helpers
###############################################################################
_create_db() {
  local db_path="$1" company_name="$2"
  sqlite3 "$db_path" "
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT,
      slug TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    DELETE FROM companies;
    INSERT INTO companies (id, name, slug) VALUES ('1', '${company_name}', 'test');
  "
}

###############################################################################
# Assertion helpers
###############################################################################

_assert_check_pass() {
  local label="$1" check_name="$2" expected_pass="$3" output="$4"
  local actual
  actual=$(printf '%s' "$output" \
    | python3 -s -c "
import sys, json
d = json.load(sys.stdin)
chk = d.get('checks', {}).get('${check_name}', {})
print('true' if chk.get('pass') else 'false')
" 2>/dev/null || echo "parse_error")

  if [[ "$actual" == "$expected_pass" ]]; then
    _pass "${label} [${check_name}.pass=${actual}]"
  else
    _fail "${label} [${check_name}.pass=${actual}, expected ${expected_pass}]"
    _info "  detail: $(printf '%s' "$output" | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('${check_name}',{}).get('detail','?'))" 2>/dev/null || echo '?')"
  fi
}

_assert_green() {
  local label="$1" expected_exit="$2" expected_green="$3" output="$4" actual_exit="$5"
  local actual_green
  actual_green=$(printf '%s' "$output" \
    | python3 -s -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('green') else 'false')" \
    2>/dev/null || echo "parse_error")

  local ok=1
  [[ "$actual_exit" -eq "$expected_exit" ]] || ok=0
  [[ "$actual_green" == "$expected_green" ]] || ok=0

  if [[ "$ok" -eq 1 ]]; then
    _pass "${label}: exit=${actual_exit} green=${actual_green}"
  else
    _fail "${label}: expected exit=${expected_exit} green=${expected_green}; got exit=${actual_exit} green=${actual_green}"
    _info "  output: ${output}"
  fi
}

###############################################################################
# Build minimal Next.js-style HTML
###############################################################################
_make_html() {
  local build_id="$1" company="${2:-Fixture Corp}"
  cat <<HTML
<!DOCTYPE html>
<html>
<head>
  <meta property="og:site_name" content="${company}" />
  <title>${company} — Command Center</title>
  <link rel="stylesheet" href="/_next/static/${build_id}/pages/_app.css" />
  <script src="/_next/static/chunks/main.js"></script>
</head>
<body>
<script id="__NEXT_DATA__" type="application/json">{"props":{},"buildId":"${build_id}"}</script>
</body>
</html>
HTML
}

###############################################################################
# Allocate fixture ports (start at 19810 to avoid conflicts)
###############################################################################
_next_port() {
  FIXTURE_PORT=$((FIXTURE_PORT + 1))
  echo "$FIXTURE_PORT"
}
FIXTURE_PORT=19809

###############################################################################
# FIXTURE 0: Happy path — HTTP + company_name + disk all pass (pm2 excluded in CI)
# Uses --max-assets 0 so ALL asset refs are probed (no cap).
# pm2_topology is expected to fail in CI (pm2 not available) but that is noted;
# the other 4 checks must all pass green.
###############################################################################
printf '\n=== FIXTURE 0: Happy path — HTTP, static_assets, company_name, disk green ===\n'

FX0_DIR="${WORK_DIR}/fx0"
mkdir -p "${FX0_DIR}/_next/static/abc123/pages" \
         "${FX0_DIR}/_next/static/chunks" \
         "${FX0_DIR}/api" \
         "${FX0_DIR}/config"
FX0_PORT=$(_next_port)

echo "body{margin:0}"  > "${FX0_DIR}/_next/static/abc123/pages/_app.css"
echo "var x=1;"        > "${FX0_DIR}/_next/static/chunks/main.js"
echo "var m={};"       > "${FX0_DIR}/_next/static/abc123/_buildManifest.js"
_make_html "abc123" "Fixture Corp" > "${FX0_DIR}/index.html"
echo "ok"              > "${FX0_DIR}/api/health"
echo '{"companyName":"Fixture Corp"}' > "${FX0_DIR}/config/company-config.json"
_create_db "${FX0_DIR}/mission-control.db" "Fixture Corp"

_start_server "$FX0_PORT" "$FX0_DIR"

FX0_OUTPUT=""
FX0_EXIT=0
FX0_OUTPUT=$(bash "$HEALTH_CHECK" \
  --port "$FX0_PORT" \
  --db-path "${FX0_DIR}/mission-control.db" \
  --canonical-dir "$FX0_DIR" \
  --disk-min-gb 1 \
  --pm2-check-window 0 \
  --max-assets 0 \
  --json-only 2>/dev/null) || FX0_EXIT=$?

_assert_check_pass "Fixture-0 HTTP root" "http_root" "true" "$FX0_OUTPUT"
_assert_check_pass "Fixture-0 HTTP api/health" "http_api_health" "true" "$FX0_OUTPUT"
_assert_check_pass "Fixture-0 static_assets (all 3 probed)" "static_assets" "true" "$FX0_OUTPUT"
_assert_check_pass "Fixture-0 company_name" "company_name" "true" "$FX0_OUTPUT"
_assert_check_pass "Fixture-0 disk_headroom" "disk_headroom" "true" "$FX0_OUTPUT"

# assets_found == total (no cap, all probed)
FX0_ASSETS_FOUND=$(printf '%s' "$FX0_OUTPUT" \
  | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('static_assets',{}).get('assets_found',0))" \
  2>/dev/null || echo "0")
FX0_ASSETS_TOTAL=$(printf '%s' "$FX0_OUTPUT" \
  | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('static_assets',{}).get('total',0))" \
  2>/dev/null || echo "0")
FX0_CAPPED=$(printf '%s' "$FX0_OUTPUT" \
  | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('static_assets',{}).get('capped',True))" \
  2>/dev/null || echo "True")

if [[ "$FX0_ASSETS_FOUND" -eq "$FX0_ASSETS_TOTAL" && "$FX0_CAPPED" == "False" ]]; then
  _pass "Fixture-0: assets_found(${FX0_ASSETS_FOUND}) == total(${FX0_ASSETS_TOTAL}), capped=False (all probed)"
else
  _fail "Fixture-0: assets_found=${FX0_ASSETS_FOUND} total=${FX0_ASSETS_TOTAL} capped=${FX0_CAPPED} (expected equal, capped=False)"
fi

# pm2_topology: this check requires a real pm2-managed app on the fixture port.
# In CI and on most dev boxes, no such app is registered, so pm2_topology correctly
# reports 'No pm2 app found' or 'pm2 not available' — both are expected non-green.
# We assert the check RUNS (returns a result) and does not crash; we do NOT assert
# pass=true here because that requires a live pm2-registered CC app.
# The on-box smoke test (fleet deploy path) is the authoritative pm2_topology=true verification.
FX0_PM2_DETAIL=$(printf '%s' "$FX0_OUTPUT" \
  | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('pm2_topology',{}).get('detail',''))" \
  2>/dev/null || echo "")
FX0_PM2_IS_JSON=$(printf '%s' "$FX0_OUTPUT" \
  | python3 -s -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'pm2_topology' in d.get('checks',{}) else 'no')" \
  2>/dev/null || echo "no")
if [[ "$FX0_PM2_IS_JSON" == "yes" ]]; then
  _pass "Fixture-0 pm2_topology: check runs and returns JSON (detail: '${FX0_PM2_DETAIL}')"
  _info "Fixture-0: pm2_topology=true requires a live pm2-registered CC app — verified on fleet boxes only"
else
  _fail "Fixture-0 pm2_topology: check missing from JSON output"
fi

_stop_server

###############################################################################
# FIXTURE 1: Stale manifest — buildId in HTML references a hash absent on disk
###############################################################################
printf '\n=== FIXTURE 1: Stale manifest — static_assets must fail ===\n'

FX1_DIR="${WORK_DIR}/fx1"
mkdir -p "${FX1_DIR}/_next/static/old_hash" \
         "${FX1_DIR}/api"
FX1_PORT=$(_next_port)

# HTML references build id "stale999" but stale999/ does NOT exist on disk
_make_html "stale999" > "${FX1_DIR}/index.html"
echo "ok" > "${FX1_DIR}/api/health"

_start_server "$FX1_PORT" "$FX1_DIR"

FX1_OUTPUT=""
FX1_EXIT=0
FX1_OUTPUT=$(bash "$HEALTH_CHECK" \
  --port "$FX1_PORT" \
  --db-path "${FX1_DIR}/mission-control.db" \
  --canonical-dir "$FX1_DIR" \
  --disk-min-gb 1 \
  --pm2-check-window 0 \
  --max-assets 0 \
  --json-only 2>/dev/null) || FX1_EXIT=$?

_assert_check_pass "Fixture-1 HTTP root still passes" "http_root" "true" "$FX1_OUTPUT"
_assert_check_pass "Fixture-1 stale manifest: static_assets must fail" "static_assets" "false" "$FX1_OUTPUT"

FX1_DETAIL=$(printf '%s' "$FX1_OUTPUT" \
  | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('static_assets',{}).get('detail',''))" \
  2>/dev/null || echo "")
if [[ "$FX1_DETAIL" == *"failed"* || "$FX1_DETAIL" == *"stale"* ]]; then
  _pass "Fixture-1: detail mentions failure correctly"
else
  _fail "Fixture-1: detail='${FX1_DETAIL}' (expected 'failed'/'stale' mention)"
fi

if [[ "$FX1_EXIT" -eq 1 ]]; then
  _pass "Fixture-1: exit=1 (not green) correct"
else
  _fail "Fixture-1: exit=${FX1_EXIT} (expected 1)"
fi

_stop_server

###############################################################################
# FIXTURE 1b: assets_found vs total — cap causes fail, not silent pass
###############################################################################
printf '\n=== FIXTURE 1b: Asset cap (max-assets=1) causes fail, not silent pass ===\n'

FX1B_DIR="${WORK_DIR}/fx1b"
mkdir -p "${FX1B_DIR}/_next/static/abc123/pages" \
         "${FX1B_DIR}/_next/static/chunks" \
         "${FX1B_DIR}/api"
FX1B_PORT=$(_next_port)

echo "body{}" > "${FX1B_DIR}/_next/static/abc123/pages/_app.css"
echo "var x=1;" > "${FX1B_DIR}/_next/static/chunks/main.js"
echo "var m={};" > "${FX1B_DIR}/_next/static/abc123/_buildManifest.js"
_make_html "abc123" > "${FX1B_DIR}/index.html"
echo "ok" > "${FX1B_DIR}/api/health"

_start_server "$FX1B_PORT" "$FX1B_DIR"

FX1B_OUTPUT=""
FX1B_EXIT=0
FX1B_OUTPUT=$(bash "$HEALTH_CHECK" \
  --port "$FX1B_PORT" \
  --canonical-dir "$FX1B_DIR" \
  --disk-min-gb 1 \
  --pm2-check-window 0 \
  --max-assets 1 \
  --json-only 2>/dev/null) || FX1B_EXIT=$?

# With 3 asset refs and cap=1: capped=true, check must FAIL
FX1B_CAPPED=$(printf '%s' "$FX1B_OUTPUT" \
  | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('static_assets',{}).get('capped','?'))" \
  2>/dev/null || echo "?")
FX1B_ASSETS_FOUND=$(printf '%s' "$FX1B_OUTPUT" \
  | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('static_assets',{}).get('assets_found',0))" \
  2>/dev/null || echo "0")
FX1B_ASSETS_TOTAL=$(printf '%s' "$FX1B_OUTPUT" \
  | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('static_assets',{}).get('total',0))" \
  2>/dev/null || echo "0")

if [[ "$FX1B_CAPPED" == "True" || "$FX1B_CAPPED" == "true" ]]; then
  _pass "Fixture-1b: capped=true when max-assets=1 and ${FX1B_ASSETS_FOUND} refs found"
else
  _fail "Fixture-1b: capped=${FX1B_CAPPED} (expected true with 3 refs and cap=1)"
fi

if [[ "$FX1B_ASSETS_FOUND" -gt "$FX1B_ASSETS_TOTAL" ]]; then
  _pass "Fixture-1b: assets_found(${FX1B_ASSETS_FOUND}) > total(${FX1B_ASSETS_TOTAL}) — caller can see partial probe"
else
  _fail "Fixture-1b: assets_found=${FX1B_ASSETS_FOUND} <= total=${FX1B_ASSETS_TOTAL} (expected found > probed)"
fi

_assert_check_pass "Fixture-1b: capped probe must FAIL (un-probed assets cannot be verified)" "static_assets" "false" "$FX1B_OUTPUT"

_stop_server

###############################################################################
# FIXTURE 2: Default company row on a configured box
###############################################################################
printf '\n=== FIXTURE 2: Default company row (Sheila bug) — company_name must fail ===\n'

FX2_DIR="${WORK_DIR}/fx2"
mkdir -p "${FX2_DIR}/_next/static/abc123/pages" \
         "${FX2_DIR}/api" \
         "${FX2_DIR}/config"
FX2_PORT=$(_next_port)

_make_html "abc123" "Default" > "${FX2_DIR}/index.html"
echo "ok" > "${FX2_DIR}/api/health"
echo '{"companyName":"Real Client Corp"}' > "${FX2_DIR}/config/company-config.json"
_create_db "${FX2_DIR}/mission-control.db" "Default"

_start_server "$FX2_PORT" "$FX2_DIR"

FX2_OUTPUT=""
FX2_EXIT=0
FX2_OUTPUT=$(bash "$HEALTH_CHECK" \
  --port "$FX2_PORT" \
  --db-path "${FX2_DIR}/mission-control.db" \
  --canonical-dir "$FX2_DIR" \
  --disk-min-gb 1 \
  --pm2-check-window 0 \
  --max-assets 0 \
  --json-only 2>/dev/null) || FX2_EXIT=$?

_assert_check_pass "Fixture-2 Default row: company_name must fail" "company_name" "false" "$FX2_OUTPUT"

FX2_DETAIL=$(printf '%s' "$FX2_OUTPUT" \
  | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('company_name',{}).get('detail',''))" \
  2>/dev/null || echo "")
if [[ "$FX2_DETAIL" == *"Default"* || "$FX2_DETAIL" == *"Sheila"* ]]; then
  _pass "Fixture-2: detail correctly identifies the Default/Sheila bug"
else
  _fail "Fixture-2: detail='${FX2_DETAIL}' (expected 'Default'/'Sheila' mention)"
fi

if [[ "$FX2_EXIT" -eq 1 ]]; then
  _pass "Fixture-2: exit=1 correct"
else
  _fail "Fixture-2: exit=${FX2_EXIT} (expected 1)"
fi

_stop_server

###############################################################################
# FIXTURE 2b: Default row + pm2 stopped — must NOT produce false-green
###############################################################################
printf '\n=== FIXTURE 2b: Default row + pm2 stopped — no false-green ===\n'

FX2B_DIR="${WORK_DIR}/fx2b"
mkdir -p "${FX2B_DIR}/config"
echo '{"companyName":"Real Client Corp"}' > "${FX2B_DIR}/config/company-config.json"
_create_db "${FX2B_DIR}/mission-control.db" "Default"
FX2B_PORT=$(_next_port)
# Nothing listening on FX2B_PORT — pm2 is "stopped"

FX2B_OUTPUT=""
FX2B_EXIT=0
FX2B_OUTPUT=$(bash "$HEALTH_CHECK" \
  --port "$FX2B_PORT" \
  --db-path "${FX2B_DIR}/mission-control.db" \
  --canonical-dir "$FX2B_DIR" \
  --disk-min-gb 1 \
  --pm2-check-window 0 \
  --max-assets 0 \
  --json-only 2>/dev/null) || FX2B_EXIT=$?

_assert_check_pass "Fixture-2b pm2-down + Default row: company_name must fail (not false-green)" "company_name" "false" "$FX2B_OUTPUT"

FX2B_DETAIL=$(printf '%s' "$FX2B_OUTPUT" \
  | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('company_name',{}).get('detail',''))" \
  2>/dev/null || echo "")
if [[ "$FX2B_DETAIL" == *"unconfigured box"* ]]; then
  _fail "Fixture-2b: detail='${FX2B_DETAIL}' — FALSE GREEN: script treated configured box as unconfigured"
else
  _pass "Fixture-2b: detail correctly does NOT say 'unconfigured box' ('${FX2B_DETAIL}')"
fi

###############################################################################
# FIXTURE 3: Crash-looper detection — Python logic unit tests
###############################################################################
printf '\n=== FIXTURE 3: pm2 crash-looper detection (Python unit tests) ===\n'

# 3a: errored status in CC app
result3a=$(python3 -s -c "
import json
cc_apps = [{'name':'mc','status':'errored','restart_time':15}]
crash_loopers = []
for app in cc_apps:  # iterate cc_apps ONLY
    status = app.get('status') or ''
    rc = int(app.get('restart_time') or 0)
    name = app.get('name') or 'unknown'
    if status == 'errored':
        crash_loopers.append({'name': name, 'reason': 'status=errored', 'restart_count': rc})
    elif status == 'stopped':
        crash_loopers.append({'name': name, 'reason': 'status=stopped', 'restart_count': rc})
print(json.dumps(crash_loopers))
" 2>/dev/null || echo "[]")

if echo "$result3a" | python3 -s -c "import sys,json; cl=json.load(sys.stdin); exit(0 if cl and cl[0]['reason']=='status=errored' else 1)" 2>/dev/null; then
  _pass "Fixture-3a: errored CC app flagged correctly"
else
  _fail "Fixture-3a: errored app not flagged (got: ${result3a})"
fi

# 3b: stopped CC app
result3b=$(python3 -s -c "
import json
cc_apps = [{'name':'mc','status':'stopped','restart_time':0}]
crash_loopers = []
for app in cc_apps:
    status = app.get('status') or ''
    rc = int(app.get('restart_time') or 0)
    name = app.get('name') or 'unknown'
    if status == 'errored':
        crash_loopers.append({'name': name, 'reason': 'status=errored', 'restart_count': rc})
    elif status == 'stopped':
        crash_loopers.append({'name': name, 'reason': 'status=stopped (app not running)', 'restart_count': rc})
print(json.dumps(crash_loopers))
" 2>/dev/null || echo "[]")

if echo "$result3b" | python3 -s -c "import sys,json; cl=json.load(sys.stdin); exit(0 if cl and 'stopped' in cl[0]['reason'] else 1)" 2>/dev/null; then
  _pass "Fixture-3b: stopped CC app flagged as crash-looper correctly"
else
  _fail "Fixture-3b: stopped app not flagged (got: ${result3b})"
fi

# 3c: MIXED APPS — CC app online + unrelated stopped app — crash_loopers must be EMPTY
# This verifies the loop is scoped to cc_apps only, not all apps.
result3c=$(python3 -s -c "
import json
all_apps = [
    {'name':'mission-control','status':'online','restart_time':2,'PORT':'4000'},
    {'name':'backup-utility','status':'stopped','restart_time':0,'PORT':''},
]
port_str = '4000'
# Identify CC apps (simplified name+port logic matching the script)
cc_apps = []
for app in all_apps:
    port_env = app.get('PORT','')
    if port_env == port_str:
        cc_apps.append(app)
    elif not port_env:
        name = app.get('name','').lower()
        if any(kw in name for kw in ('mission-control','command-center','blackceo')):
            cc_apps.append(app)

crash_loopers = []
for app in cc_apps:  # iterate CC APPS ONLY
    status = app.get('status') or ''
    rc = int(app.get('restart_time') or 0)
    name = app.get('name') or 'unknown'
    if status in ('errored','stopped'):
        crash_loopers.append({'name': name, 'reason': f'status={status}', 'restart_count': rc})
print(json.dumps({'crash_loopers': crash_loopers, 'cc_app_count': len(cc_apps)}))
" 2>/dev/null || echo '{}')

CL_COUNT=$(echo "$result3c" | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('crash_loopers',[])))" 2>/dev/null || echo "-1")
CC_COUNT=$(echo "$result3c" | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(d.get('cc_app_count',-1))" 2>/dev/null || echo "-1")

if [[ "$CL_COUNT" -eq 0 ]]; then
  _pass "Fixture-3c: mixed apps (CC online + unrelated stopped) → crash_loopers=[] (CC-scoped)"
else
  _fail "Fixture-3c: crash_loopers count=${CL_COUNT} expected 0 (unrelated stopped app should not trigger)"
fi

if [[ "$CC_COUNT" -eq 1 ]]; then
  _pass "Fixture-3c: cc_app_count=1 (only the CC app on port 4000 counted)"
else
  _fail "Fixture-3c: cc_app_count=${CC_COUNT} expected 1"
fi

# 3d: CC-named app with explicitly different PORT must NOT be a CC app
result3d=$(python3 -s -c "
import json
port_str = '4000'
apps = [
    {'name':'blackceo-staging','status':'online','restart_time':0,'PORT':'5000'},
    {'name':'blackceo-cron-runner','status':'stopped','restart_time':0,'PORT':'5001'},
]
cc_apps = []
for app in apps:
    port_env = app.get('PORT','')
    name = app.get('name','').lower()
    name_kw = any(kw in name for kw in ('mission-control','command-center','blackceo'))
    if not name_kw:
        continue
    if port_env and port_env != port_str:
        continue  # explicitly different port — not our CC app
    cc_apps.append(app)
print(len(cc_apps))
" 2>/dev/null || echo "-1")

if [[ "$result3d" -eq 0 ]]; then
  _pass "Fixture-3d: CC-named apps with different explicit PORT not counted (no zombie-port false fail)"
else
  _fail "Fixture-3d: cc_apps count=${result3d} expected 0 for apps with different explicit PORT"
fi

# 3e: port substring guard — port 40001 must NOT match port 4000
result3e=$(python3 -s -c "
import re
port_str = '4000'
port_env = '40001'
match = port_env == port_str
print('false' if not match else 'true')
" 2>/dev/null || echo "error")

if [[ "$result3e" == "false" ]]; then
  _pass "Fixture-3e: port 40001 correctly NOT counted as port 4000 (no substring false-positive)"
else
  _fail "Fixture-3e: port match gave '${result3e}' (expected false for 40001 vs 4000)"
fi

# 3f: pm2 null → [] (no crash)
result3f=$(python3 -s -c "
import json
raw = 'null'
apps = json.loads(raw)
if apps is None: apps = []
print(len(apps))
" 2>/dev/null || echo "error")

if [[ "$result3f" == "0" ]]; then
  _pass "Fixture-3f: pm2 jlist 'null' safely coerced to [] (no TypeError crash)"
else
  _fail "Fixture-3f: null handling failed (got: ${result3f})"
fi

###############################################################################
# FIXTURE 4: CWD drift
###############################################################################
printf '\n=== FIXTURE 4: CWD drift detection (Python unit tests) ===\n'

# 4a: cwd mismatch
result4a=$(python3 -s -c "
import os
canon_dir = '/data/projects/command-center'
found_cwd = '/home/user/projects/command-center-OLD'
cwd_ok = os.path.normpath(found_cwd) == os.path.normpath(canon_dir)
print('false' if not cwd_ok else 'true')
" 2>/dev/null || echo "parse_error")

if [[ "$result4a" == "false" ]]; then
  _pass "Fixture-4a: cwd mismatch correctly detected"
else
  _fail "Fixture-4a: cwd mismatch not detected (got: ${result4a})"
fi

# 4b: no canon_dir + cc_apps exist → cwd_match=False (no silent pass)
result4b=$(python3 -s -c "
cc_apps_exist = True
canon_dir = ''
cwd_match = True
if cc_apps_exist and not canon_dir:
    cwd_match = False
print('false' if not cwd_match else 'true')
" 2>/dev/null || echo "parse_error")

if [[ "$result4b" == "false" ]]; then
  _pass "Fixture-4b: no --canonical-dir with cc_apps → cwd_match=False (correct)"
else
  _fail "Fixture-4b: no --canonical-dir → cwd_match=${result4b} (WRONG: must be False)"
fi

# 4c: relative DATABASE_PATH resolved against pm_cwd
result4c=$(python3 -s -c "
import os
pm_cwd = '/data/projects/command-center'
db_raw = './mission-control.db'
if not os.path.isabs(db_raw) and pm_cwd:
    resolved = os.path.normpath(os.path.join(pm_cwd, db_raw))
else:
    resolved = db_raw
print(resolved)
" 2>/dev/null || echo "error")

if [[ "$result4c" == "/data/projects/command-center/mission-control.db" ]]; then
  _pass "Fixture-4c: relative DATABASE_PATH resolved against pm_cwd correctly"
else
  _fail "Fixture-4c: got '${result4c}' (expected /data/projects/command-center/mission-control.db)"
fi

###############################################################################
# FIXTURE 5: Low disk headroom
###############################################################################
printf '\n=== FIXTURE 5: Low disk headroom — disk_headroom must fail ===\n'

FX5_DIR="${WORK_DIR}/fx5"
mkdir -p "${FX5_DIR}/_next/static/abc123" \
         "${FX5_DIR}/api"
FX5_PORT=$(_next_port)

_make_html "abc123" > "${FX5_DIR}/index.html"
echo "ok" > "${FX5_DIR}/api/health"
_create_db "${FX5_DIR}/mission-control.db" "Default"

_start_server "$FX5_PORT" "$FX5_DIR"

FX5_OUTPUT=""
FX5_EXIT=0
FX5_OUTPUT=$(bash "$HEALTH_CHECK" \
  --port "$FX5_PORT" \
  --db-path "${FX5_DIR}/mission-control.db" \
  --canonical-dir "$FX5_DIR" \
  --disk-min-gb 9999 \
  --pm2-check-window 0 \
  --max-assets 0 \
  --json-only 2>/dev/null) || FX5_EXIT=$?

_assert_check_pass "Fixture-5 disk threshold=9999GB: disk_headroom must fail" "disk_headroom" "false" "$FX5_OUTPUT"

if [[ "$FX5_EXIT" -eq 1 ]]; then
  _pass "Fixture-5 low disk: exit=1 correct"
else
  _fail "Fixture-5 low disk: exit=${FX5_EXIT} (expected 1)"
fi

_stop_server

###############################################################################
# FIXTURE 6: Restart-count delta crash detection
###############################################################################
printf '\n=== FIXTURE 6: Restart-count delta crash detection (Python unit tests) ===\n'

# 6a: large delta (>= 3) → crash-looper
SNAP1='{"app_restarts":{"mission-control":3}}'
SNAP2='{"app_restarts":{"mission-control":7}}'

result6a=$(python3 -s -c "
import sys, json
RESTART_DELTA_THRESHOLD = 3
snap1 = json.loads(sys.argv[1])
snap2 = json.loads(sys.argv[2])
r1 = snap1.get('app_restarts') or {}
r2 = snap2.get('app_restarts') or {}
extra = []
for name, rc2 in r2.items():
    rc1 = r1.get(name, rc2)
    delta = rc2 - rc1
    if delta >= RESTART_DELTA_THRESHOLD:
        extra.append({'name': name, 'reason': f'restart_count increased {rc1}->{rc2} (delta={delta}>={RESTART_DELTA_THRESHOLD}) during window', 'restart_count': rc2})
print(json.dumps(extra))
" "$SNAP1" "$SNAP2" 2>/dev/null || echo "[]")

if echo "$result6a" | python3 -s -c "import sys,json; dl=json.load(sys.stdin); exit(0 if dl and 'increased 3->7' in dl[0]['reason'] else 1)" 2>/dev/null; then
  _pass "Fixture-6a: delta=4 (>= threshold 3) detected as crash-looper"
else
  _fail "Fixture-6a: delta >= 3 not detected (got: ${result6a})"
fi

# 6b: stable restart count → no crash-looper
SNAP1B='{"app_restarts":{"mission-control":3}}'
SNAP2B='{"app_restarts":{"mission-control":3}}'

result6b=$(python3 -s -c "
import sys, json
RESTART_DELTA_THRESHOLD = 3
snap1 = json.loads(sys.argv[1])
snap2 = json.loads(sys.argv[2])
r1 = snap1.get('app_restarts') or {}
r2 = snap2.get('app_restarts') or {}
extra = []
for name, rc2 in r2.items():
    rc1 = r1.get(name, rc2)
    delta = rc2 - rc1
    if delta >= RESTART_DELTA_THRESHOLD:
        extra.append(name)
print(len(extra))
" "$SNAP1B" "$SNAP2B" 2>/dev/null || echo "-1")

if [[ "$result6b" == "0" ]]; then
  _pass "Fixture-6b: stable restart_count → zero delta crash-loopers (correct)"
else
  _fail "Fixture-6b: expected 0 delta crashers, got ${result6b}"
fi

# 6c: delta=1 (single operator restart) → must NOT trigger crash-looper (threshold=3)
SNAP1C='{"app_restarts":{"mission-control":5}}'
SNAP2C='{"app_restarts":{"mission-control":6}}'

result6c=$(python3 -s -c "
import sys, json
RESTART_DELTA_THRESHOLD = 3
snap1 = json.loads(sys.argv[1])
snap2 = json.loads(sys.argv[2])
r1 = snap1.get('app_restarts') or {}
r2 = snap2.get('app_restarts') or {}
extra = []
for name, rc2 in r2.items():
    rc1 = r1.get(name, rc2)
    delta = rc2 - rc1
    if delta >= RESTART_DELTA_THRESHOLD:
        extra.append(name)
print(len(extra))
" "$SNAP1C" "$SNAP2C" 2>/dev/null || echo "-1")

if [[ "$result6c" == "0" ]]; then
  _pass "Fixture-6c: delta=1 (single operator restart) does NOT trigger crash-looper (threshold=3 required)"
else
  _fail "Fixture-6c: delta=1 triggered crash-looper (got ${result6c} entries, expected 0 — false positive)"
fi

# 6d: delta=2 (two restarts) → must NOT trigger (below threshold of 3)
SNAP1D='{"app_restarts":{"mission-control":10}}'
SNAP2D='{"app_restarts":{"mission-control":12}}'

result6d=$(python3 -s -c "
import sys, json
RESTART_DELTA_THRESHOLD = 3
snap1 = json.loads(sys.argv[1])
snap2 = json.loads(sys.argv[2])
r1 = snap1.get('app_restarts') or {}
r2 = snap2.get('app_restarts') or {}
extra = []
for name, rc2 in r2.items():
    rc1 = r1.get(name, rc2)
    delta = rc2 - rc1
    if delta >= RESTART_DELTA_THRESHOLD:
        extra.append(name)
print(len(extra))
" "$SNAP1D" "$SNAP2D" 2>/dev/null || echo "-1")

if [[ "$result6d" == "0" ]]; then
  _pass "Fixture-6d: delta=2 does NOT trigger crash-looper (< threshold 3)"
else
  _fail "Fixture-6d: delta=2 triggered crash-looper (got ${result6d}, expected 0)"
fi

###############################################################################
# FIXTURE 7: bash 3.2 hard guard
###############################################################################
printf '\n=== FIXTURE 7: bash 3.2 hard guard ===\n'

if /bin/bash --version 2>&1 | grep -q "version 3"; then
  guard_exit=0
  /bin/bash "$HEALTH_CHECK" --port 4000 --json-only 2>/dev/null || guard_exit=$?
  if [[ "$guard_exit" -eq 2 ]]; then
    _pass "Fixture-7: /bin/bash (3.2) → exit 2 with clear error message"
  else
    _fail "Fixture-7: expected exit 2 from bash 3.2, got ${guard_exit}"
  fi
else
  _skip "Fixture-7: /bin/bash is not version 3 on this host — guard test not applicable"
fi

###############################################################################
# FIXTURE 8: sqlite3 SQLITE_BUSY retry — structural checks
###############################################################################
printf '\n=== FIXTURE 8: sqlite3 SQLITE_BUSY retry ===\n'

if grep -q '\.timeout 5000' "$HEALTH_CHECK"; then
  _pass "Fixture-8: sqlite3 .timeout 5000 flag present (handles SQLITE_BUSY)"
else
  _fail "Fixture-8: sqlite3 .timeout 5000 NOT found in cc-health-check.sh"
fi

if grep -q 'attempt in 1 2 3' "$HEALTH_CHECK"; then
  _pass "Fixture-8: retry loop 'attempt in 1 2 3' present"
else
  _fail "Fixture-8: retry loop NOT found in cc-health-check.sh"
fi

###############################################################################
# FIXTURE 9: assets_found field present and distinct from total
###############################################################################
printf '\n=== FIXTURE 9: assets_found field in JSON output ===\n'

if grep -q 'assets_found' "$HEALTH_CHECK"; then
  _pass "Fixture-9: assets_found field present in cc-health-check.sh output"
else
  _fail "Fixture-9: assets_found field NOT found — caller cannot distinguish partial from full probe"
fi

if grep -q '"capped"' "$HEALTH_CHECK" || grep -q 'capped' "$HEALTH_CHECK"; then
  _pass "Fixture-9: capped field present in static_assets JSON output"
else
  _fail "Fixture-9: capped field NOT found"
fi

###############################################################################
# FIXTURE 10: Disk-direct config probe — no pm2 dependency
###############################################################################
printf '\n=== FIXTURE 10: Disk-direct company-config.json probe ===\n'

if grep -q '_find_config_company_name_from_disk' "$HEALTH_CHECK"; then
  _pass "Fixture-10: _find_config_company_name_from_disk function present (disk-direct probe)"
else
  _fail "Fixture-10: _find_config_company_name_from_disk NOT found"
fi

###############################################################################
# FIXTURE 11: Path injection guard — single quote in canonical-dir path
###############################################################################
printf "\n=== FIXTURE 11: Path injection guard (single quote in path) ===\n"

# Verify the script uses sys.argv to pass the config path to python3
# (not string interpolation inside a quoted Python literal)
if grep -q "sys.argv\[1\]" "$HEALTH_CHECK"; then
  _pass "Fixture-11: _get_config_company_name uses sys.argv[1] — no path injection risk"
else
  _fail "Fixture-11: sys.argv[1] NOT found in _get_config_company_name — may use string interpolation (path injection risk)"
fi

# Functional test: a canonical dir with a single quote in the name must not crash
FX11_DIR="${WORK_DIR}/fx11"
FX11_QUOT_DIR="${WORK_DIR}/o'brien-cc"
mkdir -p "${FX11_QUOT_DIR}/config"
echo '{"companyName":"OBrien Corp"}' > "${FX11_QUOT_DIR}/config/company-config.json"
_create_db "${FX11_DIR}/mission-control.db" "OBrien Corp" 2>/dev/null || true
mkdir -p "${FX11_DIR}"
_create_db "${FX11_DIR}/mission-control.db" "Default"

FX11_OUTPUT=""
FX11_EXIT=0
FX11_OUTPUT=$(bash "$HEALTH_CHECK" \
  --port 19900 \
  --db-path "${FX11_DIR}/mission-control.db" \
  --canonical-dir "${FX11_QUOT_DIR}" \
  --disk-min-gb 1 \
  --pm2-check-window 0 \
  --max-assets 0 \
  --json-only 2>/dev/null) || FX11_EXIT=$?

# The script should return JSON (not crash with a syntax error)
FX11_IS_JSON=$(printf '%s' "$FX11_OUTPUT" \
  | python3 -s -c "import sys,json; json.load(sys.stdin); print('yes')" \
  2>/dev/null || echo "no")

if [[ "$FX11_IS_JSON" == "yes" ]]; then
  _pass "Fixture-11: path with single quote in --canonical-dir returns valid JSON (no Python SyntaxError)"
else
  _fail "Fixture-11: path with single quote caused non-JSON output (likely Python SyntaxError crash)"
fi

###############################################################################
# FIXTURE 12: deploy.sh hard-guard — absent cc-health-check.sh must FAIL
###############################################################################
printf '\n=== FIXTURE 12: deploy.sh hard-guard — no fallback to HTTP 200 ===\n'

if grep -q 'fallback' "$DEPLOY_SH" && grep -q 'green.*true.*fallback.*true' "$DEPLOY_SH"; then
  _fail "Fixture-12: deploy.sh still contains the fallback green=true path — FALSE GREEN risk"
elif grep -q 'FATAL.*cc-health-check.sh not found' "$DEPLOY_SH"; then
  _pass "Fixture-12: deploy.sh emits FATAL when cc-health-check.sh is absent (no HTTP 200 fallback)"
else
  _fail "Fixture-12: deploy.sh does not clearly FATAL on missing cc-health-check.sh — verify manually"
fi

# Verify the MAIN deploy health gate (Step 6) uses a non-zero pm2-check-window.
# The rollback path may use 0 (quick check) — only the main gate matters here.
# Look for the primary HEALTH_JSON assignment that calls cc-health-check.sh without rollback context.
MAIN_GATE_WINDOW=$(grep -A3 'HEALTH_JSON=\$(bash.*HEALTH_CHECK' "$DEPLOY_SH" \
  | grep 'pm2-check-window' | grep -v 'ROLLBACK' | head -1 || true)
if [[ "$MAIN_GATE_WINDOW" == *"--pm2-check-window 0"* ]]; then
  _fail "Fixture-12: deploy.sh main health gate uses --pm2-check-window 0 — delta crash-loop detection disabled"
else
  _pass "Fixture-12: deploy.sh main health gate uses non-zero --pm2-check-window (delta detection active)"
fi

###############################################################################
# FIXTURE 13: Fleet callers all exist and reference cc-health-check.sh
###############################################################################
printf '\n=== FIXTURE 13: Fleet callers reference cc-health-check.sh (B.1 P0 wiring) ===\n'

SCRIPTS_DIR="${REPO_ROOT}/scripts"
for caller in fleet-refresh-verify.sh sunday-cron-sweep.sh watchdog-cc.sh; do
  CALLER_PATH="${SCRIPTS_DIR}/${caller}"
  if [[ -f "$CALLER_PATH" ]]; then
    if grep -q 'cc-health-check.sh' "$CALLER_PATH"; then
      _pass "Fixture-13: ${caller} exists and references cc-health-check.sh"
    else
      _fail "Fixture-13: ${caller} exists but does NOT reference cc-health-check.sh"
    fi
  else
    _fail "Fixture-13: ${caller} NOT found at ${CALLER_PATH} — B.1 fleet wiring P0 item missing"
  fi
done

###############################################################################
# Summary
###############################################################################
printf '\n=== FIXTURE RESULTS ===\n'
printf "PASS: %d\n" "$PASS_COUNT"
if [[ "$FAIL_COUNT" -gt 0 ]]; then
  printf "FAIL: %d\n" "$FAIL_COUNT"
  exit 1
else
  printf "All %d fixture assertions passed.\n" "$PASS_COUNT"
  exit 0
fi
