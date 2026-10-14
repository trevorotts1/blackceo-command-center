import type { NextRequest } from 'next/server';
import { handleNotReady } from '@/lib/council/api/foundation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/council/sessions/:id/evidence/:evidenceId (registered, not
 * wired). Evidence content is produced during council runs owned by
 * CWE-024 and CWE-025; no committed evidence store exists in the
 * foundation, so this read answers FEATURE_NOT_READY rather than
 * fabricating an evidence object (Section 17.6).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; evidenceId: string }> },
) {
  const { id } = await params;
  return handleNotReady(request, 'council.sessions.evidence.get', {
    sessionId: id,
    sessionAccess: 'read',
  });
}
