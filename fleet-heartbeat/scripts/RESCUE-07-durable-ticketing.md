# FIX-RESCUE-07 — Durable Ticketing Redesign

Replaces the ephemeral n8n **workflow static-data** ticket store (wiped on every
relay re-import, never GC'd, no durable ids / ownership / severity / SLA / audit
/ reopen / reporting) with a **durable SQLite store on the operator box** plus a
validated state machine, human-facing `RR-` numbers, an audit trail, SLA
auto-escalation, a read view, and garbage collection.

The durable file lives **outside n8n**, so re-importing the relay workflow can
never wipe it.

## Components (all in `fleet-heartbeat/scripts/`)

| File | Role |
|---|---|
| `lib/rescue-ticket-store.mjs` | Durable store: schema, RR- numbering, state machine, audit events, severity/SLA, dedup, GC, read view. Backend = `node:sqlite` (Node ≥ 22.5, zero install). Fails **closed** if SQLite is missing. |
| `rescue-sla-sweep.mjs` | SLA auto-escalation. Escalates SLA-breached tickets → `ESCALATED` (owner → operator) + audit event. Emits per-ticket JSON `page` payloads on stdout (no secrets in-file). Run every 5 min. |
| `rescue-report.mjs` | Read view: open-by-severity, MTTR, repeat offenders, cap usage. Text or `--json`. |
| `rescue-gc.mjs` | Durable-store GC: prune old `CLOSED`/`RESOLVED` tickets (events cascade) + stale counters. |
| `relay-brain-gc-snippet.js` | **Interim** GC for the in-n8n static-data store during the migration window (`rescueBrainGc(store)`), so it stops growing unbounded until the durable store fully takes over. |
| `lib/rescue-receiver-store-hook.mjs` | Fail-open, lazy bridge the receiver calls to persist inbound tickets + every answer/escalation as durable audit events. |

## Schema

`tickets` — `ticket_id` (pk), `rr_number` (unique, monotonic → `RR-000123`),
`client`, `box`, `box_type`, `agent`, `person`, `failure_class`, `severity`,
`status`, `owner`, `source` (`pathA` client-agent / `pathB` heartbeat-remediate),
`problem`, `answer`, `decision_mode`, `created_at`, `first_response_at`,
`resolved_at`, `resolved_by`, `sla_due_at`, `escalated_at`, `dedup_key`,
`day_count_key`, `updated_at`.

`ticket_events` — append-only audit: `ticket_id`, per-ticket `seq`, `at`,
`from_status`, `to_status`, `actor`, `decision_mode`, `note`.

`counters` — `day_key` (`client|YYYY-MM-DD`) → `count` (the 25/day cap source).
`meta` — holds the monotonic `rr_seq`.

## State machine

```
OPEN → ACK → IN_PROGRESS → (RESOLVED | ESCALATED | NEEDS_HUMAN) → CLOSED
                                         ↑                          ↓
                                    (REOPENED) ←──────────── RESOLVED/CLOSED
```

`LEGAL_TRANSITIONS` is enforced — an illegal jump throws; every transition
writes a `ticket_events` row. Ownership flips to `operator` on
`ESCALATED`/`NEEDS_HUMAN`; the `rescue-agent` owns the auto-working states.

## Severity → SLA

| Severity | Example classes | SLA |
|---|---|---|
| SEV1 | gateway/box down, unreachable, billing, credential/secret, crash | 15 min |
| SEV2 | agent/provider error, cron, delivery, timeout, queue | 60 min |
| SEV3 | coach, config, setup, unknown (default) | 240 min |
| SEV4 | deliver-answer, how-to, info, test/synthetic | 1440 min |

## Wiring

### 1. Receiver (`rescue-receiver.mjs`) — two best-effort touch points

The receiver already emits `decisionMode` + `status` on every post; the hook
turns those into durable tickets + events. Both calls are fail-open (a store
error only logs — the Telegram answer path is never blocked):

```js
import * as store from "./lib/rescue-receiver-store-hook.mjs";

// async escalate branch, after send(res, 202, ...):
store.recordInbound({
  ticketId, client: returnExtras.client, agent: returnExtras.agent,
  message, failureClass: fixMode.mode, source: parsed.source || "pathA",
});

// inside postAnswerBack(), after the relay POST resolves:
store.recordAnswerEvent({
  ticketId, answer, decisionMode: merged.decisionMode,
  status: merged.status, statusPrefix: merged.statusPrefix,
});
```

> The receiver body carries client identifiers in its return-leg allowlist, so
> its edit is applied on the **private operator deploy**, not committed to this
> public repo. This module + snippet are the client-name-free integration
> surface committed here.

### 2. Relay Brain (n8n Code node) — interim GC

Paste the top of `relay-brain-gc-snippet.js` into the Relay Brain node and add
`rescueBrainGc(store);` right after the store shape is ensured. Prunes old
terminal tickets + stale counters on every invocation; never drops
open/in-progress tickets.

### 3. SLA sweep — every 5 minutes

Wire `rescue-sla-sweep.mjs` to an n8n Schedule trigger (5-min) **or** a
launchd/cron entry (matching the poller/watchdog direct-command pattern). Route
each emitted `pages[].text` to the operator via the existing credential-backed
Telegram node. Runs clean (exit 0) when nothing is due.

### 4. GC + reporting — daily / on demand

`node rescue-gc.mjs` (daily cron) and `node rescue-report.mjs` (on demand or a
digest cron).

### Config

`RESCUE_TICKET_DB` overrides the DB path (default:
`fleet-heartbeat/state/rescue-tickets.sqlite`). Resolved at call time.

## Tests

```
node --test fleet-heartbeat/scripts/lib/*.test.mjs
```

Covers RR numbering + idempotent mint, the state machine (legal/illegal/reopen),
ownership + timestamp transitions, the full audit chain, SLA `dueForEscalation`,
semantic dedup, GC (durable + relay-brain snippet), the read view, cross-session
durability, and the receiver hook lifecycle.

## Relationship to sibling Rescue fixes

- **RESCUE-06** posts outages as tickets with `source: "pathB"` → `recordInbound`.
- **RESCUE-08** semantic dedup uses `dedupKey()` + `findByDedup()` (fields +
  lookup shipped here; the mint-time dedup decision lands in RESCUE-08).
- **RESCUE-11(i)** cross-restart double-answer is prevented by checking durable
  `ticket.status` instead of the process-local `_answeredTickets` Set.
