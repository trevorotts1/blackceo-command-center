#!/usr/bin/env bash
# Tests for rescue-poll-fetch.sh (FIX-RESCUE-11 iv).
#
# Distinguishes the three outcomes — OK(2xx) / TRANSPORT / HTTP — deterministically
# and WITHOUT a network by shadowing `curl` with a scripted fake on PATH.
# Called in the CURRENT shell (never "$(...)") so RR_POLL_HTTP_CODE / RR_POLL_BODY_FILE
# are readable, matching the documented usage.
#
# Run:  bash rescue-poll-fetch.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./rescue-poll-fetch.sh
. "${HERE}/rescue-poll-fetch.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2' want '$3')"; fi; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rrpf.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Fake curl: honors -o <file> and -w <fmt>, emulating a real curl per env vars:
#   FAKE_CURL_RC   : exit code curl returns (0 = transport ok)
#   FAKE_CURL_CODE : http_code to emit via -w
#   FAKE_CURL_BODY : body written to the -o file
mkdir -p "$WORK/bin"
cat > "$WORK/bin/curl" <<'FAKE'
#!/usr/bin/env bash
outfile=""; wfmt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2;;
    -w) wfmt="$2"; shift 2;;
    *) shift;;
  esac
done
[ -n "$outfile" ] && printf '%s' "${FAKE_CURL_BODY:-}" > "$outfile"
printf '%s' "${wfmt//'%{http_code}'/${FAKE_CURL_CODE:-000}}"
exit "${FAKE_CURL_RC:-0}"
FAKE
chmod +x "$WORK/bin/curl"
export PATH="$WORK/bin:$PATH"

BODY="$WORK/body.txt"

# --- OK: 2xx with a body ("no tickets" body is still a healthy poll) --------
RR_POLL_BODY_FILE="$BODY" FAKE_CURL_RC=0 FAKE_CURL_CODE=200 FAKE_CURL_BODY='[]'
export RR_POLL_BODY_FILE FAKE_CURL_RC FAKE_CURL_CODE FAKE_CURL_BODY
rr_poll_fetch http://relay/poll; rc=$?
eq "2xx returns 0"       "$rc" "0"
eq "2xx body in file"    "$(cat "$BODY")" "[]"
eq "2xx sets http code"  "$RR_POLL_HTTP_CODE" "200"

# empty-but-2xx is distinguishable from an error (rc 0, empty body)
FAKE_CURL_CODE=204 FAKE_CURL_BODY='' rr_poll_fetch http://relay/poll; rc=$?
eq "204 no-content returns 0" "$rc" "0"
eq "204 body empty"           "$(cat "$BODY")" ""

# --- TRANSPORT: curl itself fails (rc != 0) --------------------------------
FAKE_CURL_RC=7 FAKE_CURL_CODE=000 FAKE_CURL_BODY='' rr_poll_fetch http://relay/poll 2>/dev/null; rc=$?
eq "transport error returns 2"   "$rc" "2"
eq "transport error empties body" "$(cat "$BODY")" ""

# --- HTTP: transport ok but non-2xx status ---------------------------------
FAKE_CURL_RC=0 FAKE_CURL_CODE=500 FAKE_CURL_BODY='oops' rr_poll_fetch http://relay/poll 2>/dev/null; rc=$?
eq "http 500 returns 3"       "$rc" "3"
eq "http 500 suppresses body" "$(cat "$BODY")" ""
eq "http 500 code exported"   "$RR_POLL_HTTP_CODE" "500"

FAKE_CURL_RC=0 FAKE_CURL_CODE=403 FAKE_CURL_BODY='' rr_poll_fetch http://relay/poll 2>/dev/null; rc=$?
eq "http 403 returns 3" "$rc" "3"

# --- auto-creates a body file when the caller does not provide one ----------
unset RR_POLL_BODY_FILE
FAKE_CURL_RC=0 FAKE_CURL_CODE=200 FAKE_CURL_BODY='ok' rr_poll_fetch http://relay/poll; rc=$?
eq "auto body file returns 0"  "$rc" "0"
eq "auto body file populated"  "$(cat "$RR_POLL_BODY_FILE")" "ok"
rm -f "$RR_POLL_BODY_FILE"

printf '\nrescue-poll-fetch.test.sh: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
