import type { NextRequest } from 'next/server';
import { handleNotReady } from '@/lib/council/api/foundation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/models/probe (registered, not wired).
 * Transport probes belong to CWE-009; the foundation performs no
 * probe side effect and answers FEATURE_NOT_READY (Section 17.6).
 */
export async function POST(request: NextRequest) {
  return handleNotReady(request, 'council.models.probe');
}
