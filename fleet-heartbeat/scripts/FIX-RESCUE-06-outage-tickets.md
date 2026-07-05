# FIX-RESCUE-06 — heartbeat/remediate outages become durable tickets

**Priority:** P2 · **Area:** Rescue Rangers · **Wave:** 1 · **Depends on:** FIX-RESCUE-07

## Problem

The two detection paths were disconnected. Path A (client agents) minted tickets
through the relay; Path B (`heartbeat.sh` / `remediate.sh` finding a box DOWN and
trying to fix it) never created a ticket at all — so a real fleet outage had **no
id, no lifecycle, no SLA, and no audit trail**. An outage that auto-fixed left no
record; one that did not was invisible to the ticketing system.

## Fix

A client-name-free sourced shell library, `scripts/lib/rescue-outage-ticket.sh`,
gives `heartbeat.sh` / `remediate.sh` **one call per DOWN row** that POSTs a
proper ticket to the Rescue relay:

- **every DOWN row → `{action:"escalate", ...}`** with a **deterministic
  ticketId `<client>-<class>-<YYYY-MM-DD>`** (UTC). A box that flaps on the same
  day folds onto the same ticketId (idempotent), and different-id recurrences are
  absorbed by the semantic dedup of FIX-RESCUE-08 — neither burns the 25/day cap.
- **a FIXED outcome → immediately POSTs `{action:"answer", statusPrefix:"fixed:"}`**
  so the ticket resolves the moment remediation succeeds.
- **an UNFIXED row stays OPEN** as an escalation under its severity-derived SLA
  (the SLA sweep, FIX-RESCUE-07, escalates it to the operator on breach).

The payload carries `clientName`, `failureClass`, `problem`, `alreadyTried`,
`remediate-outcome`, and `source:"pathB"`.

### Library API (`rescue-outage-ticket.sh`)

| function | purpose |
|---|---|
| `rr_outage_slug <text>` | lowercase + dash-slugify an identifier for the ticketId |
| `rr_outage_ticket_id <client> <class>` | deterministic `<client>-<class>-<YYYY-MM-DD>` |
| `rr_outage_escalate <client> <class> <problem> <alreadyTried> <outcome>` | POST an OPEN escalation |
| `rr_outage_answer_fixed <client> <class> <problem> <outcome>` | POST a `fixed:` answer |
| `rr_outage_report <client> <class> <problem> <alreadyTried> <outcome> <state>` | dispatcher: `fixed`→answer, else→escalate |

### Environment

| var | meaning |
|---|---|
| `RESCUE_RELAY_URL` | relay webhook URL (required unless a seam/dry-run is set) |
| `RESCUE_RELAY_AUTH_HEADER` | full header line, e.g. `X-Rescue-Auth: <secret>` — read from the secret store, **never printed** |
| `RR_OUTAGE_TIMEOUT` | curl `--max-time` seconds (default 15) |
| `RR_OUTAGE_DATE` | override the UTC date stamp (tests/determinism) |
| `RR_OUTAGE_SOURCE` | source tag on the payload (default `pathB`) |
| `RR_OUTAGE_POST_CMD` | test seam: command fed the JSON on stdin instead of curl |
| `RR_OUTAGE_DRYRUN=1` | print the JSON to stdout instead of POSTing |

JSON is built by `node` (a guaranteed dependency of this subsystem), so quotes,
newlines and control characters in problem/answer text can never break the
payload; field values are passed to node via the environment (not argv), so
nothing lands in `ps` output.

## Wiring (applied on the private operator deploy)

`heartbeat.sh` / `remediate.sh` carry the client return-leg allowlist and are
**not** committed to this public repo; the edit is applied on the operator box:

```sh
source "$(dirname "$0")/lib/rescue-outage-ticket.sh"
# ... inside the per-DOWN-row handling, AFTER the remediation attempt ...
if [ "$fix_succeeded" = "1" ]; then
  rr_outage_report "$client" "$failure_class" "$problem" "$already_tried" "$remediate_outcome" fixed
else
  rr_outage_report "$client" "$failure_class" "$problem" "$already_tried" "$remediate_outcome" open
fi
```

`RESCUE_RELAY_URL` and `RESCUE_RELAY_AUTH_HEADER` are exported from the secret
store by the caller — never hardcoded.

## Verification

`bash scripts/lib/rescue-outage-ticket.test.sh` (22 assertions, no network):
deterministic ticketId, escalate/answer payload shape, `source:pathB`,
`fixed:`-prefixed answer, `report` routing, robust JSON escaping (embedded
quotes + newlines round-trip), and the dry-run seam. `bash -n` clean.
