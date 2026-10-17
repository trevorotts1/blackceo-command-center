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
import { approveRunAuthorization } from '@/lib/council/composed-services';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/sessions/:id/run-authorization/approve
 * (CWE-050, composing CWE-049's composition list).
 *
 * Binds CWE-049's approveRun: the one transition from a content-
 * bound preview to an ACTIVE run grant, under the caller's explicit
 * authority mode, with staleness checks on brief, mode, seats, pack,
 * and route fingerprint, and tighten-only ceiling changes. This
 * grant authorizes provider work for one session's run; it is not a
 * plan approval and not an execution authorization (B16).
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
    const idempotencyKey = requireIdempotencyKey(request, body, 'run authorization approval');
    const authorized = authorizeSessionMutate(ctx, id);
    const result = approveRunAuthorization(ctx, id, body, idempotencyKey);
    return respondOk(ctx, result, { status: 201, meta: { access_via: authorized.accessVia } });
  });
}
