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
import { previewActionPlan } from '@/lib/council/approvals';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/sessions/:id/action-plan/preview (CWE-036).
 * Computes the exact action plan from the session's committed,
 * validated verdict revision and writes NOTHING: no task, no plan
 * row, no journal event, no webhook, no notification, no dispatch,
 * no model call (Section 17.6, T090). The returned plan hash is the
 * hash an approval binds and a create materializes.
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
    requireIdempotencyKey(request, body, 'action plan preview');
    const authorized = authorizeSessionMutate(ctx, id);
    const result = await previewActionPlan(ctx, authorized, id, body);
    return respondOk(ctx, result, { meta: { access_via: authorized.accessVia } });
  });
}
