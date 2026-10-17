/**
 * CWE-005 council persistence migration (directive Sections 16 and 34).
 *
 * MIGRATION NUMBER LAW: the unit branch did NOT allocate a Command Center
 * registry number; the entry registered under a self-describing
 * non-numeric id that the runner's numeric sort places after every
 * numeric migration (its parseInt is NaN, so ordering falls back to
 * string comparison, which sorts this id last). The statements are
 * additive and independent of every existing table, so applying last is
 * always safe.
 *
 * ALLOCATED AT INTEGRATION (Skill 77 batch train, 2026-10-16): the
 * single integrator read the then-highest numeric id in
 * src/lib/db/migrations.ts on the composed tree (171; the historical
 * gaps at 22 and 23 were not recycled) and set
 * COUNCIL_MIGRATION_ID_PENDING below to '172', per the steps this header
 * prescribed. The registry entry in migrations.ts reads this constant,
 * and the runner sorts numerically, so the council migration now applies
 * in numeric position after 171. If any box ever ran this branch
 * unallocated (its _migrations ledger would show the pending id), the
 * additive body makes the renumbered run a harmless no-op re-apply.
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
 * The council migration's registry id. Authored as the non-numeric
 * placeholder 'PENDING_INTEGRATION_ALLOCATION_CWE005' (never allocate a
 * number inside a unit branch); the single integrator allocated '172'
 * at integration (highest existing id 171 + 1). The constant keeps its
 * name: tests and the registry entry import it by name.
 */
export const COUNCIL_MIGRATION_ID_PENDING = '172';

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
