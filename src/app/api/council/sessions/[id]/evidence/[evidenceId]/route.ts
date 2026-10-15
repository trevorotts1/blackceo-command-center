import type { NextRequest } from 'next/server';
import {
  authorizeSessionRead,
  checkBodyScope,
  handleCouncil,
  respondOk,
} from '@/lib/council/api/foundation';
import { getEvidenceRoute } from '@/lib/council/composed-services';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/council/sessions/:id/evidence/:evidenceId (CWE-050,
 * graduating the CWE-029 stub; CWE-025's evidence read surface).
 *
 * Returns the committed evidence-manifest entry of the session's
 * frozen brief under the caller's authorized read envelope: the
 * recorded identifier, kind, origin, locator, and hashes exactly as
 * frozen, with its provenance named. The council_evidence content
 * table has no writer in this host, so no content body is served
 * or invented; an ID outside the manifest answers a typed 404.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; evidenceId: string }> },
) {
  const { id, evidenceId } = await params;
  return handleCouncil(request, async (ctx) => {
    const claimed: Record<string, unknown> = {};
    for (const [key, value] of new URL(request.url).searchParams.entries()) {
      claimed[key] = value;
    }
    checkBodyScope(ctx.principal, claimed);
    const authorized = authorizeSessionRead(ctx, id);
    const result = getEvidenceRoute(ctx, authorized, id, evidenceId);
    return respondOk(ctx, result, { meta: { access_via: authorized.accessVia } });
  });
}
