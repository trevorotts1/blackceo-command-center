import type Database from 'better-sqlite3';
import { getDb } from './db';
import { resolveSeedingCompanyId } from './db/branding-seed';

/**
 * Get the company name dynamically.
 * Priority:
 *   1. COMPANY_NAME env var
 *   2. First company in the database
 *   3. "Command Center" fallback (never a hardcoded client name)
 */
export function getCompanyName(): string {
  if (process.env.COMPANY_NAME) return process.env.COMPANY_NAME;

  try {
    const db = getDb();
    const row = db.prepare('SELECT name FROM companies ORDER BY rowid LIMIT 1').get() as { name: string } | undefined;
    if (row?.name) return row.name;
  } catch {}

  return 'Command Center';
}

export function getCompanySlug(): string {
  return getCompanyName().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Resolve the id of the ACTIVE client company for a single-tenant box.
 *
 * This is the shared source of truth used both when SEEDING departments
 * (attribution) and when FILTERING the Kanban board (/api/workspaces), so the two
 * always agree — the floor invariant depends on it:
 *   1. COMPANY_SLUG env — exact slug match.
 *   2. COMPANY_NAME env — name match, then its slugified form.
 *   3. The TENANT IDENTITY (`identity`, defaulting to MC_COMPANY_ID) —
 *      authoritative and terminal; row order never decides.
 *   4. Only with no identity: the first NON-placeholder company row.
 *
 * Returns null when the box has no identity and only placeholder companies exist
 * (un-branded). Callers treat null as "do not filter" — a deliberate fail-open so
 * an un-branded box shows every workspace rather than a blank board. The board's
 * backstop against a WRONG non-null answer is `assertBoardNotSilentlyEmpty`
 * (src/lib/workspaces/board-query.ts), which refuses to render a board scoped to
 * zero rows while the database holds rows the board would otherwise show.
 *
 * `identity` is exposed for callers that hold a separately verified tenant
 * identity. Leave it unset unless you can also make the SEEDER use the same
 * value: a board that resolves differently from the seeder is the Fable-5
 * attribution-drift root cause, which is why the default is the installed
 * identity both paths share.
 */
export function resolveActiveCompanyId(
  database?: Database.Database,
  identity?: string | null,
): string | null {
  // Delegate to the ONE canonical resolver in branding-seed.ts so the board filter
  // and the department seeder (reseedWorkspacesFromConfig) can never disagree about
  // the active company — the Fable-5 attribution-drift root cause. branding-seed is
  // a leaf module (imports only better-sqlite3 + runtime-config), so this adds no
  // import cycle.
  return identity === undefined
    ? resolveSeedingCompanyId(database ?? getDb())
    : resolveSeedingCompanyId(database ?? getDb(), identity);
}
