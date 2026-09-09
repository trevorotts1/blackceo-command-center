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
