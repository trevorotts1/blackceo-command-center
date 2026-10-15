import type { NextRequest } from 'next/server';
import {
  authorizeSessionMutate,
  authorizeSessionRead,
  checkBodyScope,
  handleCouncil,
  parseJsonBody,
  requireIdempotencyKey,
  requireMutationProof,
  respondOk,
} from '@/lib/council/api/foundation';
import { deleteSessionRoute } from '@/lib/council/composed-services';
import { CouncilPersistenceError } from '@/lib/council/store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/council/sessions/:id (CWE-029 foundation).
 * Returns the committed store record for one session: spec, brief,
 * scope, and state. Authorization is the CWE-007 session read rule:
 * cross-scope sessions answer with the typed not-found, private
 * sessions answer only to their owner, and support reads are reported
 * as access_via 'support' for audit. A missing session returns
 * PERSISTENCE_SESSION_NOT_FOUND; nothing is fabricated.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleCouncil(request, async (ctx) => {
    const claimed: Record<string, unknown> = {};
    for (const [key, value] of new URL(request.url).searchParams.entries()) {
      claimed[key] = value;
    }
    checkBodyScope(ctx.principal, claimed);
    const { accessVia, envelope } = authorizeSessionRead(ctx, id);
    const session = ctx.repositories.getSession(envelope, id);
    if (!session) {
      throw new CouncilPersistenceError(
        'PERSISTENCE_SESSION_NOT_FOUND',
        `No council session ${id} exists in this tenant and company scope.`,
      );
    }
    return respondOk(ctx, session, { meta: { access_via: accessVia } });
  });
}

/**
 * DELETE /api/council/sessions/:id (CWE-050).
 * Deletion runs the CWE-006 store's tombstone flow: the body must
 * carry the explicit confirmation (SessionDeleteRequest), the
 * session record is removed, a tombstone blocks late writes, audit
 * reads of the session answer deleted from then on, and protected
 * diagnostic payload files are purged. It is never an unguarded
 * delete and never a state change.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleCouncil(request, async (ctx) => {
    await requireMutationProof(request);
    const body = await parseJsonBody(request);
    checkBodyScope(ctx.principal, body);
    const idempotencyKey = requireIdempotencyKey(request, body, 'session delete');
    const authorized = authorizeSessionMutate(ctx, id);
    const result = deleteSessionRoute(ctx, authorized, id, body, idempotencyKey);
    return respondOk(ctx, result, { meta: { access_via: authorized.accessVia } });
  });
}
