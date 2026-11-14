import { priorCompletion } from '@/lib/interview/prior-completion';
import { tenantRegistration } from '@/lib/auth/tenant-context';
import { verifiedBuild } from '@/lib/interview/build-verification';
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
 * exposes booleans plus one state word, no secrets, no session, no write path.
 *
 * BU-23 (WF-023): adds `status` — the ONE reader's state name from
 * src/lib/interview/interview-status.ts (the TypeScript port of the onboarding
 * repository's scripts/interview_status.py; both are driven by one shared
 * fixture). It is computed from the SAME single build-state read below, so this
 * endpoint still does one sync read and one parse. The five fields this route
 * already answered keep their exact meaning; `status` is additive and the
 * middleware's admission keys are unchanged.
 *
 * READY is the one state this route cannot report: it needs the gate's own
 * state file and question registry, which this endpoint deliberately does not
 * read. An interview whose required questions are all answered but whose
 * completion button has not been pressed therefore reports IN_PROGRESS here,
 * never NOT_STARTED.
 */

import { standardPlaceholderActive } from '@/lib/interview/build-verification';
import { NextRequest, NextResponse } from 'next/server';
import { readBuildState, readStandardPrebuild } from '@/lib/interview/seam';
import { interviewStatus } from '@/lib/interview/interview-status';
import { resolveInterviewTenant, refuseUnverifiedTenant, tenantForHost } from '@/lib/interview/tenant';
import { INTERNAL_GATE_HEADER, INTERNAL_HOST_HEADER, verifyInternalGateToken } from '@/lib/interview/internal-call';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest): Promise<NextResponse> {
  // TENANT-INTERVIEW-FIX: a remote client's hostname must answer from ITS
  // clients-row flag, never this box's canonical files. Self (operator) reads
  // the canonical files exactly as before.
  // The middleware's dashboard-admission fallback calls this endpoint over an
  // in-process loopback fetch. That call is server-to-server, so it carries no
  // Cloudflare edge headers and would be refused by the Host-spoofing guard —
  // which would 302 every client tenant to /interview even with a completed
  // interview. It instead proves it holds the box's HMAC secret; an attacker
  // that can reach the origin cannot mint that token.
  // The host this call CLAIMS to be for. Node's fetch (undici) drops a `host`
  // header set by the caller, so the loopback fallback also sends it as
  // INTERNAL_HOST_HEADER; prefer that and fall back to the real Host for
  // Edge-runtime builds and any other caller.
  //
  // NOT a trust downgrade: the claimed host is only ever honored when the
  // accompanying token — an HMAC over `host|expiry` keyed with the box secret —
  // verifies for that exact host. A spoofed header without a matching signature
  // fails verification and falls through to full tenant resolution below.
  const claimedHost =
    request.headers.get(INTERNAL_HOST_HEADER) || request.headers.get('host');
  const internalOk = await verifyInternalGateToken(
    request.headers.get(INTERNAL_GATE_HEADER),
    claimedHost,
  );
  const tenant = internalOk
    ? tenantForHost(claimedHost)
    : await resolveInterviewTenant(request);
  const refusedTenant = refuseUnverifiedTenant(tenant);
  if (refusedTenant) return refusedTenant;
  let priorCompletionDeclared: boolean;
  try {
    const scope = internalOk ? tenantRegistration(new URL(`http://${claimedHost}`).hostname) : tenant.context!;
    priorCompletionDeclared = priorCompletion(scope) !== null;
  } catch {
    return NextResponse.json({ error: 'completion_state_unavailable' }, { status: 503 });
  }
  if (tenant.kind === 'client' && tenant.client) {
    const complete = tenant.client.interview_complete === true;
    return NextResponse.json({
      priorCompletionDeclared,
      interviewComplete: complete,
      buildCompleted: false,
      standardReady: false,
      standardPlaceholder: false,
      status: interviewStatus({ interviewComplete: complete }, { declared: priorCompletionDeclared }),
    });
  }
  const bs = readBuildState();
  return NextResponse.json({
    priorCompletionDeclared,
    interviewComplete: bs?.interviewComplete === true,
    buildCompleted: verifiedBuild(bs),
    standardReady: readStandardPrebuild(bs).standardReady,
    standardPlaceholder: standardPlaceholderActive(bs),
    status: interviewStatus(bs, { declared: priorCompletionDeclared }),
  });
}
