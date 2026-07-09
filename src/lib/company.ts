import type Database from 'better-sqlite3';
import { getDb } from './db';

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
  let rows: { id: string; name: string; slug: string }[];
  try {
    const db = database ?? getDb();
    rows = db
      .prepare('SELECT id, name, slug FROM companies ORDER BY rowid ASC')
      .all() as { id: string; name: string; slug: string }[];
  } catch {
    return null;
  }
  if (rows.length === 0) return null;

  const envSlug = (process.env.COMPANY_SLUG || '').trim().toLowerCase();
  if (envSlug) {
    const exact = rows.find((c) => (c.slug || '').toLowerCase() === envSlug);
    if (exact) return exact.id;
  }

  const envName = (process.env.COMPANY_NAME || '').trim().toLowerCase();
  if (envName) {
    const byName = rows.find((c) => (c.name || '').toLowerCase() === envName);
    if (byName) return byName.id;
    const slugged = envName.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (slugged) {
      const bySlug = rows.find((c) => (c.slug || '').toLowerCase() === slugged);
      if (bySlug) return bySlug.id;
    }
  }

  const isPlaceholder = (c: { name: string; slug: string }) => {
    const slug = (c.slug || '').toLowerCase();
    return (
      slug === 'default' ||
      slug === 'command-center' ||
      slug.startsWith('acme-') ||
      c.name === 'Command Center' ||
      c.name === 'Default'
    );
  };

  const real = rows.find((c) => !isPlaceholder(c));
  return real ? real.id : null;
}
