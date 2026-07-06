# FIX-RESCUE-08 — semantic dedup before mint (stop burning the 25/day cap)

**Priority:** P2 · **Area:** Rescue Rangers · **Wave:** 1 · **Depends on:** FIX-RESCUE-07

## Problem

Dedup matched **identical ticketIds only** — but client agents never persist a
ticketId, so a recurring problem minted a **fresh ticket every time** and burned
the 25/day per-client cap. A single flapping box could exhaust the cap and start
paging a human for a problem that already had an open ticket.

## Fix

Semantic dedup **before minting**, keyed on the problem, not the id:

- `dedup_key = sha256(client + "|" + failure_class)` (normalized: trimmed,
  lowercased) → the first 16 hex chars. Shipped in FIX-RESCUE-07 as
  `dedupKey()` and matched byte-for-byte by the relay snippet.
- Before minting, look for a **still-open** ticket with the same `dedup_key`
  inside a **6h window**. On a hit: append a **`recurred` event** to that ticket
  and return `{ status:"deduped", ticketId:<existing> }` **without minting an RR
  number and without incrementing the 25/day cap**.
- **Exact-id repeats** (n8n retries) are handled first and are also no-count.
- A **terminal** (RESOLVED/CLOSED) or **out-of-window** sibling does **not**
  absorb a new outage — a genuinely new problem still mints (and counts).

The decision exists in two mirrored places so the durable store and the in-n8n
path make the **same** call during the migration window:

1. **Durable store** — `TicketStore.mintOrRecur()` +
   `TicketStore.recurrence()` in `lib/rescue-ticket-store.mjs`. Uniform return
   shape `{ status:"minted"|"deduped"|"exists", deduped, minted, ticketId,
   rrNumber, ticket }` so the caller does cap accounting once.
2. **n8n Relay Brain** (where the live 25/day cap counter lives) —
   `relay-brain-dedup-snippet.js`: `rescueDedupBeforeMint(store, {...})` returns
   `'mint' | 'deduped' | 'exists'`; only `'mint'` proceeds to the existing
   mint-and-cap-increment block. `rescueStampDedupKey(ticket, client, class)`
   stamps the key onto new tickets so future recurrences can find them.

## Wiring

### Durable store (already committed)

Any mint path should call `store.mintOrRecur({ ticketId, client, failureClass,
problem })` instead of `createTicket(...)`; a `status:"deduped"` result means do
not count the cap.

### n8n Relay Brain (applied on the private n8n instance)

Paste the top of `relay-brain-dedup-snippet.js` into the Relay Brain Code node
(after the store shape is ensured and the FIX-RESCUE-07 GC snippet), then at the
mint point:

```js
const dd = rescueDedupBeforeMint(store, { client, failureClass, ticketId, problem });
if (dd.status === 'deduped') {
  return [{ json: { status: 'deduped', ticketId: dd.ticketId } }];  // DO NOT ++ cap
}
// else: existing mint path — call rescueStampDedupKey(newTicket, client, failureClass)
// before storing, then increment store.counters[dayKey].
```

## Verification

- `node --test scripts/lib/rescue-ticket-store.test.mjs` — `mintOrRecur`/
  `recurrence` cases: mint counts the cap; a different-id recurrence dedups
  onto the open ticket and does **not** increment the cap; exact-id idempotency;
  a different failure_class mints; a resolved sibling does not absorb; the 6h
  window is honored; `recurrence` throws on an unknown ticket.
- `node --test scripts/lib/rescue-relay-snippets.test.mjs` — the relay snippet
  key is byte-identical to the store key; empty-store→mint; exact-id→exists;
  in-window open sibling→deduped with a `recurred` event and no duplicate;
  terminal/stale sibling→mint; `rescueStampDedupKey` is idempotent.
