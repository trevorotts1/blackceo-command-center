# Adding a New Engine to the Command Center (U025)

**Status:** normative — read this before shipping any new engine (a new
capability surface such as Podcast, Anthology, Presentations, …) to the
Command Center.

---

## The rule

> **When you add a new engine to the Command Center, ship a workspace-seeding
> migration alongside the code + card.** Code + card alone is not enough.

An "engine" here is a capability that surfaces as a card / workspace on the
dashboard and is gated on a row in the `workspaces` table (keyed by `slug`).
Podcast (`slug='podcast'`) and Anthology (`slug='anthology'`) are the canonical
examples.

**U017 is the reference implementation of this pattern.** It shipped migration
112 — a one-time, idempotent workspace-seeding migration:

```sql
INSERT OR IGNORE INTO workspaces (slug, name, company_id, ...)
VALUES ('podcast',   'Podcast',   'default', ...),
       ('anthology', 'Anthology', 'default', ...);
```

`company_id='default'` makes the rows visible to every client on the box;
`INSERT OR IGNORE` makes the migration safe to run any number of times
(exactly one row per slug after a re-run). It propagates fleet-wide on the next
update roll, because `update.sh` runs migrations on every box.

## Why the migration is the ONLY propagation path

The interface between the onboarding repo and the Command Center is clean. The
gap is operational, and it comes down to how already-provisioned boxes learn
about new things:

1. **Workspace rows are seeded only at initial onboarding.** The `workspaces`
   table (`src/lib/db/schema.ts`) is created empty of engine rows; the seed
   (`src/lib/db/seed.ts`) inserts only the structural `default` workspace. The
   engine rows (`podcast`, `anthology`, …) are added when a box is first
   onboarded.

2. **`reconcile_command_center_runtime.py` is deliberately a no-op on healthy
   boxes — and that is correct.** Reconcile's job is to heal a *broken* box,
   not to re-provision a *working* one. On a box that is already healthy it
   changes nothing, by design. That means reconcile will never add a brand-new
   engine's workspace rows to a box that was onboarded before that engine
   existed — the box is "healthy," so reconcile leaves it alone.

3. **`update.sh` runs migrations but does not seed workspaces.** The update
   pipeline applies schema migrations on every box; it does not, on its own,
   insert workspace rows.

Put those three together and the consequence is exact: a client onboarded
**before** an engine existed never gets that engine's `workspaces` rows from
reconcile (no-op on healthy) or from the update pipeline (migrations only) — so
**the engine's card never renders for them**, even though the code and card
shipped. The workspace-seeding migration is the one mechanism that reaches
already-provisioned boxes, because it rides the migration step that every box
runs on every update.

So: **code + card + migration**, or the engine is invisible to the existing
fleet. New boxes (onboarded after the engine exists) get the rows at onboarding;
the migration is what backfills the boxes that were already there.

## Checklist for a new engine

- [ ] The engine's code and card are implemented.
- [ ] A sequentially-numbered, idempotent migration seeds the engine's
      `workspaces` row(s) via `INSERT OR IGNORE` with `company_id='default'`
      (numbered after the latest existing migration).
- [ ] Running the migration twice creates no duplicate rows (one row per slug).
- [ ] The migration is referenced by the update pipeline (it runs on the next
      roll — no extra wiring needed beyond adding it to the migrations set).

## Optional future direction: an engine manifest

The per-engine migration works, but it spreads the "which engines exist" fact
across one migration per engine. An alternative is an **engine manifest** — a
single declarative list of engine slugs/names that `reconcile` (or the update
pipeline) merges **additively** into `workspaces`:

- Reconcile stays a no-op for *healing* (its current, correct behavior), but
  gains one narrow additive job: for each manifest entry missing from
  `workspaces`, `INSERT OR IGNORE` it. Additive-only means it can never remove
  or alter an existing row, so it cannot disturb a healthy box's state — it only
  fills gaps.
- Adding a new engine then becomes "add one line to the manifest" instead of
  "write a new migration," and the same manifest documents the engine set in one
  place.

This is a proposal, not a requirement. Until it exists, the workspace-seeding
migration (the U017 pattern) is the sanctioned way to make a new engine reach
already-provisioned boxes.
