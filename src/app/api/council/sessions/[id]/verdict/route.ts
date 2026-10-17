import type { NextRequest } from 'next/server';
import {
  authorizeSessionRead,
  handleCouncil,
  respondOk,
} from '@/lib/council/api/foundation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/council/sessions/:id/verdict (CWE-029 foundation).
 * Returns the committed verdict for the session, or the explicit
 * not-ready verdict state when no verdict has been committed
 * (Section 17.2). A verdict is never fabricated: only the CWE-006
 * store's committed record is served.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleCouncil(request, async (ctx) => {
    const { accessVia, envelope } = authorizeSessionRead(ctx, id);
    const verdict = ctx.repositories.getVerdict(envelope, id);
    if (!verdict) {
      return respondOk(
        ctx,
        { session_id: id, verdict_state: 'not_ready', verdict: null },
        { meta: { access_via: accessVia } },
      );
    }
    return respondOk(
      ctx,
      { session_id: id, verdict_state: 'validated', verdict },
      { meta: { access_via: accessVia } },
    );
  });
}
