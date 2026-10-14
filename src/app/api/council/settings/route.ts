import type { NextRequest } from 'next/server';
import { handleNotReady } from '@/lib/council/api/foundation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * /api/council/settings (registered, not wired).
 * Settings coordination belongs to CWE-050; the foundation stores no
 * council settings and answers FEATURE_NOT_READY for both the read
 * and the update rather than fabricating a settings record
 * (Section 17.6).
 */
export async function GET(request: NextRequest) {
  return handleNotReady(request, 'council.settings.get');
}

export async function PATCH(request: NextRequest) {
  return handleNotReady(request, 'council.settings.patch');
}
