import type { NextRequest } from 'next/server';
import {
  handleCouncil,
  parseJsonBody,
  requireIdempotencyKey,
  requireMutationProofFor,
  respondOk,
} from '@/lib/council/api/foundation';
import { probeModelRoute } from '@/lib/council/model-probe';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/models/probe (CWE-009 transport probes, composed
 * by CWE-045). Runs ONE minimal capability probe against the named
 * catalog route under a purpose-bound capability_probe grant
 * (Section 25.6): the grant must pin the exact route, the operation
 * is admitted and settled through CWE-049's service, and the typed
 * RouteEvidence result is recorded as route evidence the models
 * catalog merges. Credential values are resolved server-side only
 * and never appear in the request or the response.
 */
export async function POST(request: NextRequest) {
  return handleCouncil(request, async (ctx) => {
    await requireMutationProofFor(request, ctx.principal);
    const body = await parseJsonBody(request);
    const idempotencyKey = requireIdempotencyKey(request, body, 'model route probe');
    const result = await probeModelRoute(ctx, body, idempotencyKey);
    return respondOk(ctx, result, { meta: { replayed: result.replayed } });
  });
}
