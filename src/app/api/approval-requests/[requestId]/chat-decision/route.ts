import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext, TenantAccessError } from '@/lib/auth/tenant-context';
import { decideApprovalFromChat } from '@/lib/chat-approvals';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/approval-requests/<id>/chat-decision — the agent relays the owner's
 * chat reply (MC_API_TOKEN bearer). Body: {decision: "approve"|"changes",
 * channel: "telegram"|"webchat", source_message_ref: "<channel>:<chat_or_session>:<message_id>",
 * note?}. Command Center does NOT trust the claim: it re-reads the owner's
 * message from the gateway's own inbound record and mints only if the sender,
 * time window, wording and request binding all verify. Response on success:
 * the request with `status` and `approval_id`. Failure: 403/409 {error, detail}.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ requestId: string }> }) {
  let ctx;
  try {
    ctx = await resolveTenantContext(request);
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: 'tenant_identity_required' }, { status: 403 });
    throw err;
  }
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const { requestId } = await params;
  const result = decideApprovalFromChat(ctx, requestId, body);
  return NextResponse.json(result.payload, { status: result.status });
}
