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
import { createRerun } from '@/lib/council/composed-services';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/sessions/:id/rerun (CWE-050; CWE-037
 * coordination-endpoint remainder).
 *
 * Changed-facts repetition (Sections 17.2, 20): creates a child
 * session whose brief is the parent's current brief with the
 * submitted fields replaced, journals the field-level diff on both
 * sessions, and inherits no approval and no grant. The parent is
 * never rewritten.
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
    const idempotencyKey = requireIdempotencyKey(request, body, 'rerun');
    const authorized = authorizeSessionMutate(ctx, id);
    const result = createRerun(ctx, authorized, id, body, idempotencyKey);
    return respondOk(ctx, result, {
      status: result.idempotent_replay ? 200 : 201,
      meta: { access_via: authorized.accessVia, replayed: result.idempotent_replay },
    });
  });
}
