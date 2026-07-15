# FIX-RESCUE-13 — the daily cap SUPPRESSES; it does not announce

**Priority:** P0 · **Area:** Rescue Rangers · **Wave:** 2 · **Depends on:** FIX-RESCUE-07, FIX-RESCUE-08

## Problem

The escalation cap branch computed the right decision and then did the wrong
thing with it:

```js
// PRE-FIX (n8n Relay Brain Code node)
{ status: 'cap_exceeded', cap: 25, used: 25, _post: true }   // <-- per TASK
//                                            ^^^^^^^^^^^
// -> "Daily Rescue Rangers cap reached (25/25). Escalating to a human."
//    ticket id: "(cap)"
```

`_post: true` fired **once per task, on every sweep pass**. A sweep re-running
every 10 minutes across a backlog of blocked tasks therefore paged the operator
hundreds of times an hour — every message announcing the cap that was supposed
to be stopping them. **The brake was the amplifier.** A cap that announces
itself per task is not a cap; it is the flood with extra words.

The repo could not have caught this, because the repo did not model the cap
decision **at all**:

- `lib/rescue-ticket-store.mjs` had the cap **counter** (`counters` table,
  `countToday()`, `readView().capUsage`) but **no gate** — `mintOrRecur()` /
  `createTicket()` minted unconditionally, forever, past any number.
- The other two relay decisions (GC → `relay-brain-gc-snippet.js`, dedup →
  `relay-brain-dedup-snippet.js`) are mirrored in-repo and unit-tested. The cap
  was the one relay decision with **no mirror and no test**, so it was free to
  be wrong.

## Fix

The cap decision now exists — and is enforced — in **both** mirrored places,
exactly as FIX-RESCUE-08 did for dedup.

| escalation | decision | posts? |
| --- | --- | --- |
| under the cap | `minted` | **yes** — unchanged, never silenced |
| first one past the cap | `cap_suppressed` + notice latch | **yes** — ONE consolidated notice, per client per day |
| every one after that | `cap_suppressed` | **no** — counted durably, silent |

1. **Durable store** — `TicketStore.capGate()` in `lib/rescue-ticket-store.mjs`,
   called from `mintOrRecur()`. Past the cap it mints nothing and returns
   `{ status:"cap_suppressed", post:false }`. The single-notice latch
   (`cap_suppressions.notified_at`) is stamped inside the same transaction as the
   counter bump, so N concurrent sweeps past the cap yield **exactly one**
   notice — never one per task. Supporting API: `countSuppressedToday()`,
   `capState()`, `capSummaryLine()`, and the exported `DEFAULT_DAILY_CAP = 25`
   (one constant, three consumers).
2. **n8n Relay Brain** — `relay-brain-cap-snippet.js`: `rescueCapGate(store, {...})`
   returns `{ suppress, notice, used, cap, suppressed }`. It **replaces** the old
   `cap_exceeded` branch: `_post` is now `cg.notice`, not `true`. Cross-tested
   against the durable store so both paths emit the identical post/suppress
   sequence during the migration window.

### Suppression is not amnesia

Going quiet past the cap only works if the volume stays **visible**. Every
suppressed escalation is recorded in the durable `cap_suppressions` table
(count, first/last timestamps, last problem) and surfaces in:

- `readView().capSuppressed` → `rescue-report` prints
  `Suppressed by the daily cap today:  <client>: N suppressed (cap 25) …`
- the one consolidated notice itself, which carries the running count.
- GC keeps suppression evidence for **30 days** (the daily counters it shadows
  are pruned after 2), so a flood is reconstructible weeks later.

### Never-silence invariants (all unit-pinned)

- Under the cap **nothing** is suppressed — a genuinely-stuck task always pages.
- A **recurrence still folds onto its open ticket** past the cap: the gate sits
  *after* dedup, so a live ticket a human already holds keeps absorbing updates.
- The cap is **per client**: one client at cap never silences another.
- A cap of `0` / negative / non-finite means **no cap**.
- **FAIL-OPEN**: if the cap machinery throws, `mintOrRecur()` mints and posts. A
  broken counter must never be able to swallow an escalation — a duplicate page
  is trivial next to a stuck task no human ever hears about.
- Nothing is ever deleted: suppression declines to *mint*, it does not remove.

## Wiring

### Durable store (committed)

`store.mintOrRecur({ ticketId, client, failureClass, problem })` now returns a
`post` boolean. Senders read **only** that: `post === true` → send `r.message`
(or the ticket); `post === false` → stay silent, the event is already recorded.
Opt out with `enforceCap: false`, or tune with `capPerDay`.

### n8n Relay Brain (applied on the private n8n instance)

Paste `relay-brain-cap-snippet.js` into the Relay Brain Code node beside the GC
and dedup snippets, then replace the cap branch:

```js
const cg = rescueCapGate(store, { client, dayKey, cap: 25, problem });
if (cg.suppress) {
  return [{ json: {
    status: 'cap_suppressed',
    _post: cg.notice,                                   // <-- was `true`. THE FIX.
    message: cg.notice ? rescueCapSummary(cg) : null,   // one consolidated notice
    suppressedToday: cg.suppressed, used: cg.used, cap: cg.cap,
  } }];
}
// else: existing mint path (rescueStampDedupKey + store.counters[dayKey]++).
```

## Verification

- `node --test scripts/lib/rescue-cap-suppression.test.mjs` — 9 store cases. The
  headline regression drives 30 escalations at cap 25 and asserts **26 posts
  total** (25 tickets + 1 consolidated notice) and **zero** per-task cap
  messages. On the pre-fix store it fails with `expected: 25, actual: 30` — the
  old code minted and posted every single one.
- `node --test scripts/lib/rescue-relay-cap-snippet.test.mjs` — 6 relay cases,
  including a cross-check that the snippet and the durable store produce the
  same post/suppress sequence, and fail-open on a hostile store.
- Both suites run in CI (`rescue-rangers-tests` job, Node 22 — `node:sqlite`).
