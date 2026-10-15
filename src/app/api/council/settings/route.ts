import type { NextRequest } from 'next/server';
import {
  checkBodyScope,
  handleCouncil,
  parseJsonBody,
  requireMutationProof,
  respondOk,
} from '@/lib/council/api/foundation';
import { getSettingsRoute, patchSettingsRoute } from '@/lib/council/composed-services';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * /api/council/settings (CWE-050, graduating the CWE-029 stubs).
 *
 * Scoped council settings (Sections 17.2, 15.6): validated
 * nonsecret preferences for the caller's trusted scope (tenant,
 * company, installation), stored per scope without touching global
 * provider config. GET returns the stored record, or the canonical
 * Section 15.6 defaults verbatim with revision 0 when nothing was
 * stored. PATCH replaces the record under a revision
 * compare-and-swap: a stale expected_revision conflicts and writes
 * nothing (T058), and the submitted record must pass the canonical
 * CouncilSettings schema exactly (unknown keys fail).
 */
export async function GET(request: NextRequest) {
  return handleCouncil(request, async (ctx) => {
    const claimed: Record<string, unknown> = {};
    for (const [key, value] of new URL(request.url).searchParams.entries()) {
      claimed[key] = value;
    }
    checkBodyScope(ctx.principal, claimed);
    const result = getSettingsRoute(ctx);
    return respondOk(ctx, result);
  });
}

export async function PATCH(request: NextRequest) {
  return handleCouncil(request, async (ctx) => {
    await requireMutationProof(request);
    const body = await parseJsonBody(request);
    checkBodyScope(ctx.principal, body);
    const result = patchSettingsRoute(ctx, body);
    return respondOk(ctx, result);
  });
}
