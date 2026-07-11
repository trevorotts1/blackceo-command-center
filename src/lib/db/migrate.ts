// Migrations-only entrypoint for `npm run db:push` (audit ISSUE #1).
//
// Opening the database via getDb() applies the base schema (schema.ts) and
// then runs every pending migration (src/lib/db/index.ts -> runMigrations),
// and nothing else. It does NOT insert the master orchestrator and it does
// NOT seed any demo content — that is the job of `npm run db:seed`
// (src/lib/db/seed.ts), which is guarded (never duplicates the master) and
// demo-opt-in (DEMO_SEED=true).
//
// Keeping db:push structural-free is what makes it safe to run on every
// install AND every `--update-only` pass without polluting a client's board.
// Previously db:push === db:seed === seed.ts, so each pass re-injected a
// master + demo rows.
import { getDb, closeDb } from './index';

function migrate() {
  console.log('Applying database migrations (schema + pending migrations only; no seed)...');
  getDb(); // runs schema.exec(...) + runMigrations(...)
  closeDb();
  console.log('Migrations complete.');
}

migrate();
