/**
 * GET /api/interview/gate-status (U010)
 *
 * Lightweight canonical completion check for the interview shell-lock fallback.
 * The Edge middleware can't read .workforce-build-state.json (fs unavailable),
 * so when the `mc_interview_complete` cookie is absent/expired it hits this Node
 * endpoint to ask whether the interview is complete per the canonical FILES.
 *
 * Returns ONLY the terminal signals — one sync file read, one JSON parse.
 * Fast enough for middleware fetch use. This is the AUTHORITATIVE "has the
 * closeout button actually been pressed?" answer at the filesystem level.
 *
 * AI Workforce standard-first (PHASE 6 item 2): adds `standardReady` — true
 * when build-state carries standardPrebuild.status === "done" (the prebuild
 * driver's terminal record). It is INFORMATIONAL ONLY: the middleware's
 * fallback admission still keys on interviewComplete/buildCompletedAt alone,
 * so a standardReady box with an incomplete interview stays LOCKED (asserted
 * by the interview-lock E2E's standard-first block). It exists so a preview
 * surface can render "the foundation is ready" even while the shell is locked.
 *
 * Bypassed by the middleware itself (early return, before any auth layer) so
 * the middleware's own fallback fetch never hits an auth gate. Internal-only:
 * exposes three booleans, no secrets, no session, no write path.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readBuildState, readStandardPrebuild } from '@/lib/interview/seam';
import { resolveInterviewTenant } from '@/lib/interview/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest): Promise<NextResponse> {
  // JANET-INTERVIEW-FIX: a remote client's hostname must answer from ITS
  // clients-row flag, never this box's canonical files. Self (operator) reads
  // the canonical files exactly as before.
  const tenant = resolveInterviewTenant(request);
  if (tenant.kind === 'client' && tenant.client) {
    return NextResponse.json({
      interviewComplete: tenant.client.interview_complete === true,
      buildCompleted: false,
      standardReady: false,
    });
  }
  const bs = readBuildState();
  return NextResponse.json({
    interviewComplete: bs?.interviewComplete === true,
    buildCompleted: typeof bs?.buildCompletedAt === 'string',
    standardReady: readStandardPrebuild(bs).standardReady,
  });
}
