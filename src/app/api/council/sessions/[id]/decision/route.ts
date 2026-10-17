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
import { recordDecision } from '@/lib/council/composed-services';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/sessions/:id/decision (CWE-050; CWE-037
 * remainder).
 *
 * Records the CLIENT's decision (accept / reject / defer) about the
 * committed verdict, bound to the exact verdict revision and stored
 * independently of the verdict itself: the council's label and the
 * client's decision are different facts (Section 12). A request
 * naming a superseded revision conflicts and records nothing.
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
    const idempotencyKey = requireIdempotencyKey(request, body, 'client decision');
    const authorized = authorizeSessionMutate(ctx, id);
    const result = recordDecision(ctx, authorized, id, body, idempotencyKey);
    return respondOk(ctx, result, { meta: { access_via: authorized.accessVia } });
  });
}
