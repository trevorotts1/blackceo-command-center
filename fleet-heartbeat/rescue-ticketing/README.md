# Rescue-Rangers Ticketing Redesign (FIX-RESCUE-07)

Durable, auditable replacement for the volatile n8n workflow-static-data ticket
store. This is a **planned** change (not the out-of-band outage remediation): it
ships as a reviewed PR and is applied deliberately, never hot-patched into the
live relay during an incident.

## Why

The old store was n8n workflow static data: wiped on every workflow re-import
(the ~15 dated export backups prove constant re-imports), never garbage
collected, with no durable ids, ownership, severity, SLA, audit trail, reopen,
or reporting. This redesign moves the store out of the workflow into a durable
database and adds the missing lifecycle machinery.

## Pieces

| File | Role |
|------|------|
| `schema.sql` | Postgres/Supabase DDL: `tickets`, `ticket_events`, `rr_ticket_seq`, severity/status enums, indexes, and the reporting views. |
| `ticket_store.mjs` | Pure, storage-agnostic decision core: RR- numbering, the state machine + legal-transition guard, severity + SLA computation, ownership flips, semantic dedup keys, audit-event builder. No I/O — used identically by an n8n Code node or the receiver. |
| `tests/test-ticket-store.mjs` | Unit tests for every rule above. |

## Durable store options

1. **Postgres / Supabase (recommended)** — apply `schema.sql`. The n8n workflow
   talks to it through a Postgres credential (Insert/Update/Select nodes or a
   Code node using `ticket_store.mjs`). Survives every workflow re-import.
2. **n8n Data Table** — for an all-in-n8n deployment, create a `tickets` Data
   Table with the same columns as `schema.sql` and a `ticket_events` table for
   the audit trail. `ticket_store.mjs` is unchanged; only the read/write nodes
   differ. Data Tables persist independently of the workflow JSON.

Either way the workflow JSON no longer holds ticket state, so re-imports are safe.

## RR- ticket numbers

Human-facing ids are `RR-000123`, formatted by `formatTicketNumber(seq)` from a
monotonic integer. In Postgres that integer is `nextval('rr_ticket_seq')`; in an
n8n Data Table it is `max(seq)+1` under a short lock. Monotonic + unique even
under concurrent inserts.

## State machine (audited)

```
OPEN ──► ACK ──► IN_PROGRESS ──► RESOLVED ──► CLOSED
  │        │          │  ├──► ESCALATED ───┐
  │        │          │  └──► NEEDS_HUMAN ──┤
  └────────┴──────────┴────────────────────┘
RESOLVED / CLOSED ──► REOPENED ──► (ACK | IN_PROGRESS | …)
```

`LEGAL_TRANSITIONS` is fail-closed: `assertTransition(from, to)` throws on any
edge not in the map, so a bad caller can never drive a ticket into an impossible
state. **Every** transition appends an immutable row to `ticket_events`
(`from_status`, `to_status`, `actor`, `note`, `at`). The receiver already emits a
`decisionMode` + `status` on every post — persist each as an event.

## Ownership

`ownerFor(status, decisionMode)`:

- `rescue-agent` while the ticket is auto-working (OPEN / ACK / IN_PROGRESS with
  an auto decision mode).
- flips to `operator` on `ESCALATED`, `NEEDS_HUMAN`, a `HUMAN_NEEDED` decision,
  or any billing / agent-timeout / queue-cap page.

## Severity → SLA

`severityFor(failure_class, decisionMode)` then `computeSlaDue(created_at, severity)`:

| Severity | Example classes | SLA (response) |
|----------|-----------------|----------------|
| critical | mac-tunnel-unreachable, gateway-down, container-exited, billing, data-loss, security | 15 min |
| high | gateway-port-closed, gateway-auth, config-invalid | 30 min |
| medium | coach-client-agent, how-to, unknown (default) | 120 min |
| low | routing-test, synthetic, deliver-answer | 480 min |

Unknown classes default to **medium** (never silently low); a `HUMAN_NEEDED`
decision lifts medium/low to at least high.

## SLA auto-escalation

A **5-minute n8n Schedule trigger** selects `rr_sla_breaches` (open tickets past
`sla_due_at`), and for each: writes an `ESCALATED` event, sets `status=ESCALATED`
+ `owner=operator` + `escalated_at=now()`, and pages the operator Fixer topic
(operator-verbose is correct — the we-move-in-silence rule is client-facing only).
`isBreached()` ignores terminal (RESOLVED/CLOSED) tickets.

## Semantic dedup (pairs with FIX-RESCUE-08)

Before minting, compute `dedupKey(client, failure_class)` and look for an OPEN
ticket with the same key inside `DEDUP_WINDOW_MINUTES` (6h). If found: append a
`recurred` event, increment `recurred_count`, return the existing `ticket_id`,
and **do not** consume the daily cap. `day_count_key` is the cap denominator
(`client::class::YYYY-MM-DD`); deduped recurrences never create a new row, so the
25/day cap counts real distinct incidents only.

## Reporting (read layer)

`schema.sql` ships four views for the operator + n8n:
`rr_open_by_severity`, `rr_mttr_30d`, `rr_repeat_offenders`, `rr_cap_usage_today`
(plus `rr_sla_breaches` for the monitor).

## Interim GC

Until the durable store is live, run a GC pass from Relay Brain: delete
closed-resolved tickets older than 90 days and stale day-count counters. The
Postgres form is the commented `DELETE` at the bottom of `schema.sql`.

## Detection-path unification (pairs with FIX-RESCUE-06)

`remediate.sh` / `heartbeat.sh` DOWN rows should POST `{action:"escalate", …}`
with a deterministic `ticket_id` seed (`<client>-<class>-<YYYY-MM-DD>`); FIXED
outcomes immediately POST `{action:"answer", statusPrefix:"fixed:"}`. That makes
heartbeat/remediate outages first-class tickets with the same lifecycle + SLA as
receiver tickets. (Tracked separately as FIX-RESCUE-06.)
