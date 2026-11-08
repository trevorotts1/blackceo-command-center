import { NextResponse, type NextRequest } from 'next/server';
import {
  authorizeSessionRead,
  checkBodyScope,
  handleCouncil,
} from '@/lib/council/api/foundation';
import { assertNoConfiguredSecretsInPayload } from '@/lib/council/auth';
import { CouncilPersistenceError } from '@/lib/council/store';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/council/chamber-sessions/:id (CTR-191 canonical chamber adapter).
 *
 * The canonical chamber bundle reads one session as
 * `GET /council/<id>` with `Accept: application/json`, and expects
 * `{ session }` where the record carries `spec`, `brief`, `state`, the
 * accepted `cards`, and the committed `verdict`. `next.config.mjs`
 * rewrites exactly that JSON read here.
 *
 * This is a READ of this app's own store under the existing CWE-007
 * session read rule. It adds no scope, no bypass and no second source
 * of truth: `authorizeSessionRead` decides, the same repositories the
 * React journey uses serve the bytes, and a cross-scope or private
 * session answers with the same typed not-found as
 * `/api/council/sessions/:id`. Nothing is created, started or written.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  return handleCouncil(request, async (ctx) => {
    const claimed: Record<string, unknown> = {};
    for (const [key, value] of new URL(request.url).searchParams.entries()) {
      claimed[key] = value;
    }
    checkBodyScope(ctx.principal, claimed);
    const { envelope } = authorizeSessionRead(ctx, sessionId);
    const stored = ctx.repositories.getSession(envelope, sessionId);
    if (!stored) {
      throw new CouncilPersistenceError(
        'PERSISTENCE_SESSION_NOT_FOUND',
        `No council session ${sessionId} exists in this tenant and company scope.`,
      );
    }
    // The canonical renderer reads `body.session` at the TOP level
    // (chamber-live.js readSession). This adapter is the one CC-specific
    // response on the read path, so it answers in that canonical shape
    // instead of the CC `{ok,data}` envelope. Authorization, scope and the
    // stored record are exactly the ones the React journey uses.
    const payload = {
      session: {
        session_id: stored.spec.session_id,
        spec: stored.spec,
        brief: stored.brief,
        state: stored.state,
        cards: ctx.repositories.listCards(envelope, sessionId),
        verdict: ctx.repositories.getVerdict(envelope, sessionId),
      },
    };
    assertNoConfiguredSecretsInPayload(payload);
    return NextResponse.json(payload, {
      headers: { 'cache-control': 'private, no-store' },
    });
  });
}
