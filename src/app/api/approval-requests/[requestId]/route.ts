import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext, TenantAccessError } from '@/lib/auth/tenant-context';
import { getApprovalRequest } from '@/lib/approval-requests';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/approval-requests/<id> — status of one request, tenant-scoped
 * (another tenant's id answers 404). The agent polls this: once `status` is
 * `approved`, `approval_id` is the value for CAF_APPROVAL_ID; on
 * `changes_requested`, `decision_note` is the owner's note. READ ONLY: there is
 * no PUT, PATCH, DELETE or POST here, so the agent cannot decide a request.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ requestId: string }> }) {
  let ctx;
  try {
    ctx = await resolveTenantContext(request);
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: 'tenant_identity_required' }, { status: 403 });
    throw err;
  }
  const { requestId } = await params;
  const result = getApprovalRequest(ctx.tenantId, requestId);
  return NextResponse.json(result.payload, { status: result.status });
}
