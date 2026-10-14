import type { NextRequest } from 'next/server';
import { capabilitiesData, handleCouncil, respondOk } from '@/lib/council/api/foundation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/council/capabilities (CWE-029 foundation).
 * Registry and route-catalog metadata for the caller's installation.
 * Metadata only: no tenant-private data, no model execution.
 */
export async function GET(request: NextRequest) {
  return handleCouncil(request, async (ctx) => respondOk(ctx, capabilitiesData(ctx)));
}
