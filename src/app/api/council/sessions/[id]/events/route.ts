import type { NextRequest } from 'next/server';
import { handleNotReady } from '@/lib/council/api/foundation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/council/sessions/:id/events (registered, not wired).
 * The event surface belongs to CWE-030 over the CWE-006 durable
 * journal; the foundation serves no event stream and answers
 * FEATURE_NOT_READY naming the owning unit (Section 17.6).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return handleNotReady(request, 'council.sessions.events.get', {
    sessionId: id,
    sessionAccess: 'read',
  });
}
