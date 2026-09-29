/**
 * General Task catch-all workspace lookup for the CEO-chat task route.
 * Lives outside src/app so the route file exports only Next.js route fields
 * (a non-route export there fails `next build` type checking).
 */
import { queryOne, getDb } from '@/lib/db';
import { taskRequestCompany } from '@/lib/task-request-identity';

export interface WorkspaceRow {
  id: string;
  slug: string | null;
  name: string;
}

/**
 * The route's company when one is resolvable (a single-company box, or
 * MC_COMPANY_ID) — best-effort only. `null` means "not resolvable", never a
 * thrown error, so the auto-route fallback still runs on an ambiguous box.
 */
function resolveRouteCompanyId(): string | null {
  try {
    return taskRequestCompany(getDb(), null, process.env.MC_COMPANY_ID) || null;
  } catch {
    return null;
  }
}

/**
 * The General Task catch-all workspace — NEVER the structural 'default' row
 * (seed.ts names it 'General', not a department) and NEVER another company's
 * row when this route's company is resolvable. A real `general-task` /
 * `dept-general-task` slug always outranks a bare name match, which is the
 * last resort for a legacy box that never got the canonical slug.
 */
export function resolveGeneralTaskWorkspace(companyId: string | null = resolveRouteCompanyId()): WorkspaceRow | null {
  const params: unknown[] = [];
  let companyClause = '';
  if (companyId) {
    companyClause = 'AND company_id = ?';
    params.push(companyId);
  }
  return (
    queryOne<WorkspaceRow>(
      `SELECT id, slug, name FROM workspaces
        WHERE archived_at IS NULL
          AND id <> 'default'
          AND lower(slug) <> 'default'
          ${companyClause}
          AND (lower(slug) IN ('general-task', 'dept-general-task', 'general')
               OR lower(name) IN ('general task', 'general'))
        ORDER BY
          CASE WHEN lower(slug) = 'general-task' THEN 0
               WHEN lower(slug) = 'dept-general-task' THEN 1
               ELSE 2 END,
          rowid ASC
        LIMIT 1`,
      params,
    ) ?? null
  );
}
