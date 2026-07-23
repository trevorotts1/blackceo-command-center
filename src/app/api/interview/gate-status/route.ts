/**
 * GET /api/interview/gate-status (U010)
 *
 * Lightweight canonical completion check for the interview shell-lock fallback.
 * The Edge middleware can't read .workforce-build-state.json (fs unavailable),
 * so when the `mc_interview_complete` cookie is absent/expired it hits this Node
 * endpoint to ask whether the interview is complete per the canonical FILES.
 *
 * Returns ONLY the two terminal signals — one sync file read, one JSON parse.
 * Fast enough for middleware fetch use. This is the AUTHORITATIVE "has the
 * closeout button actually been pressed?" answer at the filesystem level.
 *
 * Bypassed by the middleware itself (early return, before any auth layer) so
 * the middleware's own fallback fetch never hits an auth gate. Internal-only:
 * exposes two booleans, no secrets, no session, no write path.
 */

import { NextResponse } from 'next/server';
import { readBuildState } from '@/lib/interview/seam';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<NextResponse> {
  const bs = readBuildState();
  return NextResponse.json({
    interviewComplete: bs?.interviewComplete === true,
    buildCompleted: typeof bs?.buildCompletedAt === 'string',
  });
}
