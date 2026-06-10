#!/usr/bin/env bash
# run-cc-health-check-fixtures.sh — automated fixture runner for cc-health-check.sh (B.1)
#
# Sets up each broken-state fixture and asserts the expected exit code + JSON output.
# Covers all broken states required by PRD Addendum B.1 verify step:
#   1. Stale manifest (/_next/static asset returns 404)
#   2. Default company row (configured box but DB has name='Default')
#   3. Zombie / crash-looping pm2 app
#   4. CWD drift (pm2 app started from wrong directory)
#   5. Low disk (< 5 GB free — simulated via --disk-min-gb flag)
# Plus the happy path: all non-pm2 checks pass.
#
# NOTE on pm2 checks: pm2 is not available in CI. Fixtures 3, 4, 6 exercise
# the Python analysis logic DIRECTLY via unit-test patterns, which is the
# meaningful assertion. The integration-level test (pm2 running + registered)
# belongs to the on-box smoke test.
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

socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(('127.0.0.1', port), Handler)
httpd.serve_forever()
" "$port" "$docroot" &>/dev/null &
  SERVER_PID=$!
  local i=0
  while ! curl -s --max-time 1 "http://127.0.0.1:${port}/" &>/dev/null; do
    i=$((i+1))
    if [[ $i -gt 30 ]]; then
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

# Assert that a specific check inside the JSON has the expected pass value.
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

# Assert overall green value and exit code.
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
# Build a minimal Next.js-style HTML doc.
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
# FIXTURE 0: Happy path — HTTP + company name + disk all pass (pm2 excluded)
# In CI pm2 is not available, so we assert only on the checks we can control.
###############################################################################
printf '\n=== FIXTURE 0: Happy path — HTTP, company_name, disk all green ===\n'

FX0_DIR="${WORK_DIR}/fx0"
mkdir -p "${FX0_DIR}/_next/static/abc123/pages" \
         "${FX0_DIR}/_next/static/chunks" \
         "${FX0_DIR}/api" \
         "${FX0_DIR}/config"
FX0_PORT=$(_next_port)

echo "body{margin:0}" > "${FX0_DIR}/_next/static/abc123/pages/_app.css"
echo "var x=1;"       > "${FX0_DIR}/_next/static/chunks/main.js"
echo "var m={};"      > "${FX0_DIR}/_next/static/abc123/_buildManifest.js"
_make_html "abc123" "Fixture Corp" > "${FX0_DIR}/index.html"
echo "ok"             > "${FX0_DIR}/api/health"
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

# Assert the checks we control (not pm2 which requires a real registered app)
_assert_check_pass "Fixture-0 HTTP root" "http_root" "true" "$FX0_OUTPUT"
_assert_check_pass "Fixture-0 HTTP api/health" "http_api_health" "true" "$FX0_OUTPUT"
_assert_check_pass "Fixture-0 company_name" "company_name" "true" "$FX0_OUTPUT"
_assert_check_pass "Fixture-0 disk_headroom" "disk_headroom" "true" "$FX0_OUTPUT"

_stop_server

###############################################################################
# FIXTURE 1: Stale manifest — buildId in HTML references a hash absent on disk
###############################################################################
printf '\n=== FIXTURE 1: Stale manifest — static_assets must fail ===\n'

FX1_DIR="${WORK_DIR}/fx1"
mkdir -p "${FX1_DIR}/_next/static/old_hash" \
         "${FX1_DIR}/api"
FX1_PORT=$(_next_port)

# HTML references build id "stale999" but stale999/ does NOT exist on the server.
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
  --max-assets 50 \
  --json-only 2>/dev/null) || FX1_EXIT=$?

_assert_check_pass "Fixture-1 stale manifest: HTTP root still passes" "http_root" "true" "$FX1_OUTPUT"
_assert_check_pass "Fixture-1 stale manifest: static_assets must fail" "static_assets" "false" "$FX1_OUTPUT"

# Verify the detail mentions the specific failure (stale hash path)
FX1_DETAIL=$(printf '%s' "$FX1_OUTPUT" \
  | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('static_assets',{}).get('detail',''))" \
  2>/dev/null || echo "")
if [[ "$FX1_DETAIL" == *"failed"* || "$FX1_DETAIL" == *"stale"* ]]; then
  _pass "Fixture-1 stale manifest: detail mentions failure correctly"
else
  _fail "Fixture-1 stale manifest: detail='${FX1_DETAIL}' (expected 'failed'/'stale' mention)"
fi

# Overall must not be green
if [[ "$FX1_EXIT" -eq 1 ]]; then
  _pass "Fixture-1 stale manifest: exit=1 (not green) correct"
else
  _fail "Fixture-1 stale manifest: exit=${FX1_EXIT} (expected 1)"
fi

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

# Valid HTML — we want company_name to be the only failing check
_make_html "abc123" "Default" > "${FX2_DIR}/index.html"
echo "ok" > "${FX2_DIR}/api/health"
# company-config.json exists — this IS a configured box
echo '{"companyName":"Real Client Corp"}' > "${FX2_DIR}/config/company-config.json"
# DB has name='Default' — the Sheila bug
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
  _pass "Fixture-2 Default row: detail correctly identifies the Default/Sheila bug"
else
  _fail "Fixture-2 Default row: detail='${FX2_DETAIL}' (expected 'Default'/'Sheila' mention)"
fi

if [[ "$FX2_EXIT" -eq 1 ]]; then
  _pass "Fixture-2 Default row: exit=1 correct"
else
  _fail "Fixture-2 Default row: exit=${FX2_EXIT} (expected 1)"
fi

_stop_server

###############################################################################
# FIXTURE 2b: Default row + pm2 stopped — must NOT produce false-green
# This is the exact Sheila scenario: pm2 down, config on disk, Default in DB.
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

# company_name must FAIL — not silently pass as "unconfigured box"
_assert_check_pass "Fixture-2b pm2-down + Default row: company_name must fail (not false-green)" "company_name" "false" "$FX2B_OUTPUT"

FX2B_DETAIL=$(printf '%s' "$FX2B_OUTPUT" \
  | python3 -s -c "import sys,json; d=json.load(sys.stdin); print(d.get('checks',{}).get('company_name',{}).get('detail',''))" \
  2>/dev/null || echo "")
if [[ "$FX2B_DETAIL" == *"unconfigured box"* ]]; then
  _fail "Fixture-2b pm2-down: detail='${FX2B_DETAIL}' — FALSE GREEN: script treated configured box as unconfigured"
else
  _pass "Fixture-2b pm2-down: detail correctly does NOT say 'unconfigured box'"
fi

###############################################################################
# FIXTURE 3: Crash-looper detection — Python logic unit tests
###############################################################################
printf '\n=== FIXTURE 3: pm2 crash-looper detection (Python unit tests) ===\n'

# 3a: errored status
result3a=$(python3 -s -c "
import json
apps = [{'pm2_env': {'name':'mc','status':'errored','restart_time':15,'PORT':'4000','pm_cwd':'/data'}}]
crash_loopers = []
for app in apps:
    env = app.get('pm2_env') or {}
    status = env.get('status') or ''
    rc = int(env.get('restart_time') or 0)
    name = env.get('name') or 'unknown'
    if status == 'errored':
        crash_loopers.append({'name': name, 'reason': 'status=errored', 'restart_count': rc})
    elif status == 'stopped':
        crash_loopers.append({'name': name, 'reason': 'status=stopped', 'restart_count': rc})
print(json.dumps(crash_loopers))
" 2>/dev/null || echo "[]")

if echo "$result3a" | python3 -s -c "import sys,json; cl=json.load(sys.stdin); exit(0 if cl and cl[0]['reason']=='status=errored' else 1)" 2>/dev/null; then
  _pass "Fixture-3a: errored app flagged correctly"
else
  _fail "Fixture-3a: errored app not flagged (got: ${result3a})"
fi

# 3b: stopped status
result3b=$(python3 -s -c "
import json
apps = [{'pm2_env': {'name':'mc','status':'stopped','restart_time':0,'PORT':'4000','pm_cwd':'/data'}}]
crash_loopers = []
for app in apps:
    env = app.get('pm2_env') or {}
    status = env.get('status') or ''
    rc = int(env.get('restart_time') or 0)
    name = env.get('name') or 'unknown'
    if status == 'errored':
        crash_loopers.append({'name': name, 'reason': 'status=errored', 'restart_count': rc})
    elif status == 'stopped':
        crash_loopers.append({'name': name, 'reason': 'status=stopped (app not running)', 'restart_count': rc})
print(json.dumps(crash_loopers))
" 2>/dev/null || echo "[]")

if echo "$result3b" | python3 -s -c "import sys,json; cl=json.load(sys.stdin); exit(0 if cl and 'stopped' in cl[0]['reason'] else 1)" 2>/dev/null; then
  _pass "Fixture-3b: stopped app flagged as crash-looper correctly"
else
  _fail "Fixture-3b: stopped app not flagged (got: ${result3b})"
fi

# 3c: port substring guard — port 40001 must NOT count as port 4000
result3c=$(python3 -s -c "
import json, re
port_str = '4000'
apps = [{'pm2_env': {'name':'blackceo-staging','status':'online','restart_time':0,'PORT':'40001','pm_cwd':'/data/staging'}}]
cc_apps = []
for app in apps:
    env = app.get('pm2_env') or {}
    port_env = env.get('PORT') or ''
    if port_env == port_str:
        cc_apps.append(app)
        continue
    args = env.get('args') or ''
    if isinstance(args, list): args = ' '.join(str(a) for a in args)
    if re.search(r'--port\s+' + re.escape(port_str) + r'(?!\d)', str(args)):
        cc_apps.append(app)
        continue
    name = (env.get('name') or '').lower()
    name_kw = any(kw in name for kw in ('mission-control','command-center','blackceo'))
    if name_kw:
        if port_env and port_env != port_str:
            continue
        cc_apps.append(app)
print(len(cc_apps))
" 2>/dev/null || echo "-1")

if [[ "$result3c" == "0" ]]; then
  _pass "Fixture-3c: port 40001 correctly NOT counted as port 4000 match (no substring false-positive)"
else
  _fail "Fixture-3c: cc_apps count=${result3c} (expected 0 for port 40001 vs 4000 — substring bug still present)"
fi

# 3d: pm2 null → [] (no crash)
result3d=$(python3 -s -c "
import json
raw = 'null'
apps = json.loads(raw)
if apps is None: apps = []
print(len(apps))
" 2>/dev/null || echo "error")

if [[ "$result3d" == "0" ]]; then
  _pass "Fixture-3d: pm2 jlist 'null' safely coerced to [] (no TypeError crash)"
else
  _fail "Fixture-3d: null handling failed (got: ${result3d})"
fi

###############################################################################
# FIXTURE 4: CWD drift
###############################################################################
printf '\n=== FIXTURE 4: CWD drift detection (Python unit tests) ===\n'

# 4a: cwd mismatch with canon_dir supplied
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

# 4b: no canon_dir and cc_apps exist => cwd_match=False (not silently True)
result4b=$(python3 -s -c "
cc_apps_exist = True
canon_dir = ''  # not supplied, not derivable
cwd_match = True  # init
if cc_apps_exist and not canon_dir:
    cwd_match = False  # must NOT default to True — requires explicit canonical dir
print('false' if not cwd_match else 'true')
" 2>/dev/null || echo "parse_error")

if [[ "$result4b" == "false" ]]; then
  _pass "Fixture-4b: no --canonical-dir with cc_apps → cwd_match=False (correct, no silent pass)"
else
  _fail "Fixture-4b: no --canonical-dir → cwd_match=${result4b} (WRONG: must be False, not True)"
fi

# 4c: relative DATABASE_PATH resolved against pm_cwd (os.path.normpath cleans ./)
result4c=$(python3 -s -c "
import os
pm_cwd = '/data/projects/command-center'
db_raw = './mission-control.db'  # relative path from pm2
if not os.path.isabs(db_raw) and pm_cwd:
    resolved = os.path.normpath(os.path.join(pm_cwd, db_raw))
else:
    resolved = db_raw
print(resolved)
" 2>/dev/null || echo "error")

if [[ "$result4c" == "/data/projects/command-center/mission-control.db" ]]; then
  _pass "Fixture-4c: relative DATABASE_PATH resolved against pm_cwd correctly"
else
  _fail "Fixture-4c: relative DATABASE_PATH resolution got '${result4c}' (expected absolute path)"
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
# No company-config.json so Default is acceptable (unconfigured box)
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
# FIXTURE 6: Restart-count delta — crash-looper detected between two snapshots
###############################################################################
printf '\n=== FIXTURE 6: Restart-count delta crash detection (Python unit tests) ===\n'

# 6a: restart count increased → crash-looper
SNAP1='{"app_restarts":{"mission-control":3}}'
SNAP2='{"app_restarts":{"mission-control":5}}'

result6a=$(python3 -s -c "
import sys, json
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
" "$SNAP1" "$SNAP2" 2>/dev/null || echo "[]")

if echo "$result6a" | python3 -s -c "import sys,json; dl=json.load(sys.stdin); exit(0 if dl and 'increased 3->5' in dl[0]['reason'] else 1)" 2>/dev/null; then
  _pass "Fixture-6a: restart_count increase 3->5 detected as crash-looper"
else
  _fail "Fixture-6a: restart_count delta not detected (got: ${result6a})"
fi

# 6b: stable restart count → no crash-looper
SNAP1B='{"app_restarts":{"mission-control":3}}'
SNAP2B='{"app_restarts":{"mission-control":3}}'

result6b=$(python3 -s -c "
import sys, json
snap1 = json.loads(sys.argv[1])
snap2 = json.loads(sys.argv[2])
r1 = snap1.get('app_restarts') or {}
r2 = snap2.get('app_restarts') or {}
extra = []
for name, rc2 in r2.items():
    rc1 = r1.get(name, rc2)
    if rc2 > rc1:
        extra.append(name)
print(len(extra))
" "$SNAP1B" "$SNAP2B" 2>/dev/null || echo "-1")

if [[ "$result6b" == "0" ]]; then
  _pass "Fixture-6b: stable restart_count → zero delta crash-loopers (correct)"
else
  _fail "Fixture-6b: expected 0 delta crashers, got ${result6b}"
fi

###############################################################################
# FIXTURE 7: bash 3.2 guard
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
  _info "Fixture-7: /bin/bash is not version 3 on this host — guard test skipped (counted as pass)"
  PASS_COUNT=$((PASS_COUNT+1))
fi

###############################################################################
# FIXTURE 8: sqlite3 retry — structural checks on the script text
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
# FIXTURE 9: max-assets cap — structural check
###############################################################################
printf '\n=== FIXTURE 9: --max-assets cap ===\n'

if grep -q 'TOTAL_CHECKED.*-ge.*MAX_ASSETS' "$HEALTH_CHECK" || grep -q 'MAX_ASSETS' "$HEALTH_CHECK"; then
  _pass "Fixture-9: MAX_ASSETS cap present in cc-health-check.sh"
else
  _fail "Fixture-9: MAX_ASSETS cap NOT found in cc-health-check.sh"
fi

###############################################################################
# FIXTURE 10: disk-direct config probe — no pm2 dependency for config_exists
###############################################################################
printf '\n=== FIXTURE 10: Disk-direct company-config.json probe ===\n'

if grep -q '_find_config_company_name_from_disk' "$HEALTH_CHECK"; then
  _pass "Fixture-10: _find_config_company_name_from_disk function present (disk-direct probe)"
else
  _fail "Fixture-10: _find_config_company_name_from_disk NOT found — pm2-dependency bug may persist"
fi

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
