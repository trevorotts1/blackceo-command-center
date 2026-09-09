# Social orchestration acceptance and integration boundary

The September 9 repair makes the existing CC scheduling primitive use durable SQLite step ownership. Claims execute under BEGIN IMMEDIATE; slot/budget reservation and both lease writes succeed together. Heartbeat, failure and settlement verify current durable owner, fencing token and expiry before updating. Completed steps and retry counts survive coordinator reconstruction. Operation identity hashes company, full cycle, step and attempt. A missing/broken durable table prevents execution; it is not permission to proceed without fencing.

Deterministic node:test fixtures can inject a distant fake clock to exercise the legacy memory model. Production does not use that fallback. All workers sharing a provider account must coordinate through the same database and an agreed company/provider policy. The 50-execution product ceiling and configured lower provider limits still apply. Estimated cost is reserved and settled; this module does not measure real provider billing.

Run the focused acceptance suites:

```sh
node --import tsx --import ./tests/setup/no-owner-telegram.ts --test tests/unit/social-f33*.test.ts
node node_modules/playwright/cli.js test --config=playwright.social-theme.config.ts
```

The durable suite includes two actual child processes racing one operation, heartbeat renewal, expired/stale owners, restart deduplication, dependencies, retry limits, shared slots/budget, identity separation and transactional rollback when storage fails. The browser fixture runs only on loopback with a disposable database/HOME, no credentials inherited by the server and no cron/gateway/messages. A failed invitation fails acceptance. It proves mini-app autosave, private company/week scope, another-device resume and submit receipt; it does not prove worker execution or publication.

## Required production adapter remains separate

At released CC commit 2965b6337 there is no caller of createSocialOrchestrator or new SocialOrchestrator in src outside the defining module. No other source consumer uses social_steps. At released ONB d4152f003, non-test source references to social_execution_policy are confined to its own module. These findings are source-search results, not proof of dynamically installed external agents. They mean the scheduling module's unit tests alone cannot establish that a real client's approved Ultra plan starts concurrent work.

A complete production adapter must bind the persisted client-approved plan and company/cycle identity to a registered dispatcher, select its approved provider/model, actually launch ready work under shared reservations, renew leases while work progresses, propagate cancellation and use independently validated QC results before publication. Persist provider job IDs, stable logical operation idempotency and readback results. The per-attempt scheduling operation key is not by itself an external-post idempotency guarantee. Reconcile uncertain provider outcomes before retrying; fencing a local lease does not cancel an already accepted external request. Report actual worker starts and durable stage transitions to the board.

Provider penalty/circuit history in this primitive remains coordinator-local. The production adapter must enforce account-wide rate limits/circuit state across coordinators and demonstrate delayed real or sandbox calls overlapping within quotas. Acceptance must include killed workers, two companies/cycles, restart, 429/timeouts, budget exhaustion, independent QC, healthy-account continuation and final publication readback. No completion receipt may substitute passing primitive tests for that integration evidence.

## Canonical agent dispatch and publication proof

The ordinary queue consumer is wired: `src/lib/jobs/scheduler.ts` registers the social publish sweep every two minutes. `social-publish-dispatcher.ts` creates the canonical company-bound social task and calls the existing `autoDispatchTask` OpenClaw gateway path, with the normal model/SOP/assignment guards. ONB `run-publishing-cycle.sh` stages the five-phase manifest for the master agent, then accepts explicit worker acknowledgement and phase-completion evidence. Agent-mediated execution is the intended seam; these files do not establish a missing queue daemon.

The F33 primitive is not automatically used by that dispatch path. Actual agent execution and quota enforcement still require integration acceptance. Do not manufacture a new paid dispatch merely to turn that gate green.

A canonical task reaching `done` does not prove that any social post exists. The September 9 consumer repair records `verification_required`, clears the publication completion timestamp and exposes an explicit system action to verify each requested account's provider receipts. Other queue entries keep their own lifecycle. Generic legacy `done` also renders as verification required. Provider-confirmed `scheduled` and `published` states retain their distinct meanings; future scheduling must never count as publication.

ONB already defines `publish-receipts.json` and a verification command carrying post IDs, URLs and readback. A verified adapter must bind those receipts to the same company/cycle/account and remote provider result before promoting the queue. Current CC source has only a reader for `social_deliveries`, not a migration/writer; the original F30 test creates that table itself. Therefore this patch prevents false claims but does not pretend to have implemented or accepted the external receipt transport. A verification-required state stays open until genuine proof is available. This remaining integration evidence must be recorded honestly in the program ledger.
