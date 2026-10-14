import { NextResponse, type NextRequest } from 'next/server';
import {
  authorizeSessionRead,
  checkBodyScope,
  handleCouncil,
  respondOk,
  schemaValidation,
} from '@/lib/council/api/foundation';
import {
  CouncilEventDelivery,
  type CouncilEventAccess,
} from '@/lib/council/events/delivery';
import { createCouncilEventStream } from '@/lib/council/events/stream';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/council/sessions/:id/events (CWE-030, replacing the
 * CWE-029 FEATURE_NOT_READY stub).
 *
 * The council realtime surface over the CWE-006 durable journal:
 *
 *   - Default: a JSON catch-up result (Section 18.3). `?after=N`
 *     (or the Last-Event-ID header) is the client's last applied
 *     sequence; the answer is the exact gapless page of committed
 *     events after it, or a folded snapshot when the cursor is
 *     unusable, never a silently partial history. `?snapshot=1`
 *     returns the folded session projection directly.
 *   - `?stream=1` (or Accept: text/event-stream): the live stream.
 *     It opens with the same catch-up, then follows the journal for
 *     this session only.
 *
 * Authorization is the CWE-007 session read rule, enforced by the
 * foundation before any event is read: cross-scope sessions answer
 * with the typed not-found; a private session's events answer in
 * full only to their owner. An authorized non-owner reader (support)
 * receives at most the non-sensitive invalidation signal on this
 * surface, never event content. Council events are never routed
 * through the host's company-keyed SSE fan-out (binding B07).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleCouncil(request, async (ctx) => {
    const url = new URL(request.url);
    const claimed: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams.entries()) {
      claimed[key] = value;
    }
    checkBodyScope(ctx.principal, claimed);
    const { row, accessVia, envelope } = authorizeSessionRead(ctx, id);
    const access: CouncilEventAccess = {
      envelope,
      accessVia,
      session: {
        id: row.id,
        tenant_id: row.tenant_id,
        company_id: row.company_id,
        installation_id: row.installation_id,
        owner_subject: row.owner_subject,
        visibility: row.visibility,
        state: row.state,
        state_version: row.state_version,
      },
    };
    const after = parseCursor(request, url);
    const delivery = new CouncilEventDelivery({
      repositories: ctx.repositories,
      store: ctx.store,
    });

    const accept = request.headers.get('accept') ?? '';
    const wantsStream =
      url.searchParams.get('stream') === '1' ||
      accept.includes('text/event-stream');
    if (wantsStream) {
      const stream = createCouncilEventStream({
        delivery,
        access,
        afterSequence: after,
        signal: request.signal,
      });
      return new NextResponse(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    if (url.searchParams.get('snapshot') === '1') {
      return respondOk(ctx, delivery.snapshot(access), {
        meta: { access_via: accessVia },
      });
    }
    return respondOk(ctx, delivery.catchUp(access, after), {
      meta: { access_via: accessVia },
    });
  });
}

/**
 * The reconnect cursor: `?after=` wins, then the SSE Last-Event-ID
 * header. A cursor that is not a non-negative integer is a malformed
 * request (SCHEMA_VALIDATION), never a silent reset to zero, which
 * would replay private history the client did not ask to re-receive
 * and could mask a bookkeeping bug as a fresh subscription.
 */
function parseCursor(request: NextRequest, url: URL): number {
  const raw = url.searchParams.get('after') ?? request.headers.get('last-event-id');
  if (raw === null) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw schemaValidation(
      'The events cursor (after / Last-Event-ID) must be a non-negative integer sequence.',
    );
  }
  return value;
}
