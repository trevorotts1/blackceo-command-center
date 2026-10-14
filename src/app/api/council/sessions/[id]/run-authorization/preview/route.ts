import type { NextRequest } from 'next/server';
import { handleNotReady } from '@/lib/council/api/foundation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /api/council/sessions/:id/run-authorization/preview (registered, not wired).
 * Run authorization preview belongs to CWE-049; the foundation performs no operation and
 * answers FEATURE_NOT_READY naming the owning unit (Section 17.6).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleNotReady(request, 'council.sessions.run_authorization.preview', {
    sessionId: id,
    sessionAccess: 'mutate',
  });
}
