import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  resolveCampaignsCompany,
  ensureCampaignCompanyColumn,
} from '@/lib/social/company-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * F36 — every campaigns read/write is company-scoped. The caller's company is
 * resolved from the authenticated context (bearer MC_API_TOKEN / signed tenant
 * session / CF Access JWT); a row is visible when campaigns.company_id matches
 * (F36 rows) or, for legacy rows without the column, through the workspace's
 * company_id. 'default' rows stay owned by the 'default' tenant only (F01-D2
 * posture). Two companies with the same department slug can never see each
 * other's boards because the deterministic campaign key embeds the company.
 */
export async function GET(request: NextRequest) {
  const identity = await resolveCampaignsCompany(request);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.error }, { status: identity.status });
  }
  const companyId = identity.company.companyId;
  ensureCampaignCompanyColumn();
  const db = getDb();
  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get('workspace_id');

  const clauses = [
    `(company_id = ? OR (company_id IS NULL AND workspace_id IN (SELECT id FROM workspaces WHERE company_id = ?)))`,
  ];
  const params: any[] = [companyId, companyId];
  if (workspaceId) {
    clauses.push('workspace_id = ?');
    params.push(workspaceId);
  }
  const query = `SELECT * FROM campaigns WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`;
  const campaigns = db.prepare(query).all(...params);
  return NextResponse.json({ campaigns });
}

export async function POST(request: NextRequest) {
  const identity = await resolveCampaignsCompany(request);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.error }, { status: identity.status });
  }
  const companyId = identity.company.companyId;
  ensureCampaignCompanyColumn();
  const db = getDb();
  const body = await request.json();

  if (!body.name || typeof body.name !== 'string') {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  const now = new Date().toISOString();
  const id = body.id || crypto.randomUUID();

  db.prepare(`
    INSERT INTO campaigns (id, name, description, status, department_ids, start_date, target_date, workspace_id, company_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    body.name,
    body.description || '',
    'planning',
    JSON.stringify(body.department_ids || []),
    body.start_date || null,
    body.target_date || null,
    body.workspace_id || null,
    companyId,
    now,
    now,
  );

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  return NextResponse.json({ campaign }, { status: 201 });
}