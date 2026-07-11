# shellcheck shell=bash
# === Rescue Rangers — POLLER FETCH with distinct error classes (FIX-RESCUE-11 iv)
#
# WHY THIS EXISTS
# ---------------
# The poller ran curl and, on any hiccup, exited 0 silently — it could not tell
# "no tickets waiting" (a normal, healthy poll) from a transport failure (relay
# unreachable) or an HTTP error (500/403) or a malformed body (parse error).
# Every one of those looked like "nothing to do", so a broken relay was
# invisible.
#
# `rr_poll_fetch` separates the two INDEPENDENT signals — the curl EXIT CODE and
# the HTTP STATUS CODE — and reports them as distinct outcomes. The body is
# written to a file (NOT stdout) and the http code is set in the CALLER's shell,
# so a caller can read all three signals reliably WITHOUT a command-substitution
# subshell swallowing the exported code. The caller then parses the body and can
# distinguish an EMPTY-but-valid "no tickets" response from a PARSE error.
#
# RETURN CODES
#   0  OK        — 2xx; body written to "$RR_POLL_BODY_FILE" (may be empty / "no tickets")
#   2  TRANSPORT — curl itself failed (DNS/timeout/refused); body file emptied
#   3  HTTP      — a non-2xx status; the code is logged; body file emptied
# ALWAYS set in the caller's shell: RR_POLL_HTTP_CODE (the numeric status),
# RR_POLL_BODY_FILE (path to the body file — created if the caller did not set it).
#
# USAGE (in rescue-rangers-poller.sh) — call in the CURRENT shell, not "$(...)":
#   . "$(dirname "$0")/lib/rescue-poll-fetch.sh"
#   RR_POLL_BODY_FILE="$(mktemp)"
#   if rr_poll_fetch "$POLL_URL"; then
#     if ! some-json-parse < "$RR_POLL_BODY_FILE"; then
#       log "PARSE error on an HTTP $RR_POLL_HTTP_CODE body"   # != no-tickets
#     fi
#   else
#     case $? in
#       2) log "relay UNREACHABLE (transport)";;   # page/alert path
#       3) log "relay HTTP $RR_POLL_HTTP_CODE";;    # page/alert path
#     esac
#   fi
#   rm -f "$RR_POLL_BODY_FILE"
#
# CLIENT-NAME-FREE and secret-free: the URL and any auth header are passed in /
# read from the environment by the caller; nothing is hardcoded or printed.
# ---------------------------------------------------------------------------

# rr_poll_fetch <url> [extra curl args...]
# Body -> "$RR_POLL_BODY_FILE"; status -> "$RR_POLL_HTTP_CODE"; class via return.
rr_poll_fetch() {
  local url="$1"; shift || true

  # Body sink: honor a caller-provided file, else create (and export) one.
  if [ -z "${RR_POLL_BODY_FILE:-}" ]; then
    RR_POLL_BODY_FILE="$(mktemp -t rr-poll.XXXXXX)" || {
      RR_POLL_HTTP_CODE="000"
      printf '[rr-poll] mktemp failed\n' >&2
      return 2
    }
  fi
  export RR_POLL_BODY_FILE

  local code rc
  # -w writes ONLY the http_code to stdout; the body goes to the file, so the
  # two signals never contaminate each other.
  code="$(curl -sS --max-time "${RR_POLL_TIMEOUT:-20}" \
            -o "$RR_POLL_BODY_FILE" -w '%{http_code}' "$@" "$url" 2>/dev/null)"
  rc=$?
  RR_POLL_HTTP_CODE="$code"
  export RR_POLL_HTTP_CODE

  if [ "$rc" -ne 0 ]; then
    : > "$RR_POLL_BODY_FILE"
    printf '[rr-poll] transport error (curl rc=%s)\n' "$rc" >&2
    return 2
  fi

  case "$code" in
    2??) return 0 ;;
    *)
      : > "$RR_POLL_BODY_FILE"
      printf '[rr-poll] HTTP %s from relay\n' "$code" >&2
      return 3
      ;;
  esac
}
