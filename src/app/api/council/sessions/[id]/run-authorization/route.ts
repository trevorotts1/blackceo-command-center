import type { NextRequest } from 'next/server';
import {
  authorizeSessionRead,
  checkBodyScope,
  handleCouncil,
  respondOk,
} from '@/lib/council/api/foundation';
import { getRunAuthorizationStatus } from '@/lib/council/composed-services';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/council/sessions/:id/run-authorization (CWE-050,
 * composing CWE-049's composition list).
 *
 * The redacted run-grant status view: for each granted or preview
 * record of this session, only summary fields are serialized —
 * status, authority mode, purpose, expiry, parent link, and cost
 * ceiling. Scope-proof internals (route snapshots beyond their
 * policy hash, budget ledgers) and secrets are never returned
 * (CWE-049 composition item 5). An optional ?grant_id= narrows to
 * one record. This read performs no inference and creates nothing
 * (T076).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleCouncil(request, async (ctx) => {
    const url = new URL(request.url);
    const claimed: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams.entries()) claimed[key] = value;
    checkBodyScope(ctx.principal, claimed);
    const authorized = authorizeSessionRead(ctx, id);
    const grantId = url.searchParams.get('grant_id') ?? undefined;
    const result = getRunAuthorizationStatus(ctx, id, grantId ?? undefined);
    return respondOk(ctx, result, { meta: { access_via: authorized.accessVia } });
  });
}
