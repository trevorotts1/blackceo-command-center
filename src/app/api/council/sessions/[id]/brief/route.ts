import type { NextRequest } from 'next/server';
import {
  checkBodyScope,
  handleCouncil,
  parseJsonBody,
  requireIdempotencyKey,
  requireMutationProof,
  respondOk,
} from '@/lib/council/api/foundation';
import { parseBriefRevisionInput, reviseDraftBrief } from '@/lib/council/api/drafts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * PATCH /api/council/sessions/:id/brief (CWE-029 foundation).
 * Revises a draft brief through the CWE-006 store under an
 * expected-revision compare-and-swap: a stale expected_revision
 * returns VERSION_MISMATCH and writes nothing. Each committed
 * revision appends a canonical brief_revised journal event. Requires
 * CSRF proof and an idempotency key (Section 17.1). Support access
 * never mutates (CWE-007).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleCouncil(request, async (ctx) => {
    await requireMutationProof(request);
    const body = await parseJsonBody(request);
    checkBodyScope(ctx.principal, body);
    const idempotencyKey = requireIdempotencyKey(request, body, 'brief revision');
    const input = parseBriefRevisionInput(body);
    const result = reviseDraftBrief(ctx, id, input, idempotencyKey);
    return respondOk(ctx, result.session, { meta: { replayed: result.replayed } });
  });
}
