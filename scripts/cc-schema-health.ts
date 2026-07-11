#!/usr/bin/env tsx
/**
 * scripts/cc-schema-health.ts
 *
 * Is THIS box's dispatch schema ACTUALLY correct? — answered by inspecting the
 * LIVE mission-control.db schema (PRAGMA table_info + sqlite_master), NEVER the
 * `_migrations` ledger.
 *
 * WHY IT EXISTS (DATA-01 ledger-lie)
 * The migration runner records a migration "applied" by id alone, so a box can
 * show migrations 077/078 applied AND climb to HEAD while the columns those
 * migrations own (dispatch_attempts, last_dispatch_attempt_at,
 * next_dispatch_eligible_at, block_reason + idx_tasks_next_dispatch_eligible)
 * were never created. Such a box reports itself HEALTHY but task dispatch is
 * SILENTLY DEAD ("no such column: t.dispatch_attempts" every board tick). This
 * script is how you tell a TRULY-healed box from a FALSELY-healed one.
 *
 * Run ON the box, from the Command Center app dir:
 *   npx tsx scripts/cc-schema-health.ts
 *   DATABASE_PATH=/path/to/mission-control.db npx tsx scripts/cc-schema-health.ts
 *
 * Exit codes:  0 = HEALTHY  ·  1 = BROKEN (falsely-healed)  ·  2 = no DB found
 *
 * It opens the DB READ-ONLY and never calls getDb(), so it NEVER runs a
 * migration or mutates the box — it only reports the truth.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { DB_PATH } from '../src/lib/db/index';
import { checkDispatchSchemaHealth } from '../src/lib/db/migrations';

const dbPath = process.env.DATABASE_PATH || DB_PATH;

if (!fs.existsSync(dbPath)) {
  console.error(`[cc-schema-health] no database found at ${dbPath} — set DATABASE_PATH to point at mission-control.db`);
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true });
try {
  const h = checkDispatchSchemaHealth(db);
  const head = db
    .prepare("SELECT id FROM _migrations ORDER BY CAST(id AS INTEGER) DESC, id DESC LIMIT 1")
    .get() as { id: string } | undefined;

  console.log(`[cc-schema-health] db:                  ${dbPath}`);
  console.log(`[cc-schema-health] ledger head migration: ${head?.id ?? '(none)'}`);

  if (h.ok) {
    console.log(
      '[cc-schema-health] RESULT: HEALTHY — every dispatch column + index is genuinely present ' +
        '(verified against the LIVE schema, not the ledger).',
    );
    process.exit(0);
  }

  console.error('[cc-schema-health] RESULT: BROKEN (FALSELY-HEALED) — the dispatch schema is incomplete:');
  if (!h.tasksTablePresent) console.error('  the `tasks` table is absent entirely');
  if (h.missingColumns.length) console.error(`  missing tasks columns: ${h.missingColumns.join(', ')}`);
  if (h.missingIndexes.length) console.error(`  missing indexes:       ${h.missingIndexes.join(', ')}`);
  if (h.ledgerClaimsAppliedButAbsent.length)
    console.error(
      `  the _migrations ledger FALSELY claims migration(s) ${h.ledgerClaimsAppliedButAbsent.join(', ')} applied ` +
        '(this is the ledger-lie fingerprint).',
    );
  console.error(
    '  -> task dispatch fails with "no such column: t.dispatch_attempts". Fix: run a build with ' +
      'migration 097 (v5.16.2+) and reboot the box (getDb() runs migrations at boot), then re-run this check.',
  );
  process.exit(1);
} finally {
  db.close();
}
