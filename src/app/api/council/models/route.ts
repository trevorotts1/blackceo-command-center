import type { NextRequest } from 'next/server';
import { handleCouncil, modelsCatalogData, respondOk } from '@/lib/council/api/foundation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/council/models (CWE-029 foundation).
 * The CWE-008 explicit route catalog over the host model registry:
 * configured routes with credential presence (never values) and
 * honest readiness labels. A listed route is UNTESTED until probe and
 * evaluation evidence exists; nothing here runs a model. CWE-045:
 * recorded probe evidence in the caller's scope is merged into the
 * catalog, so a route the composed probe has probed reads PROBED.
 */
export async function GET(request: NextRequest) {
  return handleCouncil(request, async (ctx) => respondOk(ctx, modelsCatalogData(ctx)));
}
