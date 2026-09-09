import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  resolveCampaignsCompany,
  ensureCampaignCompanyColumn,
  assertCampaignOwnedByCompany,
} from '@/lib/social/company-context';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface CampaignRow {
  id: string;
  workspace_id: string | null;
  company_id: string | null;
  [key: string]: unknown;
}

function loadCampaign(id: string): CampaignRow | undefined {
  return getDb().prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as CampaignRow | undefined;
}

/**
 * F36 — detail/update/delete verify the campaign belongs to the caller's
 * company BEFORE touching it. A foreign or absent id answers 404
 * (indistinguishable, no existence oracle), exactly like the publish route's
 * task/sheet checks.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const identity = await resolveCampaignsCompany(req);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.error }, { status: identity.status });
  }
  const params = await props.params;
  ensureCampaignCompanyColumn();
  const campaign = loadCampaign(params.id);
  if (!campaign || !assertCampaignOwnedByCompany(campaign, identity.company.companyId).owned) {
    return NextResponse.json({ error: 'campaign not found' }, { status: 404 });
  }
  return NextResponse.json({ campaign });
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const identity = await resolveCampaignsCompany(req);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.error }, { status: identity.status });
  }
  const params = await props.params;
  ensureCampaignCompanyColumn();
  const db = getDb();
  const campaign = loadCampaign(params.id);
  if (!campaign || !assertCampaignOwnedByCompany(campaign, identity.company.companyId).owned) {
    return NextResponse.json({ error: 'campaign not found' }, { status: 404 });
  }
  const body = await req.json();
  const allowed = ['name', 'description', 'status', 'department_ids', 'start_date', 'target_date'];
  const sets: string[] = [];
  const vals: any[] = [];
  for (const key of allowed) {
    if (key in body) {
      sets.push(`${key} = ?`);
      vals.push(key === 'department_ids' && typeof body[key] !== 'string' ? JSON.stringify(body[key]) : body[key]);
    }
  }
  if (sets.length === 0) {
    return NextResponse.json({ error: 'no fields to update' }, { status: 400 });
  }
  sets.push('updated_at = ?');
  vals.push(new Date().toISOString());
  vals.push(params.id);

  const result = db.prepare(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  if (result.changes === 0) {
    return NextResponse.json({ error: 'campaign not found' }, { status: 404 });
  }
  const campaignAfter = loadCampaign(params.id);
  return NextResponse.json({ campaign: campaignAfter });
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const identity = await resolveCampaignsCompany(req);
  if (!identity.ok) {
    return NextResponse.json({ error: identity.error }, { status: identity.status });
  }
  const params = await props.params;
  ensureCampaignCompanyColumn();
  const campaign = loadCampaign(params.id);
  if (!campaign || !assertCampaignOwnedByCompany(campaign, identity.company.companyId).owned) {
    return NextResponse.json({ error: 'campaign not found' }, { status: 404 });
  }
  const result = getDb().prepare('DELETE FROM campaigns WHERE id = ?').run(params.id);
  if (result.changes === 0) {
    return NextResponse.json({ error: 'campaign not found' }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}