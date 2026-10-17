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
import { pauseSessionRun } from '@/lib/council/composed-services';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/sessions/:id/pause (CWE-050; CWE-027 controls).
 * Pauses at a safe boundary through PAUSE_REQUESTED -> PAUSED,
 * recording the interrupted phase as the resume target. Idempotent
 * on an already-paused session; a stale expected_version conflicts
 * and changes nothing (T055, T058).
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
    const idempotencyKey = requireIdempotencyKey(request, body, 'session pause');
    const authorized = authorizeSessionMutate(ctx, id);
    const result = await pauseSessionRun(ctx, authorized, id, body, idempotencyKey);
    return respondOk(ctx, result.receipt, {
      meta: { access_via: authorized.accessVia, replayed: result.replayed },
    });
  });
}
