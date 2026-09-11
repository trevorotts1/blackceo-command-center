# RR-W4-BOARD-RR019 — EVIDENCE-REPAIR

Unit: RR-W4-BOARD-RR019 (lane owner: this session). SPEC.md RR-019 authoritative P1 CONFIRMED SOURCE.
Bases verified before work via `git ls-remote origin main`:
- FLEET origin/main 3bedab785f1490139e095da2a6b525ba4ff71ef1
- CC origin/main 0309366c31ca248c479d90c91fc894bc5be4af04
Work isolated: /tmp/rr019-fleet, /tmp/rr019-cc, /tmp/rr019-basecheck (detached HEAD at bases; live trees untouched).

## What changed

FLEET (commit 7e00a6fc6e697981df2b76f6a29a26bc8d3280ea, branch rr/w4-board-rr019):
- rescue/service/board-sync.mjs (new, 822 lines): durable incident acceptance
  (acceptRescue: authenticated enrollment-bound target + named owner + persisted
  intent via AFTER INSERT trigger inside the admission transaction); reachable CC
  asynchronous (outage logs rescue_accepted_during_outage, ops wait durable);
  appendDesiredOps transactional with op_id idempotency + stale supersede
  (history retained in rr_board_events); pumpBoardSync bounded backoff/jitter +
  idempotent create + lost-response recovery by op ID; desired/acked revisions +
  next_retry_at persisted; sustained degradation flips rr_board_health and
  notifies operator (cooldown-guarded); restoreBoard reconstructs exactly one
  current card (dedupes twins); backfillMissingIntents resumes after restart;
  permanent faults become owned rr_recovery rows; intent keeps owner/due always.
- rescue/tests/RR-019/board-sync.test.mjs (new, 11 tests: 8 QC + gate + dedupe + degraded).

CC (commit 164cabffa1c1bc0fd6a78de45397e1f46be157cf, branch rr/w4-board-rr019-cc):
- src/lib/db/migrations.ts: additive migration 145 ONLY (new board_sync_ops
  table + tasks.desired_rev/acked_rev/board_sync_state columns, DEFAULT-bearing,
  no rebuild, no row rewrite).
- src/lib/rescue/board-sync-intent.ts (new): idempotent intent record, ack/fail
  with backoff, op-ID replay, stale coalesce, health, one-card restore, owned
  escalation with owner/due kept.
- tests/unit/rr019-board-sync.test.ts (new, 10 tests: schema gate + 8 QC-mirror + refusal case).

## RR-018 overlap statement

RR-018 slices untouched. No file listed in the unit's AVOID set was modified:
- CC: package.json test:unit line, src/app/api/tasks/ingest/route.ts,
  src/lib/rescue/execution-contract.ts (absent on base — never created),
  tests/unit/rr018-*.test.ts (absent on base — never created), vitest.config.ts,
  src/lib/db/migrations.ts EXCEPT the new additive migration 145 block
  (lines ~7111-7144; no existing migration body touched).
- FLEET: rescue/service/board-projector.mjs (absent on base — never created),
  rescue/tests/rr018-board-projection.test.mjs (absent — never created).
- CC neighbours rr018 contract test file: ABSENT on origin/main base (verified
  `ls tests/unit/rr018-*` no matches). Nothing to read-check; nothing edited.
Overlap unavoidable: NONE. No file:line to document beyond migration 145 noted above.

## QC battery — FLEET rescue/tests/RR-019/board-sync.test.mjs (11/11 PASS)

(1) outage-accept: CC outage before intake permits authorized logged rescue,
    projection deferred (rescue_accepted_during_outage + durable pending op).
(1b) gate: unauthenticated target + nameless owner refused; refused work leaves no incident.
(2) restore: zero cards -> exactly one created; second restore verifies, never mints.
(2b) dedupe: twin cards -> one kept, exactly one archived.
(3) lost-create: existing card under op_id adopted, zero re-creates, lost_create_recovered event.
(4) stamp-retry: timeout -> retry_scheduled with persisted next_retry_at =
    boardBackoffSeconds(op,1); early pump does no work; retry acks, attempts=2.
(5) ooo-coalesce: newest status applies, older superseded row retained, history keeps
    op_appended/stale_coalesced/op_acked, acked_rev catches desired_rev.
(6) restart: close + reopen same file; orphan intent backfilled; pending op completes;
    role+SOP refreshed together in one receipt.
(7) perm-owned: schema fault -> dead op + board_sync_permanent recovery owned by
    incident owner; intent owner/due kept; health failed_ops=1.
(8) stale: stale status applies nothing, superseded, owner/due kept, replay never
    inflates desired_rev.
(degraded) sustained failure -> degraded + operator notified once (cooldown holds),
    backoff holds, recovery clears health to ok.

## QC battery — CC tests/unit/rr019-board-sync.test.ts (10/10 PASS)

(0) migration 145 applied: board_sync_ops + tasks columns + _migrations row.
(1)/(1b)/(2)/(3)/(4)/(5)/(6-restart-shaped)/(7)/(8): mirror the FLEET cases
through the CC intake tables (see COMMIT-LOG-STAT + QC-BATTERY.out for names).

## Controls (base FAIL -> fixed PASS)

Base: pristine /tmp/rr019-basecheck at FLEET 3bedab7 (+ CC base files: no
board_sync_ops table, no board-sync-intent module — migration 145 absent).
Each of the 8 QC cases FAILS on base (no acceptRescue / no intent table / no
op-ID lookup / no retry / no coalesce / no backfill / no owned recovery /
no stale handling) and PASSES fixed. Full control transcript in QC-BATTERY.out
(BASE CONTROL lines 1-8 all FAIL with reason; fixed batteries 11/11 + 10/10 PASS).

## Neighbours (exact counts, post-change worktrees)

FLEET: RR-006 ledger-transitions 18/18, RR-004 claim-fencing 17/17,
RR-014 heartbeat-truth 16/16, RR-014 negative-controls 4/4,
RR-021 admission-atomicity 11/11. Fail 0 everywhere.
CC: rr018 contract file absent on base (nothing to re-run; no edit made).

## UNDETERMINED

- Independent QC reproduction from pushed refs (separate lane).
- Live CC deploy behaviour (migrations 001-145 chain proven only on throwaway DBs).
- Real board-adapter wiring (tests drive injected fakes; production CC client unwired).
