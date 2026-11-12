import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext, TenantAccessError } from '@/lib/auth/tenant-context';
import { countPendingApprovals, createApprovalRequest, listApprovalRequests } from '@/lib/approval-requests';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/approval-requests — the AGENT registers "this needs the owner's
 * yes" (MC_API_TOKEN bearer only; an owner session answers 403). The agent can
 * create and read requests; it has no door that decides one. The owner decides
 * on /approvals/<request_id>, which mints the launch approval record.
 */
export async function POST(request: NextRequest) {
  let ctx;
  try {
    ctx = await resolveTenantContext(request);
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: 'tenant_identity_required' }, { status: 403 });
    throw err;
  }
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const result = createApprovalRequest(ctx, body);
  return NextResponse.json(result.payload, { status: result.status });
}

/**
 * GET /api/approval-requests?status=pending|all — list for this tenant. Both
 * the agent bearer and the verified owner may read. `pending_count` counts
 * unexpired pending requests (the dashboard badge).
 */
export async function GET(request: NextRequest) {
  let ctx;
  try {
    ctx = await resolveTenantContext(request);
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: 'tenant_identity_required' }, { status: 403 });
    throw err;
  }
  const status = request.nextUrl.searchParams.get('status') === 'pending' ? 'pending' : 'all';
  return NextResponse.json({
    requests: listApprovalRequests(ctx.tenantId, status),
    pending_count: countPendingApprovals(ctx.tenantId),
  });
}
