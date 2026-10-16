/**
 * company-scope.ts — which company id actually owns this box's workspaces.
 *
 * A client box carried THREE company ids for one client — `default`,
 * `wakeuphappysis` and `wake-up-happy-sis` — while `MC_COMPANY_ID` named only
 * one of them. Every reader scoped to the configured id then saw a board that
 * looked empty: `general-task` and 31 of 40 active workspaces sat under a
 * DIFFERENT id, so `mc-route.sh general-task …` resolved to
 * `unrecognized-slug->unrouted` and the catch-all silently died.
 *
 * This is the shared read of that split, so the ingest fallback and /api/health
 * report the same numbers.
 */
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';

/** Active (non-archived) workspace count per company_id. */
export function activeWorkspacesByCompany(db: Database.Database): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT COALESCE(company_id,'') AS company_id, COUNT(*) AS n
         FROM workspaces
        WHERE archived_at IS NULL
        GROUP BY COALESCE(company_id,'')`,
    )
    .all() as { company_id: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.company_id, r.n]));
}

/** The company owning the most active workspaces. Ties break on id, for determinism. */
export function majorityCompanyId(db: Database.Database): string | null {
  const entries = Object.entries(activeWorkspacesByCompany(db)).filter(([id]) => id);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries[0][0];
}

/** The whole split, for /api/health. */
export function companyScope(db: Database.Database, configured: string | undefined) {
  return {
    configured: configured ?? null,
    majority: majorityCompanyId(db),
    activeWorkspacesByCompany: activeWorkspacesByCompany(db),
  };
}

/**
 * Resolve the target workspace id. Tries department_slug, then persona/name,
 * then falls back to the CEO workspace — the CEO agent runs all other
 * departments, so it is the correct catch-all owner for unrouted work. Returns
 * { workspaceId, resolvedBy } so the caller can record how routing happened.
 *
 * BARE-TASK RESILIENCE (v4.44.0 — BARE-INGEST-001):
 * When no slug is supplied and the CEO/master-orchestrator workspace is not yet
 * seeded (fresh install), we used to return workspaceId='default' which is a
 * sentinel string that has NO row in the workspaces table. createTaskCore would
 * then fail the FK constraint and the whole ingest route would 500.
 *
 * The fix: resolve the first real workspace we can find from the DB so we always
 * hand off a real workspace_id (or null, which createTaskCore handles gracefully).
 * We NEVER return the bare 'default' literal unless it actually has a DB row.
 */
type WsRow = {id:string;slug:string;name:string};
const GENERAL_SLUGS = ['general-task','dept-general-task','general'];
const CEO_SLUGS = ['master-orchestrator','ceo','dept-ceo'];

function workspaceRows(companyId: string): WsRow[] {
  return getDb().prepare('SELECT id,slug,name FROM workspaces WHERE company_id=? AND archived_at IS NULL ORDER BY sort_order,id')
    .all(companyId) as WsRow[];
}

/** Does this company own ANY workspace that can absorb unrouted work? */
function hasCatchAll(rows: WsRow[]): boolean {
  return rows.some(w =>
    GENERAL_SLUGS.includes(w.slug.toLowerCase()) ||
    CEO_SLUGS.includes(w.slug.toLowerCase()) ||
    w.name.trim().toLowerCase()==='general task');
}

/**
 * The rows to resolve against, and the marker for how we got them.
 *
 * On a client box MC_COMPANY_ID said `default` while `general-task` and 31 of 40
 * active workspaces sat under `wakeuphappysis`, so every routed task landed
 * `unrecognized-slug->unrouted` and the catch-all silently died. When the
 * configured company owns NO catch-all, resolve against the company that owns
 * the MOST active workspaces instead — and say so, loudly, once per resolution.
 * When the configured company DOES own one, nothing changes.
 */
function scopedRows(companyId: string): {rows:WsRow[];prefix:string} {
  const rows = workspaceRows(companyId);
  if (hasCatchAll(rows)) return {rows,prefix:''};
  const db = getDb();
  const majority = majorityCompanyId(db);
  if (!majority || majority===companyId) return {rows,prefix:''};
  const majorityRows = workspaceRows(majority);
  if (!hasCatchAll(majorityRows)) return {rows,prefix:''};
  console.warn(
    `[INGEST] configured company '${companyId}' owns no catch-all workspace; resolving against ` +
    `'${majority}', which owns the most active workspaces. Active workspaces by company: ` +
    `${JSON.stringify(activeWorkspacesByCompany(db))}`,
  );
  return {rows:majorityRows,prefix:`company-fallback:${majority}:`};
}

export function resolveWorkspaceId(departmentSlug: string | undefined, persona: string | undefined, companyId: string): {workspaceId:string|null;resolvedBy:string} {
  const {rows,prefix} = scopedRows(companyId);
  const tag = (r:{workspaceId:string|null;resolvedBy:string}) => ({...r,resolvedBy:prefix+r.resolvedBy});
  const match = departmentSlug ? rows.filter(w => w.slug.toLowerCase()===departmentSlug.toLowerCase() || w.id.toLowerCase()===departmentSlug.toLowerCase()) : [];
  if (match.length===1) return tag({workspaceId:match[0].id,resolvedBy:`department_slug:${departmentSlug}`});
  if (!departmentSlug && persona) {
    const named=rows.filter(w => w.name.toLowerCase()===persona.toLowerCase());
    if(named.length===1) return tag({workspaceId:named[0].id,resolvedBy:`persona:${persona}`});
  }
  const namedGeneral=rows.filter(w => w.name.trim().toLowerCase()==='general task');
  const general=rows.find(w => GENERAL_SLUGS.includes(w.slug.toLowerCase())) || (namedGeneral.length===1 ? namedGeneral[0] : undefined);
  const ceo=rows.find(w => CEO_SLUGS.includes(w.slug.toLowerCase()));
  if(departmentSlug) return tag({workspaceId:general?.id??ceo?.id??null,resolvedBy:general?'unrecognized-slug->general':ceo?'unrecognized-slug->ceo':'unrecognized-slug->unrouted'});
  return tag({workspaceId:general?.id??ceo?.id??null,resolvedBy:general?'general-task-fallback':ceo?'ceo-fallback':'no-workspace-fallback'});
}
