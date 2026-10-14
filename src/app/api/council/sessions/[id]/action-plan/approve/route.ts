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
import { approveActionPlan } from '@/lib/council/approvals';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/sessions/:id/action-plan/approve (CWE-036).
 * Records the action-plan approval through CWE-035's plan service:
 * the decision binds the exact plan hash, the selected actions, the
 * scope, the budgets inside the item hashes, and the approving
 * principal (Section 19.5, T091). Approval creates no tasks and is
 * not an execution credential.
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
    const idempotencyKey = requireIdempotencyKey(request, body, 'action plan approval');
    const authorized = authorizeSessionMutate(ctx, id);
    const result = await approveActionPlan(ctx, authorized, id, body, idempotencyKey);
    return respondOk(ctx, result, {
      meta: { access_via: authorized.accessVia, replayed: result.replayed },
    });
  });
}
