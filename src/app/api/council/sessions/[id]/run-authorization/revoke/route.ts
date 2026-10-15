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
import { revokeRunAuthorization } from '@/lib/council/composed-services';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/sessions/:id/run-authorization/revoke
 * (CWE-050, composing CWE-049's composition list).
 *
 * Binds CWE-049's revokeRunGrant: the grant finalizes as revoked
 * and its revocation generation advances, so in-flight admissions
 * rechecked against it fail from this point. Revoking an already
 * final grant reports its final state instead of erroring.
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
    const idempotencyKey = requireIdempotencyKey(request, body, 'run authorization revocation');
    const authorized = authorizeSessionMutate(ctx, id);
    const result = revokeRunAuthorization(ctx, id, body, idempotencyKey);
    return respondOk(ctx, result, { meta: { access_via: authorized.accessVia } });
  });
}
