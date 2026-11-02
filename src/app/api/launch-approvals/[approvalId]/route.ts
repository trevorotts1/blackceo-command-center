import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext, TenantAccessError } from '@/lib/auth/tenant-context';
import { getLaunchApproval } from '@/lib/launch-approvals';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/launch-approvals/<id> — the stored record, scoped to the caller's
 * tenant (another tenant's id answers 404). READ ONLY by design: no PUT, PATCH
 * or DELETE handler exists, so an approval cannot be edited or removed here.
 * Skills 83 / 6 / 44 read this to verify an approval before any effect.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ approvalId: string }> }) {
  let ctx;
  try {
    ctx = await resolveTenantContext(request);
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: 'tenant_identity_required' }, { status: 403 });
    throw err;
  }
  const { approvalId } = await params;
  const result = getLaunchApproval(ctx.tenantId, approvalId);
  return NextResponse.json(result.payload, { status: result.status });
}
