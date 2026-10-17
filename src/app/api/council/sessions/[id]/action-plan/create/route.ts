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
import { createActionPlan } from '@/lib/council/approvals';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/sessions/:id/action-plan/create (CWE-036).
 * Materializes a committed, fully approved plan through the Section
 * 17.6 assembly: tasks are created through the canonical core under
 * the council_plan_assembling barrier, dependency edges are resolved
 * to real task IDs, and each task is released only when a standing
 * execution grant and its own dependencies and prerequisites permit
 * (Sections 17.6, 19.6, 19.7; T092-T095, T159). Creation requires the
 * committed approval for the same plan hash named in the request.
 *
 * CWE-045 machine binding: a machine-channel caller is authenticated
 * through the CWE-007 machine binding (host-configured, operation
 * 'execute') instead of the browser CSRF proof, and the binding is
 * threaded into the plan service, the assembly, and the execution
 * guard; browser callers keep the CSRF proof.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleCouncil(request, async (ctx) => {
    await requireMutationProofFor(request, ctx.principal);
    const auth = machineAuthFor(request, ctx.principal, 'execute', id);
    const body = await parseJsonBody(request);
    checkBodyScope(ctx.principal, body);
    const idempotencyKey = requireIdempotencyKey(request, body, 'action plan creation');
    const authorized = authorizeSessionMutate(ctx, id);
    const result = await createActionPlan(ctx, authorized, id, body, idempotencyKey, undefined, auth);
    return respondOk(ctx, result, {
      meta: { access_via: authorized.accessVia, replayed: result.replayed },
    });
  });
}
