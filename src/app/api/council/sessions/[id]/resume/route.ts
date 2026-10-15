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
import { resumeSessionRun } from '@/lib/council/composed-services';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/sessions/:id/resume (CWE-050; CWE-027 controls).
 * Resumes a paused or blocked session through RESUMING back to the
 * exact phase recorded when it paused. Resuming a session that is
 * not paused or blocked is a precise legal-state conflict, never a
 * silent no-op (T055).
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
    const idempotencyKey = requireIdempotencyKey(request, body, 'session resume');
    const authorized = authorizeSessionMutate(ctx, id);
    const result = await resumeSessionRun(ctx, authorized, id, body, idempotencyKey);
    return respondOk(ctx, result.receipt, {
      meta: { access_via: authorized.accessVia, replayed: result.replayed },
    });
  });
}
