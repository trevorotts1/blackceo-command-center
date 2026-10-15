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
import { CouncilScanQueue } from '@/lib/council/kanban/scan-queue';

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
    // CWE-045 proposal surfacing (CWE-037 remainder): the session's
    // follow-up scan state rides this read: pending scan items the
    // completion scan enqueued and the proposal records processing
    // created. Proposals are records for review only; surfacing them
    // creates nothing and neither list can contain a task.
    const scanQueue = new CouncilScanQueue({
      repositories: ctx.repositories,
      db: ctx.store.handle(),
    });
    const followUps = {
      pending_scan_items: await scanQueue.listPendingScanItems(ctx.principal, id),
      proposals: await scanQueue.listScanProposals(ctx.principal, id),
    };
    // CWE-045: the follow-ups ride response metadata so the session
    // resource itself stays byte-equal to the committed record (the
    // route's round-trip law).
    return respondOk(ctx, session, { meta: { access_via: accessVia, follow_ups: followUps } });
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
