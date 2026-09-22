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
 * A board that resolved to a company owning NONE of the rows it would otherwise
 * render. Carries the split so the log names who actually owns them.
 */
export class BoardScopeError extends Error {
  readonly activeCompanyId: string | null;
  readonly hiddenCount: number;
  readonly activeWorkspacesByCompany: Record<string, number>;

  constructor(
    activeCompanyId: string | null,
    hiddenCount: number,
    activeWorkspacesByCompany: Record<string, number>,
  ) {
    super(
      `Board scoped to company '${activeCompanyId}' renders 0 workspaces while ${hiddenCount} ` +
        `renderable row(s) exist. Owners: ${JSON.stringify(activeWorkspacesByCompany)}. ` +
        'The resolved company does not own this tenant\'s data; refusing to render an empty board.',
    );
    this.name = 'BoardScopeError';
    this.activeCompanyId = activeCompanyId;
    this.hiddenCount = hiddenCount;
    this.activeWorkspacesByCompany = activeWorkspacesByCompany;
  }
}

/**
 * REFUSE A SILENTLY-EMPTY BOARD.
 *
 * Zero rendered rows is a legitimate board on exactly one kind of box: one whose
 * workspaces table has nothing renderable in it. Zero rendered rows while the
 * table DOES hold renderable rows means the company scope threw away the
 * client's own data, and that is never something to draw.
 *
 * Measured on a client box: the company resolver returned the `default` sentinel
 * (a row renamed to slug `wuhs` but still carrying id `default`), the scope kept
 * only `default`/NULL rows, and `/api/workspaces` returned 0 of 40 rows that were
 * present and active in the database. The client was fully logged in and staring
 * at an empty board — the single worst failure mode available here, because it is
 * indistinguishable from "you have no departments" and nothing anywhere went red.
 *
 * The comparison is made with the board's OWN clause minus the company term, so
 * "renderable" means exactly what the caller asked for — same `includeArchived`,
 * same unconditional residue exclusion. A re-implementation of that definition
 * would drift from the board and the guard would start lying in one direction or
 * the other, which is the same trap `listDisplayedWorkspaceIds` exists to avoid.
 *
 * Throws BoardScopeError. Callers surface it (5xx) and log it — never swallow it
 * back into an empty list.
 */
export function assertBoardNotSilentlyEmpty(
  db: Database.Database,
  activeCompanyId: string | null,
  renderedCount: number,
  opts: { includeArchived?: boolean } = {},
): void {
  // Rows rendered, or no company filter applied at all → nothing was scoped out.
  if (renderedCount > 0 || !activeCompanyId) return;

  const unscoped = boardWhereClause(null, opts);
  const owners = db
    .prepare(
      `SELECT COALESCE(w.company_id,'') AS company_id, COUNT(*) AS n
         FROM workspaces w ${unscoped.sql}
        GROUP BY COALESCE(w.company_id,'')`,
    )
    .all(...unscoped.params) as { company_id: string; n: number }[];

  const hidden = owners.reduce((total, row) => total + row.n, 0);
  if (hidden === 0) return; // genuinely nothing to show — an empty board is the truth

  throw new BoardScopeError(
    activeCompanyId,
    hidden,
    Object.fromEntries(owners.map((row) => [row.company_id || '(unattributed)', row.n])),
  );
}

/**
 * The `displayed` set: exactly the workspace ids the board renders, produced by
 * the board's own WHERE clause. This is what the C6 parity assertion compares
 * against — the real read path, not a description of it.
 *
 * Guarded: a `displayed` set that is empty only because the company scope threw
 * the tenant's rows away would otherwise make the converge parity assertion
 * compare two wrong sets and pass.
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
  assertBoardNotSilentlyEmpty(db, activeCompanyId, rows.length);
  return rows.map((r) => r.id);
}
