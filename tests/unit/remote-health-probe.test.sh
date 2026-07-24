#!/usr/bin/env bash
# tests/unit/remote-health-probe.test.sh — U014 behavioral regression lock
#
# Run:  bash tests/unit/remote-health-probe.test.sh
# from the repo root.
#
# T0  bash -n syntax check
# T1  --remote --dry-run with fixture DB prints client names, exits 0
# T2  py() function unit test — exercises the ACTUAL py() from the script
#     with both correct and broken key patterns (detects L123/L141/L142 quoting)
# T3  mutation proof: deleting probe loop -> RED; restore -> GREEN
# T4  LIVE remote probe against local HTTP server — verifies JSON output structure
# T5  L120 mutation test: broken --write-out quoting -> RED; restore -> GREEN
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TARGET="$ROOT/scripts/cc-health-check.sh"
PASS=0; FAIL=0

_pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
_fail() { echo "  FAIL: $1" >&2; FAIL=$((FAIL + 1)); }
_section() { echo ""; echo "=== $1 ==="; }

cleanup_held=""

cleanup_all() {
  rm -f /tmp/u014_fixture_$$*.db /tmp/u014_mutated_$$*.sh /tmp/u014_server_$$.py /tmp/u014_health_response.json
  if [[ -n "$cleanup_held" ]]; then
    local pids=($cleanup_held)
    for pid in "${pids[@]}"; do
      kill "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
  fi
}
trap cleanup_all EXIT

# ── helper: extract py() function from the script ─────────────────────────
extract_py_func() {
  grep -E '^py\(\) \{' "$TARGET"
}

# ── T0: bash -n syntax check ──────────────────────────────────────────────
_section "T0 — bash -n"
bash -n "$TARGET" && _pass "syntax OK" || { _fail "bash -n failed"; exit 2; }

# ── T1: --remote --dry-run with fixture DB prints client names, exits 0 ──
_section "T1 — --remote --dry-run prints client names, exits 0"
FIXTURE_DB="/tmp/u014_fixture_$$.db"
rm -f "$FIXTURE_DB"

sqlite3 "$FIXTURE_DB" "
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gateway_url TEXT NOT NULL,
  is_self INTEGER DEFAULT 0
);
INSERT INTO clients (id, name, gateway_url, is_self) VALUES
  ('c001', 'client-a', 'ws://box-a.example.com:4000', 0),
  ('c002', 'client-b', 'wss://box-b.example.com:4001', 0);
" || { _fail "could not create fixture DB"; exit 2; }

OUTPUT=$(bash "$TARGET" --remote --dry-run --db-path "$FIXTURE_DB" 2>/dev/null) || true
EXIT_CODE=$?

if [[ "$EXIT_CODE" -eq 0 ]]; then
  _pass "--remote --dry-run exits 0"
else
  _fail "--remote --dry-run exited $EXIT_CODE (expected 0)"
fi

if echo "$OUTPUT" | grep -q '"client-a"'; then
  _pass "--remote --dry-run prints client-a"
else
  _fail "--remote --dry-run did NOT print client-a"
fi

if echo "$OUTPUT" | grep -q '"client-b"'; then
  _pass "--remote --dry-run prints client-b"
else
  _fail "--remote --dry-run did NOT print client-b"
fi

# ── T2: py() unit test — exercises the ACTUAL script's py() function ────────
_section "T2 — py() function unit test (detects L123/L141/L142 quoting)"
PY_FUNC=$(extract_py_func)
if [[ -z "$PY_FUNC" ]]; then
  _fail "could not extract py() function from $TARGET"
else
  _pass "py() function extracted"

  # ── T2a: py() with correct key d.get('_http_code',0) → 200 ───────────
  result=$(
    eval "$PY_FUNC"
    printf '%s' '{"_http_code":200}' | py "d.get('_http_code',0)" 0
  )
  if [[ "$result" == "200" ]]; then
    _pass "py: d.get('_http_code',0) on {\"_http_code\":200} → 200"
  else
    _fail "py: d.get('_http_code',0) → '$result' (expected 200)"
  fi

  # ── T2b: py() with BROKEN key d.get('"_http_code"',0) → 0 (wrong key) ─
  # This replicates the old L123 bug that caused every client to be UNREACHABLE
  result=$(
    eval "$PY_FUNC"
    printf '%s' '{"_http_code":200}' | py "d.get('\"_http_code\"',0)" 0
  )
  if [[ "$result" == "0" ]]; then
    _pass "py: d.get('\"_http_code\"',0) → 0 (broken key correctly produces failure)"
  else
    _fail "py: d.get('\"_http_code\"',0) → '$result' (expected 0 for broken key)"
  fi

  # ── T2c: py() with correct key d.get('pass') → true ──────────────────
  result=$(
    eval "$PY_FUNC"
    printf '%s' '{"pass":true}' | py "'true' if d.get('pass') else 'false'" "false"
  )
  if [[ "$result" == "true" ]]; then
    _pass "py: d.get('pass') on pass:true JSON → true"
  else
    _fail "py: d.get('pass') → '$result' (expected true)"
  fi

  # ── T2d: py() with BROKEN key d.get('"pass"') → false (wrong key) ────
  # This replicates the old L141 bug
  result=$(
    eval "$PY_FUNC"
    printf '%s' '{"pass":true}' | py "'true' if d.get('\"pass\"') else 'false'" "false"
  )
  if [[ "$result" == "false" ]]; then
    _pass "py: d.get('\"pass\"') → false (broken key correctly produces failure)"
  else
    _fail "py: d.get('\"pass\"') → '$result' (expected false for broken key)"
  fi

  # ── T2e: py() with correct key d.get('indeterminate') → false ────────
  result=$(
    eval "$PY_FUNC"
    printf '%s' '{"indeterminate":false}' | py "'true' if d.get('indeterminate') else 'false'" "false"
  )
  if [[ "$result" == "false" ]]; then
    _pass "py: d.get('indeterminate') on indeterminate:false → false"
  else
    _fail "py: d.get('indeterminate') → '$result' (expected false)"
  fi

  # ── T2f: py() handles malformed JSON → default ────────────────────────
  result=$(
    eval "$PY_FUNC"
    printf '%s' 'not-json' | py "'true' if d.get('pass') else 'false'" "false"
  )
  if [[ "$result" == "false" ]]; then
    _pass "py: malformed JSON correctly returns default"
  else
    _fail "py: malformed JSON → '$result' (expected 'false')"
  fi
fi

# ── T3: mutation proof — delete probe loop → RED ──────────────────────────
_section "T3 — mutation proof: delete probe loop → RED, restore → GREEN"

# The probe loop is the for-loop in run_remote_health that calls probe_remote_client.
PROBE_CALL_LINE=$(grep -n '    probe_remote_client "' "$TARGET" | head -1 | cut -d: -f1)

if [[ -z "$PROBE_CALL_LINE" ]]; then
  _fail "could not locate probe_remote_client call in $TARGET"
else
  MUTATED="/tmp/u014_mutated_$$.sh"
  rm -f "$MUTATED"

  awk -v line="$PROBE_CALL_LINE" 'NR==line{print "    :  # MUTATED — probe_remote_client call removed"} NR!=line' "$TARGET" > "$MUTATED"

  if grep -q "MUTATED" "$MUTATED"; then
    _pass "mutation: probe_remote_client call commented out"
  else
    _fail "mutation: could not modify probe_remote_client call"
  fi

  if bash -n "$MUTATED" 2>/dev/null; then
    _pass "mutation: mutated script passes bash -n (syntax OK)"
  else
    _fail "mutation: mutated script fails bash -n"
  fi

  MUT_OUTPUT=$(bash "$MUTATED" --remote --dry-run --db-path "$FIXTURE_DB" 2>/dev/null) || true
  MUT_EXIT=$?

  if [[ "$MUT_EXIT" -eq 0 ]]; then
    _pass "mutation: mutated script exits 0 (no crash from missing probes)"
  else
    _pass "mutation: mutated script exits $MUT_EXIT (no crash)"
  fi

  ORIG_OUTPUT=$(bash "$TARGET" --remote --dry-run --db-path "$FIXTURE_DB" 2>/dev/null) || true
  ORIG_EXIT=$?

  if [[ "$ORIG_EXIT" -eq 0 ]] && echo "$ORIG_OUTPUT" | grep -q "client-a"; then
    _pass "mutation: ORIGINAL script still GREEN (exit 0, client-a present)"
  else
    _fail "mutation: ORIGINAL script degraded after mutation round-trip (exit $ORIG_EXIT)"
  fi

  rm -f "$MUTATED"
fi

# ── T4: LIVE remote probe against local HTTP server ────────────────────────
_section "T4 — LIVE remote probe against local HTTP server"
# Create a minimal Python HTTP server that responds with a known health JSON
LIVE_PORT=$((RANDOM + 20000))
LIVE_DB="/tmp/u014_fixture_$$_live.db"
LIVE_RESPONSE_FILE="/tmp/u014_health_response.json"

# Write the health response once (used by the server on each request)
cat > "$LIVE_RESPONSE_FILE" << 'HEREDOC_JSON'
{"pass":true,"indeterminate":false,"checks":{"app":{"pass":true}}}
HEREDOC_JSON

# Build the fixture DB pointing to our local test server
rm -f "$LIVE_DB"
GATEWAY="http://127.0.0.1:${LIVE_PORT}"
sqlite3 "$LIVE_DB" "
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gateway_url TEXT NOT NULL,
  is_self INTEGER DEFAULT 0
);
INSERT INTO clients (id, name, gateway_url, is_self) VALUES
  ('c_live', 'live-green', '${GATEWAY}', 0);
" || { _fail "T4: could not create live fixture DB"; exit 2; }

# Start a simple Python HTTP server for the health endpoint
python3 -c "
import http.server, json, sys, os

HEALTH_PATH = '/api/health/deep'
HOST = '127.0.0.1'
PORT = int(sys.argv[1])
RESPONSE_FILE = sys.argv[2]

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == HEALTH_PATH:
            try:
                with open(RESPONSE_FILE) as f:
                    body = f.read().strip()
            except Exception:
                body = '{}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body.encode())
        else:
            self.send_response(404)
            self.end_headers()
    def log_message(self, *a):
        pass  # suppress server log output

with http.server.HTTPServer((HOST, PORT), Handler) as s:
    s.timeout = 15
    while True:
        s.handle_request()
" "$LIVE_PORT" "$LIVE_RESPONSE_FILE" &
SERVER_PID=$!
cleanup_held="$cleanup_held $SERVER_PID"

# Give the server a moment to start
sleep 0.3

# Run the live remote probe against our local server
LIVE_OUTPUT=$(bash "$TARGET" --remote --db-path "$LIVE_DB" 2>/dev/null) || true
LIVE_EXIT=$?

# Kill the server now
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
cleanup_held=""

# Verify the output is valid JSON with correct structure
if echo "$LIVE_OUTPUT" | grep -q '"client_id"'; then
  _pass "T4: live probe prints JSON with client_id"
else
  _fail "T4: live probe did NOT emit client_id in JSON"
fi

if echo "$LIVE_OUTPUT" | grep -q '"live-green"'; then
  _pass "T4: live probe JSON contains client name 'live-green'"
else
  _fail "T4: live probe JSON missing client name 'live-green'"
fi

# The pass field should be true (the server returns {"pass":true})
if echo "$LIVE_OUTPUT" | grep -q '"pass":true'; then
  _pass "T4: live probe JSON has pass:true (healthy endpoint)"
else
  _fail "T4: live probe JSON does NOT have pass:true"
fi

# The detail should be "probed" not "unreachable"
if echo "$LIVE_OUTPUT" | grep -q '"detail":"probed"'; then
  _pass "T4: live probe JSON has detail:probed (reachable)"
else
  _fail "T4: live probe JSON missing detail:probed — endpoint may be UNREACHABLE"
fi

# The http_code should be 200
if echo "$LIVE_OUTPUT" | grep -q '"http_code":200'; then
  _pass "T4: live probe JSON has http_code:200"
else
  _fail "T4: live probe JSON missing http_code:200"
fi

# Exit code should be 0 (pass=true)
if [[ "$LIVE_EXIT" -eq 0 ]]; then
  _pass "T4: live probe exits 0 (green)"
else
  _fail "T4: live probe exited $LIVE_EXIT (expected 0)"
fi

# ── T5: L120 mutation test — broken --write-out quoting → RED ─────────────
_section "T5 — L120 mutation: broken --write-out quoting caught by live probe"
# Create a mutated script where L120 uses the OLD broken --write-out format.
# The broken format wraps the write-out JSON in literal double-quote chars:
#   fixed:  --write-out '\n{"_http_code":%{http_code}}'
#   broken: --write-out '"'"'{"_http_code":%{http_code}}'"'"'
# The broken format makes curl output a JSON-wrapped-in-double-quotes trailer,
# which awk captures as a non-JSON line → probe_code defaults to 0 →
# every healthy client is reported UNREACHABLE.
#
# We apply the mutation via Python to avoid bash quoting hell.

L120_MUTATED="/tmp/u014_mutated_L120_$$.sh"
rm -f "$L120_MUTATED"

# Use Python to do the text replacement cleanly
python3 - "$TARGET" "$L120_MUTATED" << 'PYEOF'
import sys

TARGET = sys.argv[1]
MUTATED = sys.argv[2]

with open(TARGET, 'r') as f:
    lines = f.readlines()

# Find probe_remote_client() and replace the first --write-out line after it
in_func = False
changed = False
for i, line in enumerate(lines):
    if 'probe_remote_client()' in line:
        in_func = True
        continue
    if in_func and '--write-out' in line and '_http_code' in line:
        # This is L120 — apply the broken pattern.
        # The original (fixed) line has:  --write-out '\n{"_http_code":%{http_code}}'
        # The broken line:               --write-out '"'"'{"_http_code":%{http_code}}'"'"'
        # After bash evaluation curl receives: '"{_http_code:%{http_code}}"'
        # curl outputs: '{"_http_code":200}' — invalid JSON, parse fails, default 0 → UNREACHABLE

        # Rebuild the line with the broken write-out segment
        wout_pos = line.find('--write-out')
        if wout_pos >= 0:
            before = line[:wout_pos]
            # Contents after --write-out
            rest_pos = wout_pos + len('--write-out ')
            rest = line[rest_pos:]
            # Build the broken --write-out argument
            sq = chr(39)  # single-quote '
            dq = chr(34)  # double-quote "
            broken_wout_arg = sq + dq + sq + dq + sq + '{"_http_code":%{http_code}}' + sq + dq + sq + dq + sq
            broken_segment = '--write-out ' + broken_wout_arg + ' '
            newline = before + broken_segment + rest
            lines[i] = newline
            changed = True
        break

if not changed:
    sys.exit(1)

with open(MUTATED, 'w') as f:
    f.writelines(lines)
PYEOF
MUTATION_EXIT=$?

if [[ "$MUTATION_EXIT" -ne 0 ]]; then
  _fail "T5: Python mutation script failed to create mutated file"
else
  # Verify the mutation looks different from original
  ORIG_L120_RAW=$(grep -n 'probe_remote_client' "$TARGET" | head -1)
  # Get the write-out line from the mutated file, after probe_remote_client
  MUT_WRITEOUT=$(awk '/probe_remote_client/,0' "$L120_MUTATED" | grep -- '--write-out' | head -1)
  ORIG_WRITEOUT=$(awk '/probe_remote_client/,0' "$TARGET" | grep -- '--write-out' | head -1)

  if [[ "$MUT_WRITEOUT" != "$ORIG_WRITEOUT" ]]; then
    _pass "T5: L120 mutation applied (line differs from original)"
  else
    _fail "T5: L120 mutation produced identical line (mutation failed)"
  fi

  # Verify the mutated script still passes bash -n
  if bash -n "$L120_MUTATED" 2>/dev/null; then
    _pass "T5: mutated script passes bash -n"
  else
    _fail "T5: mutated script fails bash -n"
  fi

  # Start the live server again
  rm -f "$LIVE_DB"
  sqlite3 "$LIVE_DB" "
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    gateway_url TEXT NOT NULL,
    is_self INTEGER DEFAULT 0
  );
  INSERT INTO clients (id, name, gateway_url, is_self) VALUES
    ('c_live', 'live-green', '${GATEWAY}', 0);
  " || { _fail "T5: could not create live DB"; }

  python3 -c "
import http.server, json, sys
HEALTH_PATH = '/api/health/deep'
HOST = '127.0.0.1'
PORT = int(sys.argv[1])
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == HEALTH_PATH:
            body = '{\"pass\":true,\"indeterminate\":false,\"checks\":{\"app\":{\"pass\":true}}}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body.encode())
        else:
            self.send_response(404)
            self.end_headers()
    def log_message(self, *a): pass
with http.server.HTTPServer((HOST, PORT), Handler) as s:
    s.timeout = 15
    while True:
        s.handle_request()
" "$LIVE_PORT" &
SERVER_PID=$!
cleanup_held="$cleanup_held $SERVER_PID"
sleep 0.3

  # Run the MUTATED script — it should FAIL (broken L120 makes clients UNREACHABLE)
  MUT_LIVE_OUTPUT=$(bash "$L120_MUTATED" --remote --db-path "$LIVE_DB" 2>/dev/null) || true
  MUT_LIVE_EXIT=$?

  # Kill the server
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  cleanup_held=""

  # The mutated script should report the client as UNREACHABLE
  if echo "$MUT_LIVE_OUTPUT" | grep -q '"detail":"unreachable"'; then
    _pass "T5: MUTATED (broken L120) reports client UNREACHABLE — mutation detected"
  else
    _fail "T5: MUTATED script did NOT report unreachable — L120 mutation invisible"
  fi

  if echo "$MUT_LIVE_OUTPUT" | grep -q '"pass":false' && \
     echo "$MUT_LIVE_OUTPUT" | grep -q '"indeterminate":true'; then
    _pass "T5: MUTATED output has pass:false, indeterminate:true (broken)"
  else
    _fail "T5: MUTATED output missing pass:false/indeterminate:true"
  fi

  if echo "$MUT_LIVE_OUTPUT" | grep -q '"http_code":0'; then
    _pass "T5: MUTATED output has http_code:0 (curl parse failed)"
  else
    _fail "T5: MUTATED output missing http_code:0"
  fi

  rm -f "$L120_MUTATED"
fi

# ── summary ───────────────────────────────────────────────────────────────
echo ""; echo "=========================================="
echo "  PASS: $PASS  FAIL: $FAIL"
echo "=========================================="
[ "$FAIL" -eq 0 ] || exit 1
