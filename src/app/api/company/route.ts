import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET() {
  try {
    const db = getDb();
    const company = db.prepare('SELECT * FROM companies WHERE id != "default" ORDER BY rowid LIMIT 1').get() as any;
    if (!company) {
      const fallback = db.prepare('SELECT * FROM companies ORDER BY rowid LIMIT 1').get() as any;
      return NextResponse.json(fallback || { name: process.env.COMPANY_NAME || 'My Company' });
    }
    return NextResponse.json(company);
  } catch {
    return NextResponse.json({ name: process.env.COMPANY_NAME || 'My Company' });
  }
}
