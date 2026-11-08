import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext, TenantAccessError } from '@/lib/auth/tenant-context';
import { mintLaunchApproval } from '@/lib/launch-approvals';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/launch-approvals — mint ONE approval record from the client's own
 * reply (`APPROVE <first 8 chars of the plan hash>`). The caller must be the
 * tenant's registered client identity (verified session / Access JWT); the
 * agent/operator bearer is refused 403. This is the only write door: there is
 * no list, PUT, PATCH or DELETE here (Next answers those 405).
 */
export async function POST(request: NextRequest) {
  let ctx;
  try {
    ctx = await resolveTenantContext(request);
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: 'client_identity_required' }, { status: 403 });
    throw err;
  }
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const result = mintLaunchApproval(ctx, body);
  return NextResponse.json(result.payload, { status: result.status });
}
