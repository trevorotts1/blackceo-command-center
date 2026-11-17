import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext, TenantAccessError } from '@/lib/auth/tenant-context';
import { applyOwnerChatAnswer } from '@/lib/owner-question-chat';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/owner-questions/<id|short_code>/chat-answer — the agent relays the
 * client's chat reply (MC_API_TOKEN bearer). Body: { answer, channel:
 * "telegram"|"webchat", source_message_ref: "<channel>:<chat_or_session>:<message_id>" }.
 * Command Center re-reads the client's message from the gateway record and
 * applies the VERIFIED words. 200 { success, applied, question }; 404 unknown;
 * 409 already answered; 422 message not verified.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let ctx;
  try {
    ctx = await resolveTenantContext(request);
  } catch (err) {
    if (err instanceof TenantAccessError) return NextResponse.json({ error: 'tenant_identity_required' }, { status: 403 });
    throw err;
  }
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const { id } = await params;
  const result = await applyOwnerChatAnswer(ctx, id, body);
  return NextResponse.json(result.payload, { status: result.status });
}
