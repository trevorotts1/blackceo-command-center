import type { NextRequest } from 'next/server';
import {
  authorizeSessionMutate,
  checkBodyScope,
  handleCouncil,
  parseJsonBody,
  requireIdempotencyKey,
  requireMutationProof,
  respondOk,
} from '@/lib/council/api/foundation';
import { cancelSessionRun } from '@/lib/council/composed-services';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/sessions/:id/cancel (CWE-050; CWE-027 controls).
 * Cancellation is a fence, not a suggestion: the cancel generation
 * advances by exactly one through CANCEL_REQUESTED -> CANCELLED,
 * the session's durable jobs are cancelled with it, and a late
 * result for the cancelled attempt has no live session to land on
 * (T053). Repeating the cancel returns the same receipt (T055).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleCouncil(request, async (ctx) => {
    await requireMutationProof(request);
    const body = await parseJsonBody(request);
    checkBodyScope(ctx.principal, body);
    const idempotencyKey = requireIdempotencyKey(request, body, 'session cancel');
    const authorized = authorizeSessionMutate(ctx, id);
    const result = await cancelSessionRun(ctx, authorized, id, body, idempotencyKey);
    return respondOk(ctx, result.receipt, {
      meta: { access_via: authorized.accessVia, replayed: result.replayed },
    });
  });
}
