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
import { recordOutcomeRoute } from '@/lib/council/composed-services';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/sessions/:id/outcomes (CWE-050; CWE-034's wired
 * outcome form, CWE-037's outcome service surface).
 *
 * Records what actually happened, separately from what the council
 * predicted (Section 21, T107): the request must name the exact
 * committed verdict revision and content hash, and the stored
 * review preserves that prediction snapshot beside the observed
 * outcome. A hash or revision mismatch refuses the record.
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
    const idempotencyKey = requireIdempotencyKey(request, body, 'outcome record');
    const authorized = authorizeSessionMutate(ctx, id);
    const result = recordOutcomeRoute(ctx, authorized, id, body, idempotencyKey);
    return respondOk(ctx, result, {
      status: result.idempotent_replay ? 200 : 201,
      meta: { access_via: authorized.accessVia, replayed: result.idempotent_replay },
    });
  });
}
