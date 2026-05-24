import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

// Runtime route — opt out of static prerender (uses request data / DB).
export const dynamic = 'force-dynamic';

interface CompanyRow {
  id: string;
  name: string;
  slug: string;
  industry?: string;
  logo_url?: string;
  config?: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * Pick the "real" company row when several exist.
 *
 * The dashboard ships with a "Command Center" / "default" placeholder that gets
 * inserted on first boot before Skill 23 has written the real client config. On
 * a live install, both rows can coexist for a beat. Returning rowid=1 (the old
 * behavior) surfaces the placeholder forever — so prefer:
 *   1. An exact slug match against $COMPANY_SLUG / $COMPANY_NAME-slug
 *   2. A non-placeholder row (slug not in default/command-center, not acme-*)
 *   3. Whichever row exists last (newest)
 */
function pickCompany(companies: CompanyRow[]): CompanyRow | null {
  if (companies.length === 0) return null;

  const envSlug = (process.env.COMPANY_SLUG || '').trim().toLowerCase();
  if (envSlug) {
    const exact = companies.find((c) => c.slug.toLowerCase() === envSlug);
    if (exact) return exact;
  }

  const envName = (process.env.COMPANY_NAME || '').trim().toLowerCase();
  if (envName) {
    const byName = companies.find((c) => c.name.toLowerCase() === envName);
    if (byName) return byName;
    const slugged = envName.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (slugged) {
      const bySlug = companies.find((c) => c.slug.toLowerCase() === slugged);
      if (bySlug) return bySlug;
    }
  }

  // Skip the well-known placeholder slugs / names.
  const real = companies.find(
    (c) =>
      c.slug.toLowerCase() !== 'default' &&
      c.slug.toLowerCase() !== 'command-center' &&
      !c.slug.toLowerCase().startsWith('acme-') &&
      c.name !== 'Command Center'
  );
  if (real) return real;

  // Last resort: return whatever's there.
  return companies[companies.length - 1];
}

export async function GET() {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        'SELECT id, name, slug, industry, logo_url, config, created_at, updated_at FROM companies ORDER BY rowid ASC'
      )
      .all() as CompanyRow[];

    const company = pickCompany(rows);
    if (company) {
      return NextResponse.json(company);
    }
    return NextResponse.json({ name: process.env.COMPANY_NAME || 'Command Center' });
  } catch {
    return NextResponse.json({ name: process.env.COMPANY_NAME || 'Command Center' });
  }
}
