/**
 * PRES-009 — the ONE presentation read-scope predicate.
 *
 * The ingest front door (src/app/api/tasks/ingest/route.ts) proves a task's
 * company ownership with:
 *   EXISTS (workspaces w WHERE w.id = t.workspace_id AND w.company_id = ?)  —
 *     a durably attributed workspace, OR
 *   EXISTS (task_request_keys k WHERE k.task_id = t.id AND k.company_id = ?) —
 *     a durable creation identity stamped at ingest (migration 132).
 *
 * The presentation READ routes (phases / deliverables / children) predate that
 * predicate and accept `workspace_id IS NULL` as "the box's own data" — which
 * showed a NULL-workspace task to EVERY active company and made NULL look like
 * proof of ownership. SPEC.md PRES-009 step 2: use the ingest
 * workspace-or-task_request_keys ownership predicate for ALL presentation
 * reads; NULL workspace alone is not proof. Own-company NULL-workspace tasks
 * WITH a durable request identity still read fine; foreign/ambiguous
 * NULL-workspace tasks return not found, indistinguishable from a wrong id.
 *
 * Single-tenant unbranded boxes: boardWhereClause keeps workspaces whose
 * company_id IS NULL/''/'default' visible as "the box's own unattributed
 * rows" (a blank board on a not-yet-rehomed box was the old failure mode).
 * When resolveActiveCompanyId() returns null — the unbranded box — the
 * workspace arm matches ONLY that own-unattributed shape, never a real
 * foreign company id. When a brand IS resolved, the workspace arm is the
 * strict ingest predicate (exact company match). The task_request_keys arm
 * is ALWAYS an exact company match — a durable creation identity is exact by
 * construction.
 *
 * This module is pure SQL composition (no db import) so routes keep their own
 * getDb() and tests can compile the predicate for direct execution.
 */

/** The company_id shapes boardWhereClause treats as the box's OWN unattributed rows. */
const OWN_UNATTRIBUTED_SQL = "(w.company_id IS NULL OR w.company_id = '' OR w.company_id = 'default')";

/**
 * Full WHERE fragment for a task-scoped presentation read. Expects the task
 * table aliased as `t` in the caller's query.
 * Usage:
 *   const own = tenantTaskWhere(activeCompanyId);
 *   db.prepare(`SELECT ... FROM tasks t WHERE t.id = ? AND ${own.sql}`)
 *     .get(id, ...own.params)
 */
export function tenantTaskWhere(activeCompanyId: string | null): { sql: string; params: string[] } {
  const keyArm =
    'EXISTS (SELECT 1 FROM task_request_keys k WHERE k.task_id = t.id AND k.company_id = ?)';
  if (activeCompanyId) {
    // Branded box: the exact ingest predicate — attributed workspace for THIS
    // company, or a durable creation identity for it. Never a wildcard.
    return {
      sql:
        `(EXISTS (SELECT 1 FROM workspaces w WHERE w.id = t.workspace_id AND w.company_id = ?) ` +
        `OR ${keyArm})`,
      params: [activeCompanyId, activeCompanyId],
    };
  }
  // Unbranded box (boardWhereClause's posture transposed to task reads): the
  // box's own unattributed workspaces stay readable; a real foreign company
  // id never matches here, and a NULL-workspace task still needs a durable
  // identity (its creation company, if any) — NULL workspace is not proof.
  return {
    sql:
      `(EXISTS (SELECT 1 FROM workspaces w WHERE w.id = t.workspace_id AND ${OWN_UNATTRIBUTED_SQL}) ` +
      `OR ${keyArm})`,
    params: [''],
  };
}