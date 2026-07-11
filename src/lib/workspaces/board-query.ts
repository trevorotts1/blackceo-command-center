/**
 * The ONE board WHERE clause — company scope + soft-archive filter.
 *
 * This lives in lib, not in the route, on purpose. The C6 converge assertion
 * (`chosen == provisioned == displayed`) is only worth anything if `displayed`
 * is what the BOARD ACTUALLY SHOWS. If converge re-implemented the board query,
 * the two could drift and the assertion would cheerfully pass while the real
 * board still rendered a declined department. Both /api/workspaces (the board)
 * and /api/system/converge (the assertion) import from here, so a change to the
 * filter is impossible to make in one place and forget in the other.
 */

import type Database from 'better-sqlite3';
import { TEST_RESIDUE_WORKSPACE_SLUGS } from '@/lib/test-residue';

/**
 * Board default: HIDE soft-archived workspaces (`archived_at IS NOT NULL`),
 * scoped to the active company, with test/fixture residue ALWAYS excluded.
 *
 * Company scope: `'default'` / NULL / '' rows are the box's OWN unattributed
 * workspaces (single-tenant), NOT a foreign company, so they are KEPT — this
 * prevents a blank board on a box whose rows have not been re-homed yet, while
 * still excluding another company's rows. An un-branded box (no active company)
 * does not filter by company at all.
 *
 * C8 residue exclusion (carried in from the inline clause this function replaced
 * in /api/workspaces): regardless of company scoping — even on an un-branded box,
 * and even with `includeArchived` — the EXACT test/fixture-residue slugs
 * (smoke-test-dept, no-script-dept — see ../test-residue.ts) are ALWAYS excluded.
 * A client's board must never show a QC smoke-test workspace just because company
 * attribution hasn't run yet. This term is UNCONDITIONAL on purpose: residue is
 * never legitimately viewable, so it is not an `includeArchived` escape-hatch case.
 *
 * Built as a term list because the company scope is conditional — concatenating
 * a bare `AND …` onto an absent `WHERE` is the trap this shape avoids.
 */
export function boardWhereClause(
  activeCompanyId: string | null,
  opts: { includeArchived?: boolean } = {},
): { sql: string; params: string[] } {
  const terms: string[] = [];
  const params: string[] = [];

  if (activeCompanyId) {
    terms.push(
      `(w.company_id = ? OR w.company_id = 'default' OR w.company_id IS NULL OR w.company_id = '')`,
    );
    params.push(activeCompanyId);
  }
  if (!opts.includeArchived) {
    terms.push('w.archived_at IS NULL');
  }

  // C8 — unconditional: fixture residue is never a board row.
  terms.push(`w.slug NOT IN (${TEST_RESIDUE_WORKSPACE_SLUGS.map(() => '?').join(',')})`);
  params.push(...TEST_RESIDUE_WORKSPACE_SLUGS);

  return { sql: terms.length ? `WHERE ${terms.join(' AND ')}` : '', params };
}

/**
 * The `displayed` set: exactly the workspace ids the board renders, produced by
 * the board's own WHERE clause. This is what the C6 parity assertion compares
 * against — the real read path, not a description of it.
 */
export function listDisplayedWorkspaceIds(
  db: Database.Database,
  activeCompanyId: string | null,
): string[] {
  const scope = boardWhereClause(activeCompanyId);
  const rows = db
    .prepare(
      `SELECT w.id FROM workspaces w ${scope.sql} ORDER BY w.sort_order ASC, w.name ASC`,
    )
    .all(...scope.params) as { id: string }[];
  return rows.map((r) => r.id);
}
