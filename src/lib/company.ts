import { getDb } from './db';

/**
 * Get the company name dynamically.
 * Priority: 
 *   1. COMPANY_NAME env var
 *   2. First company in the database
 *   3. "My Company" fallback
 */
export function getCompanyName(): string {
  if (process.env.COMPANY_NAME) return process.env.COMPANY_NAME;
  
  try {
    const db = getDb();
    const row = db.prepare('SELECT name FROM companies ORDER BY rowid LIMIT 1').get() as { name: string } | undefined;
    if (row?.name && row.name !== 'My Company') return row.name;
  } catch {}
  
  return 'My Company';
}

export function getCompanySlug(): string {
  return getCompanyName().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
