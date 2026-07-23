# Deployment

This document describes how Command Center code and data propagate onto client boxes, and the structural gap between the two.

---

## Code propagation: `update.sh`

Code changes flow to every client box via `update.sh` (the Sunday Update pipeline). The updater:

1. Backs up the current checkout.
2. Pulls the latest from `origin/main` (git merge, preserving local commits and per-box runtime config).
3. Installs npm dependencies (`npm ci`).
4. Applies database **schema migrations** (on start, `src/instrumentation.ts` calls `getDb()` which triggers `runMigrations` in `src/lib/db/migrations.ts`; `src/lib/db/migrate.ts` is the standalone CLI entrypoint. `update.sh` defers to the on-start path; Step 4 is a no-op).
5. Rebuilds and atomically swaps the `.next` build via `scripts/atomic-deploy.sh` (or falls back to an in-place `next build` + `pm2 reload`).

After `update.sh` completes, the box is running the latest code and all schema migrations have been applied.

---

## Data propagation: the gap

`update.sh` does **not** seed workspace/SOP data. Workspace rows (e.g. podcast, anthology, research) are only written during initial box provisioning by `seed-workspaces.py` in the onboarding repository. The reconcile path (`reconcile_command_center_runtime.py`) reconciles configuration JSON files (departments.json, company-config.json, logo-config.json) and never reads or writes the `workspaces` table. Reconcile is a **no-op** on already-provisioned boxes — it detects existing config files and skips.

This creates a structural gap: **new engine cards require a workspace-seeding migration to appear on existing client boxes.**

### Example: Podcast and Anthology engines

The Podcast and Anthology engine cards are gated on `workspaces` table rows with `slug='podcast'` and `slug='anthology'`. Those rows are:

- **Created** by the onboarding reconcile path during initial provisioning.
- **Never created** on boxes that were provisioned before those engines existed — reconcile is a no-op there.
- **Never created** by `update.sh` — it runs migrations but does not seed workspace data.

The result: clients onboarded before those engines landed never see the cards. `update.sh` runs cleanly; the boxes are running the latest code; the dashboard loads — but the engine cards are absent because the workspace rows are missing.

### The correct propagation path

The fix is a **workspace-seeding migration**: a one-time, idempotent SQL migration (numbered sequentially after the latest existing migration) that inserts the missing workspace rows via `INSERT OR IGNORE`. Schema migrations **do** run on every box during the next `update.sh` cycle (Step 4), so the data travels with the code.

**This is exactly the U017 pattern.** U017 shipped migration id `'113'` (name `seed_podcast_anthology_workspaces`), an object entry in `src/lib/db/migrations.ts` — there is no `.sql` file or `src/lib/db/migrations/` directory. The migration inserts the `podcast` and `anthology` workspace rows with `company_id='default'` so they are visible to all clients on the box. It is idempotent — running it twice produces exactly one row per slug. The runner logs `[Migration 113]` during execution.

### Rule

> **New engine cards require a workspace-seeding migration to appear on existing client boxes.**

When a new engine is added that is gated on a `workspaces` row:

1. Create an idempotent migration (numbered after the latest existing migration) that seeds the workspace row via `INSERT OR IGNORE`. Use `company_id='default'` so the workspace is visible to all clients on the box.
2. The migration propagates automatically on the next `update.sh` run (Step 4 -> app start -> migration runner).
3. Do **not** rely on the onboarding reconcile path — it is a no-op on provisioned boxes.

---

## Why reconcile is a no-op on provisioned boxes

The reconcile script (`reconcile_command_center_runtime.py`) reconciles configuration JSON files (departments.json, company-config.json, logo-config.json — see lines 269-309). It never reads or writes the `workspaces` table. Workspace rows are seeded at initial provisioning by `seed-workspaces.py`, referenced in `src/lib/db/migrations.ts` (lines 142, 457, 469, 471).

This is correct behavior for maintaining existing state — config files are synced once, then left alone so operator customization is preserved. But this means neither reconcile nor `update.sh` can deliver **new** workspace rows to existing boxes. Only migrations can.

---

## See also

- U017 — the podcast/anthology workspace-seeding migration (the canonical example of this pattern).
- `update.sh` — the code-propagation pipeline (Step 4 defers to the TypeScript migration runner).
- `src/lib/db/migrations.ts` — the migration definitions file (applied automatically on start via `instrumentation.ts` -> `getDb()` -> `runMigrations`); `src/lib/db/migrate.ts` is the standalone CLI entrypoint.
- `docs/SOP-LAYERS.md` — the SOP/workspace hierarchy and how workspaces gate engine cards.
