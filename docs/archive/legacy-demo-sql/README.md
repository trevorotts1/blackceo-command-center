# Legacy demo seed SQL — ARCHIVED, DO NOT RUN

These two files are **demo-only artifacts** kept for historical reference. They are
**excluded from every automated code path** (migrations, `db:seed`, `db:reset`,
`update.sh`) and must **NEVER** be executed against a client / production database.

- `seed-departments.sql`
- `seed-departments-fixed.sql`

## Why they are dangerous

Both scripts run a blanket `UPDATE tasks SET workspace_id = department` and then
`INSERT` ~17 fabricated demo tasks (e.g. "Define quarterly vision", "Approve
marketing budget") plus a demo Live Feed event into the `tasks` / `events` tables.
Running them on a real box injects fake tasks that a client would see in Mission
Control.

## The real, supported path

Schema and data migrations are applied automatically and idempotently by the
TypeScript migration runner:

- `src/lib/db/migrate.ts` → `runMigrations()` in `src/lib/db/index.ts`
- Migrations are defined in `src/lib/db/migrations.ts` (see migrations `085`/`086`).
- Migration `086` actively **removes** any legacy demo seed rows once a real
  company row exists.

Structural seed data (when explicitly wanted) comes from `npm run db:seed`
(`src/lib/db/seed.ts`), never from these `.sql` files.

**If you need to change the schema, add a migration in `migrations.ts`. Do not run
anything in this folder.**
