import type { NextRequest } from 'next/server';
import { handleNotReady } from '@/lib/council/api/foundation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/council/sessions/:id/run-authorization (registered, not
 * wired). Run grants belong to CWE-049; no grant store exists in the
 * foundation, so this read answers FEATURE_NOT_READY rather than
 * fabricating a grant (Section 17.6).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleNotReady(request, 'council.sessions.run_authorization.get', {
    sessionId: id,
    sessionAccess: 'read',
  });
}
