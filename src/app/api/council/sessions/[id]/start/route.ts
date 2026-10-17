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
import { startSessionRun } from '@/lib/council/composed-services';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/sessions/:id/start (CWE-050, graduating the
 * CWE-029 stub; run controls composed from CWE-027).
 *
 * Validates and enqueues: the session's active CWE-049 run grant
 * must resolve (an explicit grant_id, or the session's single active
 * granted grant), the session moves DRAFT -> READY -> QUEUED through
 * the canonical transition table, and a durable council_run job is
 * enqueued carrying the grant reference and its route-policy pin.
 * Answers 202 with the session/attempt identity (Section 17.2). No
 * provider work happens in the request; without an active grant the
 * typed RUN_AUTHORIZATION_REQUIRED refusal answers and nothing is
 * enqueued (the four authorizations stay separate, B16).
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
    const idempotencyKey = requireIdempotencyKey(request, body, 'session start');
    const authorized = authorizeSessionMutate(ctx, id);
    const result = await startSessionRun(ctx, authorized, id, body, idempotencyKey);
    return respondOk(ctx, result.receipt, {
      status: result.httpStatus,
      meta: { access_via: authorized.accessVia, replayed: result.replayed },
    });
  });
}
