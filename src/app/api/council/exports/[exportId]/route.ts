import type { NextRequest } from 'next/server';
import { handleNotReady } from '@/lib/council/api/foundation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/council/exports/:exportId (registered, not wired).
 * Report exports belong to CWE-038; no export store exists in the
 * foundation, so this read answers FEATURE_NOT_READY rather than
 * fabricating an export record (Section 17.6).
 */
export async function GET(request: NextRequest) {
  return handleNotReady(request, 'council.exports.get');
}
