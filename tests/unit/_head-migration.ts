/**
 * _head-migration.ts — the ONE source of the head migration id for tests.
 *
 * WHY THIS EXISTS
 * ---------------
 * More than one migration suite asserts "a fully-upgraded box lands on the head
 * migration". Before this helper each suite hard-coded that id independently
 * (db-upgrade-migration-ordering.test.ts AND dispatch-ledger-reconcile.test.ts),
 * so a migration bump that updated one and missed the other left a stale, red
 * assertion (P2-02 bumped 098 -> 099 and did exactly that). Deriving the id in
 * ONE place — from the migrations array itself — means the next bump updates
 * every assertion at once and can never leave one behind.
 *
 * WHY IT SCANS THE SOURCE INSTEAD OF IMPORTING migrations.ts
 * ----------------------------------------------------------
 * src/lib/db/migrations.ts pulls the whole DB layer (seeders, dedup, residue
 * scrubbers) in-process on import. The migration suites deliberately NEVER
 * import a project module in-process — they drive the real boot in a subprocess
 * with an explicit DATABASE_PATH so an unset path can't touch the live
 * mission-control.db. Reading the file as text keeps that discipline while still
 * deriving the id straight from the migrations array (single source of truth).
 */
import fs from 'fs';
import path from 'path';

function deriveHeadMigration(): string {
  const migrationsTs = path.resolve(__dirname, '../../src/lib/db/migrations.ts');
  const src = fs.readFileSync(migrationsTs, 'utf8');
  // Match each migration array entry: `id: 'NNN',` immediately followed by `name:`.
  const re = /id:\s*'(\d+)'\s*,\s*\r?\n\s*name:/g;
  const ids: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) ids.push(parseInt(m[1], 10));
  if (ids.length === 0) {
    throw new Error('_head-migration: no `id: \'NNN\', name:` migration entries found in migrations.ts');
  }
  // Zero-pad back to the ledger's 3-digit string form (the _migrations.id shape).
  return String(Math.max(...ids)).padStart(3, '0');
}

/** The migration id every fully-upgraded database must land on. */
export const HEAD_MIGRATION = deriveHeadMigration();
