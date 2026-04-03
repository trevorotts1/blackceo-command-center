import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET() {
  try {
    const db = getDb();
    const company = db.prepare('SELECT * FROM companies ORDER BY rowid LIMIT 1').get() as any;
    if (company) {
      return NextResponse.json(company);
    }
    return NextResponse.json({ name: process.env.COMPANY_NAME || 'Command Center' });
  } catch (error) {
    console.error('Failed to fetch company:', error);
    return NextResponse.json({ name: process.env.COMPANY_NAME || 'Command Center' });
  }
}
