import type { NextRequest } from 'next/server';
import { handleNotReady } from '@/lib/council/api/foundation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/exports (registered, not wired).
 * Report exports belong to CWE-038; the foundation creates no export
 * and answers FEATURE_NOT_READY naming the owning unit (Section 17.6).
 */
export async function POST(request: NextRequest) {
  return handleNotReady(request, 'council.exports.create');
}
