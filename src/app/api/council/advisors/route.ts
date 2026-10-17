import type { NextRequest } from 'next/server';
import { advisorsData, handleCouncil, respondOk } from '@/lib/council/api/foundation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/council/advisors (CWE-029 foundation).
 * The canonical CWE-003 seat roster, labeled as contract data. Source
 * packs themselves are produced by CWE-011 to CWE-019; this read
 * serves the roster contract, never generated advisor content.
 */
export async function GET(request: NextRequest) {
  return handleCouncil(request, async (ctx) => respondOk(ctx, advisorsData()));
}
