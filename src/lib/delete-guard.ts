/**
 * B8 / AUD-46 — HARD DELETE REQUIRES A PRIOR SOFT-ARCHIVE.
 *
 * WHAT THIS IS (and what it is NOT)
 * ---------------------------------
 * This is the PREVENTIVE half of B8. It is not the restore. The restore
 * (recovering the 206-task backup) is a separate, GATED operator decision and
 * this module has nothing to do with it — it neither performs nor enables one.
 *
 * What this does is stop the NEXT accidental purge. The board is currently, and
 * deliberately, clean. That clean state is worth protecting: today a single
 * `DELETE /api/tasks/<id>` (or a script that loops one) irreversibly destroys a
 * row with no archive, no tombstone, and no confirmation. `archived_at` already
 * exists on `tasks` (migration 058) and the board already hides archived rows —
 * so a soft-archive is ALREADY the correct, lossless way to take a card off the
 * board. There is simply nothing forcing anyone to use it. This forces it.
 *
 * THE RULE
 * --------
 *   A hard DELETE of a `tasks` / `workspaces` row is REFUSED unless that row was
 *   soft-archived first (archived_at IS NOT NULL).
 *
 * The archive is the pause button. It makes destruction a deliberate, two-step,
 * separately-auditable act instead of a one-keystroke accident, and it leaves a
 * window in which the row is still fully recoverable.
 *
 * FAIL CLOSED
 * -----------
 * A gate that fails open is not a gate. If the `archived_at` column does not
 * exist on the target table, this guard cannot PROVE a soft-archive preceded the
 * delete — so it REFUSES the delete rather than waving it through. A pre-migration
 * DB gets a hard error, not a silent purge.
 *
 * THE SANCTIONED-BYPASS LEDGER
 * ----------------------------
 * A few internal reapers legitimately hard-delete rows that were never on the
 * board to begin with (true duplicate rows collapsed by the de-dup reaper). Those
 * do NOT get to quietly sidestep the guard — they must pass an explicit,
 * named reason from `SANCTIONED_HARD_DELETE_REASONS`, which is LOGGED. The
 * bypass is therefore auditable and enumerable: `grep sanctionedReason` lists
 * every hard-delete path in the codebase that is allowed to skip the archive.
 * An unnamed, ad-hoc bypass is impossible — the reason is a closed union type.
 *
 * Companion: `src/lib/fixture-guard.ts` (QC-11) blocks the fixture/simulate env
 * bypass in production. That guards forged QC verdicts; this guards forged
 * deletes. Same posture, different blast radius.
 */

import type Database from 'better-sqlite3';

/** Tables whose rows may only be hard-deleted after a soft-archive. */
export const ARCHIVE_GUARDED_TABLES = ['tasks', 'workspaces'] as const;
export type ArchiveGuardedTable = (typeof ARCHIVE_GUARDED_TABLES)[number];

/**
 * The CLOSED set of internal callers permitted to hard-delete without an archive.
 * Adding one is a deliberate, reviewable act — you cannot invent a reason at the
 * call site. Every use is logged.
 */
export const SANCTIONED_HARD_DELETE_REASONS = [
  // task-dedup.ts — collapses duplicate rows onto a survivor. The loser row is a
  // duplicate of a row that REMAINS; no unique work is destroyed.
  'duplicate-row-reaper',
  // Test fixtures tearing down their own seeded rows.
  'test-fixture-teardown',
] as const;
export type SanctionedHardDeleteReason = (typeof SANCTIONED_HARD_DELETE_REASONS)[number];

/** Thrown when a hard DELETE is attempted on a row that was never soft-archived. */
export class HardDeleteWithoutArchiveError extends Error {
  readonly table: ArchiveGuardedTable;
  readonly rowId: string;
  /** Machine-readable code the API routes map to HTTP 409. */
  readonly code = 'hard_delete_requires_soft_archive' as const;

  constructor(table: ArchiveGuardedTable, rowId: string, detail: string) {
    super(
      `[B8] Refusing to hard-delete ${table}/${rowId}: ${detail} ` +
        `Soft-archive it first (stamp archived_at) — the row then disappears from the ` +
        `board but stays fully recoverable. A hard delete is irreversible and is only ` +
        `permitted on an already-archived row.`,
    );
    this.name = 'HardDeleteWithoutArchiveError';
    this.table = table;
    this.rowId = rowId;
  }
}

function hasArchivedAtColumn(db: Database.Database, table: ArchiveGuardedTable): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === 'archived_at');
}

/**
 * THE GATE. Call immediately before any hard DELETE of a `tasks` / `workspaces`
 * row. Throws `HardDeleteWithoutArchiveError` unless the row is soft-archived.
 *
 * Semantics, in order:
 *   1. A sanctioned reason → permitted, and LOGGED. (Closed union — not ad-hoc.)
 *   2. Row does not exist  → permitted (nothing to destroy; the caller's own 404
 *      path handles it, and a no-op delete cannot lose data).
 *   3. `archived_at` column missing → REFUSED (fail closed — cannot prove archive).
 *   4. `archived_at IS NULL`        → REFUSED. This is the whole point.
 *   5. `archived_at IS NOT NULL`    → permitted. The two-step happened.
 */
export function assertArchivedBeforeHardDelete(
  db: Database.Database,
  table: ArchiveGuardedTable,
  rowId: string,
  opts: { sanctionedReason?: SanctionedHardDeleteReason } = {},
): void {
  if (opts.sanctionedReason) {
    if (!SANCTIONED_HARD_DELETE_REASONS.includes(opts.sanctionedReason)) {
      throw new HardDeleteWithoutArchiveError(
        table,
        rowId,
        `unknown sanctioned-delete reason "${opts.sanctionedReason}".`,
      );
    }
    console.warn(
      `[B8] SANCTIONED hard delete ${table}/${rowId} — reason=${opts.sanctionedReason} (no archive required).`,
    );
    return;
  }

  const row = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(rowId);
  if (!row) return; // Nothing to destroy.

  if (!hasArchivedAtColumn(db, table)) {
    throw new HardDeleteWithoutArchiveError(
      table,
      rowId,
      `this database has no ${table}.archived_at column, so a prior soft-archive ` +
        `cannot be proven (fail-closed; run migrations).`,
    );
  }

  const archived = db
    .prepare(`SELECT archived_at FROM ${table} WHERE id = ?`)
    .get(rowId) as { archived_at: string | null } | undefined;

  if (!archived?.archived_at) {
    throw new HardDeleteWithoutArchiveError(
      table,
      rowId,
      `the row is NOT soft-archived (archived_at IS NULL).`,
    );
  }
}

/** True when `rowId` is soft-archived and therefore eligible for a hard delete. */
export function isArchived(
  db: Database.Database,
  table: ArchiveGuardedTable,
  rowId: string,
): boolean {
  if (!hasArchivedAtColumn(db, table)) return false;
  const row = db
    .prepare(`SELECT archived_at FROM ${table} WHERE id = ?`)
    .get(rowId) as { archived_at: string | null } | undefined;
  return !!row?.archived_at;
}

/**
 * Shared HTTP shape for a refused delete. 409 Conflict is the honest status: the
 * request is well-formed and authorized, but the resource is in a state (un-archived)
 * that forbids the operation. The response tells the caller exactly how to proceed.
 */
export function hardDeleteRefusedResponseBody(err: HardDeleteWithoutArchiveError) {
  return {
    error: err.code,
    message: err.message,
    table: err.table,
    id: err.rowId,
    remedy:
      err.table === 'tasks'
        ? 'PATCH /api/tasks/<id> with { "archived_at": "<ISO timestamp>" } to soft-archive, then DELETE.'
        : 'POST /api/workspaces/<id>/archive to soft-archive, then DELETE.',
  };
}
