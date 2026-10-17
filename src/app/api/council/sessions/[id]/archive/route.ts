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
import { archiveSessionRoute } from '@/lib/council/composed-services';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/sessions/:id/archive (CWE-050).
 *
 * Archive is a visibility flag, never a state (state-machine
 * contract): the session leaves default history while its full
 * audit record (spec, brief, cards, verdict, hash-chained journal)
 * stays intact and readable by direct reference. Archiving an
 * already-archived session returns the same receipt.
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
    const idempotencyKey = requireIdempotencyKey(request, body, 'session archive');
    const authorized = authorizeSessionMutate(ctx, id);
    const result = archiveSessionRoute(ctx, authorized, id, body, idempotencyKey);
    return respondOk(ctx, result, {
      meta: { access_via: authorized.accessVia, replayed: result.idempotent_replay },
    });
  });
}
