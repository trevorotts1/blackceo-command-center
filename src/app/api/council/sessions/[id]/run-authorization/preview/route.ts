import type { NextRequest } from 'next/server';
import {
  authorizeSessionMutate,
  checkBodyScope,
  handleCouncil,
  parseJsonBody,
  requireMutationProof,
  respondOk,
} from '@/lib/council/api/foundation';
import { previewRunAuthorization } from '@/lib/council/composed-services';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/sessions/:id/run-authorization/preview
 * (CWE-050, composing CWE-049's composition list).
 *
 * Binds CWE-049's previewRun: the caller submits the explicit
 * CWE-008 route selection and ceilings (or accepts the scoped
 * settings ceilings); the service derives the brief hash, mode,
 * seats, and pack from the committed session itself and returns a
 * content-bound preview anchor that confers NOTHING (its record is
 * born 'expired'; only approveRun can create an active grant).
 * Previews are inert anchors with a 15-minute lifetime, so this
 * endpoint requires the CSRF mutation proof but no idempotency
 * claim; approval and revocation are the claimed mutations.
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
    const authorized = authorizeSessionMutate(ctx, id);
    const result = previewRunAuthorization(ctx, id, body);
    return respondOk(ctx, result, { status: 201, meta: { access_via: authorized.accessVia } });
  });
}
