import type { NextRequest } from 'next/server';
import {
  authorizeSessionMutate,
  checkBodyScope,
  handleCouncil,
  machineAuthFor,
  parseJsonBody,
  requireIdempotencyKey,
  requireMutationProofFor,
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
 *
 * CWE-045 machine binding: a machine-channel caller is authenticated
 * through the CWE-007 machine binding (host-configured, operation
 * 'approve_plan') instead of the browser CSRF proof, and the binding
 * is threaded into the plan service so each service-level
 * authorization re-checks it; browser callers keep the CSRF proof.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleCouncil(request, async (ctx) => {
    await requireMutationProofFor(request, ctx.principal);
    const auth = machineAuthFor(request, ctx.principal, 'approve_plan', id);
    const body = await parseJsonBody(request);
    checkBodyScope(ctx.principal, body);
    const idempotencyKey = requireIdempotencyKey(request, body, 'action plan approval');
    const authorized = authorizeSessionMutate(ctx, id);
    const result = await approveActionPlan(ctx, authorized, id, body, idempotencyKey, undefined, auth);
    return respondOk(ctx, result, {
      meta: { access_via: authorized.accessVia, replayed: result.replayed },
    });
  });
}
