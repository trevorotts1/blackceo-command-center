import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import type { Company, Workspace } from '@/lib/types';

// GET /api/companies/[slug] - Get company details with workspaces
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;
    const db = getDb();

    const company = db.prepare('SELECT * FROM companies WHERE slug = ?').get(slug) as Company | undefined;

    if (!company) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    }

    const workspaces = db.prepare(
      'SELECT * FROM workspaces WHERE company_id = ? ORDER BY name'
    ).all(company.id) as Workspace[];

    return NextResponse.json({
      ...company,
      workspaces,
      workspace_count: workspaces.length,
    });
  } catch (error) {
    console.error('Failed to fetch company:', error);
    return NextResponse.json({ error: 'Failed to fetch company' }, { status: 500 });
  }
}
