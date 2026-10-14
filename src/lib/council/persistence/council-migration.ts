/**
 * CWE-005 council persistence migration (directive Sections 16 and 34).
 *
 * MIGRATION NUMBER LAW: this branch does NOT allocate a Command Center
 * registry number. The registry in src/lib/db/migrations.ts currently
 * holds 142 unique numeric ids (highest 144, gaps at 22 and 23). The
 * single integrator allocates the next id at integration time and
 * replaces COUNCIL_MIGRATION_ID_PENDING below with that numeric string.
 * Until then the entry registers under a self-describing non-numeric id
 * that the runner's numeric sort places after every numeric migration
 * (its parseInt is NaN, so ordering falls back to string comparison,
 * which sorts this id last). The statements are additive and independent
 * of every existing table, so applying last is always safe.
 *
 * Integrator, at integration time (exact steps, also in the CWE-005
 * build report):
 *   1. On the integrated tree, read the then-highest numeric id in
 *      src/lib/db/migrations.ts (do not reuse the gaps at 22 and 23;
 *      historical ids are never recycled).
 *   2. Set COUNCIL_MIGRATION_ID_PENDING to that id + 1, as a string
 *      (for example '145' if 144 is still the highest).
 *   3. Nothing else changes: the registry entry in migrations.ts reads
 *      this constant, and the runner sorts numerically.
 *   4. If any box ever ran this branch unallocated (its _migrations
 *      ledger would show the pending id), the additive body makes the
 *      renumbered run a harmless no-op re-apply.
 *
 * Rollback: the migration is additive only. Rolling back means running
 * the previous build against the same database; the council_* tables
 * stay in place, unread by the old code, and no data is destroyed. There
 * is deliberately no down migration.
 *
 * Concurrent installs: the runner applies each migration inside one
 * transaction and records it in _migrations in the same transaction, so
 * two installers racing one database serialize on the SQLite write lock
 * (busy_timeout 5000, set by getDb); the loser sees the id already
 * applied and skips it. The body itself is also fully idempotent
 * (IF NOT EXISTS), so even a direct double-apply cannot fail.
 */

import type Database from 'better-sqlite3';
import { COUNCIL_SCHEMA_MIGRATION_NAME, COUNCIL_SCHEMA_SQL } from './council-schema';

/**
 * INTEGRATION-TIME ASSIGNMENT: replace with the numeric id the single
 * integrator allocates at integration (highest existing id + 1). Never
 * allocate a number inside a unit branch.
 */
export const COUNCIL_MIGRATION_ID_PENDING = 'PENDING_INTEGRATION_ALLOCATION_CWE005';

export const COUNCIL_MIGRATION_NAME = COUNCIL_SCHEMA_MIGRATION_NAME;

/**
 * Apply the council schema. Idempotent; run inside the caller's
 * transaction. One exec of the whole script: trigger bodies contain
 * semicolons, so the script is never split naively.
 */
export function applyCouncilSchema(db: Database.Database): void {
  db.exec(COUNCIL_SCHEMA_SQL);
}

/**
 * The registry entry consumed by src/lib/db/migrations.ts. Its shape
 * matches the Migration interface declared there (id, name, up). It is
 * intentionally NOT flagged deferInAdditiveSelfHeal: the body is purely
 * additive DDL, which is exactly what the DATA-01 self-heal path may run.
 */
export const councilMigration = {
  id: COUNCIL_MIGRATION_ID_PENDING,
  name: COUNCIL_MIGRATION_NAME,
  up: (db: Database.Database): void => {
    applyCouncilSchema(db);
  },
};
