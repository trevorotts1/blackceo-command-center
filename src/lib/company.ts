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
 * always agree — the floor invariant depends on it. It mirrors the pickCompany()
 * heuristic behind /api/company:
 *   1. COMPANY_SLUG env — exact slug match.
 *   2. COMPANY_NAME env — name match, then its slugified form.
 *   3. The first NON-placeholder company row (skip default / command-center /
 *      acme-* / "Command Center" / "Default").
 * Returns null when ONLY placeholder/default companies exist (a box that has not
 * been branded yet). Callers treat null as "do not filter" — a deliberate
 * fail-open so an un-branded box shows every workspace rather than a blank board.
 */
export function resolveActiveCompanyId(database?: Database.Database): string | null {
  // Delegate to the ONE canonical resolver in branding-seed.ts so the board filter
  // and the department seeder (reseedWorkspacesFromConfig) can never disagree about
  // the active company — the Fable-5 attribution-drift root cause. branding-seed is
  // a leaf module (imports only better-sqlite3 + runtime-config), so this adds no
  // import cycle.
  return resolveSeedingCompanyId(database ?? getDb());
}
