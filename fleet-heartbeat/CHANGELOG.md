# Rescue Rangers (fleet-heartbeat) — CHANGELOG

Skill-scoped changelog for the Rescue Rangers fleet-recovery + ticketing
subsystem (`fleet-heartbeat/`). Versioned independently of the Command Center
app `version` file — this is NOT a repo-wide release. Fleet rollout stays HELD
(repo-only) per the 2026-07-03 ratified decision.

## [rescue-rangers v1.2.0] — 2026-07-14 — the daily cap SUPPRESSES, it does not announce (FIX-RESCUE-13)

Incident-driven. On a live box the escalation channel took hundreds of identical
pages: a backlog of blocked tasks, a sweep re-running every 10 minutes, and an
escalation cap that **announced itself once per task**. The cap branch computed
`{status:'cap_exceeded', cap:25, used:25}` and still set `_post: true`, emitting
"Daily Rescue Rangers cap reached (25/25). Escalating to a human." for every task
past the cap (ticket id literally `(cap)`). **The brake was the amplifier.**

The repo could not have caught it: the cap **counter** was modelled
(`counters`, `countToday()`, `readView().capUsage`) but the cap **decision** was
not — `mintOrRecur()` minted unconditionally, past any number. GC and dedup are
both mirrored in-repo as relay snippets and unit-tested; the cap was the one
relay decision with no mirror and no test, so it was free to be wrong.

- **FIX-RESCUE-13 — cap gate + single-notice latch (`lib/rescue-ticket-store.mjs`
  `capGate`/`capState`/`capSummaryLine`/`countSuppressedToday`,
  `relay-brain-cap-snippet.js`, `FIX-RESCUE-13-cap-suppression.md`).** Under the
  cap: unchanged, every escalation pages. First one past it: **ONE consolidated
  notice per client per day** (`cap_suppressions.notified_at` is stamped in the
  same transaction as the counter bump, so concurrent sweeps cannot produce a
  second). Everything after that: `{status:"cap_suppressed", post:false}` —
  counted, silent, **never** a per-task message. Mirrored in the durable store
  and the n8n Relay Brain snippet, cross-tested to emit the identical
  post/suppress sequence.
- **Suppression is not amnesia.** Every suppressed escalation is recorded
  durably (count, first/last, last problem) and surfaces in
  `readView().capSuppressed` and in `rescue-report` ("Suppressed by the daily cap
  today"). The one notice carries the running count. Suppression evidence is kept
  **30 days** — far longer than the 2-day daily counters it shadows.
- **Never-silence invariants, all unit-pinned:** under the cap nothing is
  suppressed; a recurrence still folds onto its open ticket past the cap (the
  gate sits *after* dedup); the cap is per-client; `cap <= 0` means no cap; and
  the gate **FAILS OPEN** — if the cap machinery throws, the escalation mints and
  pages. Nothing is ever deleted: suppression declines to *mint*, it does not
  remove.
- **CI:** the fleet-heartbeat rescue suites were never wired into CI (which is
  how a cap with no test shipped). New `rescue-rangers-tests` job runs every
  `scripts/lib/*.test.mjs` on Node 22 (`node:sqlite`). 15 new cases (9 store +
  6 relay); the headline regression drives 30 escalations at cap 25 and asserts
  26 posts total and zero per-task cap messages — it fails on the pre-fix store
  with `expected: 25, actual: 30`.

## [rescue-rangers v1.1.0] — 2026-07-05 — Wave-1 ticketing hardening (FIX-RESCUE-06/08/11)

Builds on the Wave-0 durable ticketing redesign (FIX-RESCUE-02/05/07/09/10/12,
landed in Command Center repo v4.62.4). Three independent Wave-1 fixes from the
Skills-Analysis Master Fix-Plan. All new code is client-name-free and secret-free
(client / box / person / failure-class / secrets are always runtime inputs); the
durable ticket DB and the new answer-guard set are git-ignored; the edits to the
client-carrying scripts (`heartbeat.sh`, `remediate.sh`, `rescue-receiver.mjs`,
`rescue-rangers-poller.sh`) and the n8n relay workflow are applied on the private
operator deploy and documented here — never committed to this fleet-wide repo.

- **FIX-RESCUE-06 — heartbeat/remediate outages become durable tickets
  (`lib/rescue-outage-ticket.sh`, `FIX-RESCUE-06-outage-tickets.md`).** Path B
  (heartbeat/remediate finding a box DOWN) never created a ticket — no id, no
  SLA, no audit. A sourced shell library now POSTs one ticket per DOWN row:
  every row → `{action:"escalate", clientName, problem, alreadyTried,
  remediate-outcome}` with a **deterministic ticketId `<client>-<class>-<YYYY-MM-DD>`**
  (UTC); a FIXED outcome immediately POSTs `{action:"answer",
  statusPrefix:"fixed:"}`; an UNFIXED row stays OPEN under its SLA. JSON is built
  by `node` with values passed via the environment (correct escaping, nothing in
  `ps`); the auth header is read from the secret store and never printed. 22
  shell assertions, `bash -n` clean.
- **FIX-RESCUE-08 — semantic dedup before mint (`lib/rescue-ticket-store.mjs`
  `mintOrRecur`/`recurrence`, `relay-brain-dedup-snippet.js`,
  `FIX-RESCUE-08-semantic-dedup.md`).** Dedup matched identical ticketIds only,
  which client agents never persist — so recurring problems minted duplicates and
  burned the 25/day cap. Now `dedup_key = sha256(client+"|"+failure_class)` is
  looked up among still-open tickets within a **6h window**: a hit appends a
  `recurred` event and returns `{status:"deduped", ticketId:<existing>}` **without
  minting an RR number or incrementing the cap**; terminal/out-of-window siblings
  still mint. Mirrored in the durable store and the n8n Relay Brain snippet (the
  live cap authority) so both paths make the same decision. 8 new store cases + 7
  relay-snippet cases.
- **FIX-RESCUE-11 — receiver/relay/poller hardening
  (`lib/rescue-answered-guard.mjs`, `lib/rescue-constant-time-compare.mjs`,
  `relay-auth-constant-time-snippet.js`, `lib/rescue-poll-fetch.sh`,
  `FIX-RESCUE-11-hardening.md`).** (i) The process-local `_answeredTickets` Set
  reset on every crash-loop restart → a durable answer guard checks the store
  status first, with a self-pruned on-disk fallback set, so a ticket is never
  double-answered across restarts. (ii) Plain-equality auth compare → constant-time
  SHA-256 `timingSafeEqual` compare (fails closed with no configured secret),
  mirrored for Node and the n8n Code node. (iii) The n8n "Auth Check (soft)" node
  is renamed "(enforced)" to match its hard-403 behavior. (iv) The poller exited 0
  silently on any hiccup → `rr_poll_fetch` separates the curl exit code from the
  HTTP status and returns distinct OK/TRANSPORT/HTTP classes, so "no tickets" is
  distinguishable from a transport/parse/HTTP error. 3 + 3 + 1 node cases + 13
  shell assertions.

**Tests (this train):** node `--test` — ticket-store 32 (12 baseline + 20
Wave-1), constant-time-compare 3, answered-guard 3, relay-snippets 7; shell —
outage-ticket 22, poll-fetch 13. All green; every added shell file passes
`bash -n`. STRUCTURAL no-client-names / no-secrets scan PASS.
