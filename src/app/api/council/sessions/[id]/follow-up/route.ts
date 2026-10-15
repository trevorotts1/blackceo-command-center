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
import { createFollowUp } from '@/lib/council/composed-services';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/sessions/:id/follow-up (CWE-050; CWE-037
 * coordination-endpoint remainder, serving CWE-034's wired form and
 * CWE-033's journey client shape).
 *
 * Creates a NEW linked one-seat consult session (Section 20): the
 * parent session, its cards, and its verdict are never modified
 * (T104), and no inference runs here — starting the consult takes
 * its own purpose-bound run grant. Answers 202 with the child
 * session reference.
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
    const idempotencyKey = requireIdempotencyKey(request, body, 'follow-up');
    const authorized = authorizeSessionMutate(ctx, id);
    const result = createFollowUp(ctx, authorized, id, body, idempotencyKey);
    return respondOk(ctx, result, {
      status: result.idempotent_replay ? 200 : 202,
      meta: { access_via: authorized.accessVia, replayed: result.idempotent_replay },
    });
  });
}
