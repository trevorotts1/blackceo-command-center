# shellcheck shell=bash
# === Rescue Rangers — OUTAGE -> TICKET bridge (FIX-RESCUE-06) ================
#
# WHY THIS EXISTS
# ---------------
# The two detection paths were disconnected: heartbeat.sh / remediate.sh could
# find a client box DOWN, try to fix it, and never create a ticket — so a
# Path-B outage had no id, no lifecycle, no SLA, and no audit trail. This
# sourced library gives those scripts one call per DOWN row that POSTs a proper
# ticket to the Rescue relay:
#
#   * every DOWN row  -> {action:"escalate", ...} with a DETERMINISTIC ticketId
#                        "<client>-<class>-<YYYY-MM-DD>" so a flapping box on the
#                        same day folds onto the same ticket (idempotent id;
#                        semantic dedup handles the rest, FIX-RESCUE-08);
#   * a FIXED outcome -> immediately POSTs {action:"answer", statusPrefix:"fixed:"}
#                        so the ticket resolves;
#   * an UNFIXED row  -> stays OPEN as an escalation under its SLA.
#
# CLIENT-NAME-FREE: the client / failure-class / problem text are always passed
# in by the caller as runtime arguments. Nothing here hardcodes an identifier,
# URL, secret, or path — every one comes from the environment at call time.
#
# SECRETS: the auth header value is read from the environment and NEVER printed.
# All builders route through `printf '%s'` on already-captured values; the token
# is only ever handed to curl via an argument array, never echoed or logged.
#
# WIRING (in heartbeat.sh / remediate.sh):
#   source "$(dirname "$0")/lib/rescue-outage-ticket.sh"
#   # ... inside the per-DOWN-row handling, after the remediation attempt ...
#   if [ "$fix_succeeded" = "1" ]; then
#     rr_outage_report "$client" "$failure_class" "$problem" "$already_tried" \
#                      "$remediate_outcome" fixed
#   else
#     rr_outage_report "$client" "$failure_class" "$problem" "$already_tried" \
#                      "$remediate_outcome" open
#   fi
#
# ENVIRONMENT
#   RESCUE_RELAY_URL          (required unless RR_OUTAGE_POST_CMD/DRYRUN set)
#   RESCUE_RELAY_AUTH_HEADER  full header line, e.g. "X-Rescue-Auth: <secret>"
#                             (optional; read from the secret store by caller)
#   RR_OUTAGE_TIMEOUT         curl --max-time seconds (default 15)
#   RR_OUTAGE_DATE            override the UTC date stamp (tests/determinism)
#   RR_OUTAGE_SOURCE          source tag on the payload (default "pathB")
#   RR_OUTAGE_POST_CMD        test/seam: command fed the JSON on stdin instead
#                             of curl (e.g. "cat >>/tmp/posts.jsonl")
#   RR_OUTAGE_DRYRUN=1        print the JSON to stdout instead of POSTing
# ---------------------------------------------------------------------------

# Slugify a free-text identifier into a ticketId-safe token: lowercase, spaces
# and separators -> '-', drop everything but [a-z0-9-], collapse and trim '-'.
rr_outage_slug() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/-+/-/g; s/^-//; s/-$//'
}

# Deterministic ticket id: "<client>-<class>-<YYYY-MM-DD>" (UTC).
rr_outage_ticket_id() {
  local client_slug class_slug date_stamp
  client_slug="$(rr_outage_slug "$1")"
  class_slug="$(rr_outage_slug "$2")"
  date_stamp="${RR_OUTAGE_DATE:-$(date -u +%Y-%m-%d)}"
  [ -n "$client_slug" ] || client_slug="unknown"
  [ -n "$class_slug" ] || class_slug="unknown"
  printf '%s-%s-%s' "$client_slug" "$class_slug" "$date_stamp"
}

# Build one JSON object from named fields, robustly escaped. Uses node (a
# guaranteed dependency of this subsystem — the receiver is Node) so quoting,
# newlines, and control chars in problem/answer text can never break the JSON.
# Field values are passed via the environment, NOT the argv, so nothing lands in
# `ps` output and the escaping is done by JSON.stringify, not the shell.
rr_outage__build_json() {
  RR_J_ACTION="$1" \
  RR_J_TICKETID="$2" \
  RR_J_CLIENT="$3" \
  RR_J_CLASS="$4" \
  RR_J_PROBLEM="$5" \
  RR_J_TRIED="$6" \
  RR_J_OUTCOME="$7" \
  RR_J_STATUSPREFIX="$8" \
  RR_J_ANSWER="$9" \
  RR_J_SOURCE="${RR_OUTAGE_SOURCE:-pathB}" \
  node -e '
    const e = process.env;
    const obj = {
      action: e.RR_J_ACTION,
      ticketId: e.RR_J_TICKETID,
      source: e.RR_J_SOURCE,
      clientName: e.RR_J_CLIENT,
      failureClass: e.RR_J_CLASS,
      problem: e.RR_J_PROBLEM,
    };
    if (e.RR_J_TRIED) obj.alreadyTried = e.RR_J_TRIED;
    if (e.RR_J_OUTCOME) obj["remediate-outcome"] = e.RR_J_OUTCOME;
    if (e.RR_J_STATUSPREFIX) obj.statusPrefix = e.RR_J_STATUSPREFIX;
    if (e.RR_J_ANSWER) obj.answer = e.RR_J_ANSWER;
    process.stdout.write(JSON.stringify(obj));
  '
}

# POST a JSON body (stdin) to the relay. Honors the test seam and dry-run. The
# auth header is passed to curl as a single argv element and is never printed.
rr_outage__post() {
  local json
  json="$(cat)"

  if [ -n "${RR_OUTAGE_POST_CMD:-}" ]; then
    printf '%s' "$json" | eval "$RR_OUTAGE_POST_CMD"
    return $?
  fi
  if [ "${RR_OUTAGE_DRYRUN:-0}" = "1" ]; then
    printf '%s\n' "$json"
    return 0
  fi
  if [ -z "${RESCUE_RELAY_URL:-}" ]; then
    printf '[rr-outage] RESCUE_RELAY_URL unset — cannot POST ticket\n' >&2
    return 3
  fi

  local -a hdr=(-H "Content-Type: application/json")
  if [ -n "${RESCUE_RELAY_AUTH_HEADER:-}" ]; then
    hdr+=(-H "$RESCUE_RELAY_AUTH_HEADER")
  fi
  local code
  code="$(printf '%s' "$json" \
    | curl -sS --max-time "${RR_OUTAGE_TIMEOUT:-15}" -o /dev/null -w '%{http_code}' \
        -X POST "${hdr[@]}" --data-binary @- "$RESCUE_RELAY_URL" 2>/dev/null)"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '[rr-outage] relay POST transport error (curl rc=%s)\n' "$rc" >&2
    return 2
  fi
  case "$code" in
    2??) return 0 ;;
    *)
      printf '[rr-outage] relay POST returned HTTP %s\n' "$code" >&2
      return 4
      ;;
  esac
}

# Escalate a DOWN row -> OPEN ticket (stays open under SLA until answered).
#   rr_outage_escalate <client> <class> <problem> <alreadyTried> <remediateOutcome>
rr_outage_escalate() {
  local client="$1" class="$2" problem="$3" tried="$4" outcome="$5"
  local tid
  tid="$(rr_outage_ticket_id "$client" "$class")"
  rr_outage__build_json "escalate" "$tid" "$client" "$class" "$problem" "$tried" "$outcome" "" "" \
    | rr_outage__post
}

# A FIXED outcome -> answer the ticket with a "fixed:" status prefix.
#   rr_outage_answer_fixed <client> <class> <problem> <remediateOutcome>
rr_outage_answer_fixed() {
  local client="$1" class="$2" problem="$3" outcome="$4"
  local tid answer
  tid="$(rr_outage_ticket_id "$client" "$class")"
  answer="${outcome:-auto-remediated}"
  rr_outage__build_json "answer" "$tid" "$client" "$class" "$problem" "" "$outcome" "fixed:" "$answer" \
    | rr_outage__post
}

# Convenience dispatcher the DOWN-row loop calls once per row.
#   rr_outage_report <client> <class> <problem> <alreadyTried> <outcome> <state>
# where <state> is "fixed" (-> answer) or anything else (-> escalate/open).
rr_outage_report() {
  local client="$1" class="$2" problem="$3" tried="$4" outcome="$5" state="$6"
  case "$state" in
    fixed|FIXED|resolved|RESOLVED)
      rr_outage_answer_fixed "$client" "$class" "$problem" "$outcome"
      ;;
    *)
      rr_outage_escalate "$client" "$class" "$problem" "$tried" "$outcome"
      ;;
  esac
}
