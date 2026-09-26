import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { run } from '@/lib/db';
import { requestHost, verifyTenantGrant, verifyEnrollmentIdentity, signTenantGrant, tenantSessionToken, TENANT_SESSION_COOKIE } from '@/lib/auth/tenant-context';
import { INTERVIEW_SESSION_TTL_SECONDS } from '@/lib/interview/session-policy';
import { enrollmentWindowClosed } from '@/lib/interview/enrollment-window';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'private, no-store' };

/**
 * Session cookie attributes, single source for both issuance points below.
 *
 * SameSite=Lax (not Strict), from evidence: the invitation link is delivered
 * as a Telegram DM (POST /api/interview/send-link → notifyOwnerPrivate, the
 * owner taps it in an external app) and /interview accepts ?enroll= as a
 * full-page top-level navigation that survives Cloudflare Access login
 * (InterviewClient bootstrap). Strict withholds cookies on that cross-site
 * top-level GET, so the just-issued session would be missing on arrival.
 * Lax restores it. Safe here: GET is read-only, POST exchanges verify signed
 * grants, and HttpOnly + Secure stay on always.
 */
function interviewSessionCookie() {
  return {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const,
    path: '/', maxAge: INTERVIEW_SESSION_TTL_SECONDS,
  } as const;
}
function setInterviewSessionCookie(response: NextResponse, token: string) {
  const attrs = interviewSessionCookie();
  response.cookies.set(TENANT_SESSION_COOKIE, token, { ...attrs });
}

/** Session status is read-only: reopening never turns a bounded grant permanent. */
export async function GET(req: NextRequest) {
  try {
    const active = await verifyTenantGrant(tenantSessionToken(req), requestHost(req), 'session');
    if (active) return NextResponse.json({ ok: true, expiresAt: active.exp }, { headers });
  } catch { /* Malformed hosts cannot select a tenant or reveal session state. */ }
  return NextResponse.json({ error: 'session_expired_or_missing' }, { status: 403, headers });
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    if (raw.length > 4096) return NextResponse.json({ error: 'invalid_enrollment' }, { status: 403, headers });
    let ticket: string | null = null;
    try {
      const body = raw.trim() ? JSON.parse(raw) : null;
      ticket = typeof body?.ticket === 'string' ? body.ticket : null;
    } catch {
      return NextResponse.json({ error: 'invalid_enrollment' }, { status: 403, headers });
    }
    if (!ticket || ticket.length > 2048) return NextResponse.json({ error: 'invalid_enrollment' }, { status: 403, headers });
    const host = requestHost(req);
    const active = await verifyTenantGrant(tenantSessionToken(req), host, 'session');
    if (active) {
      // An already authenticated browser may reopen its link. Verify signature
      // AND ownership; never switch owners.
      const identity = await verifyEnrollmentIdentity(ticket, host);
      if (!identity || identity.subject !== active.subject) {
        return NextResponse.json({ error: 'enrollment_session_mismatch' }, { status: 403, headers });
      }
      // Sliding renewal: an actively used session gets a fresh 30-day window
      // on each resume so it never dies mid-interview. Ownership and scope
      // are copied from the LIVE session grant (active), never the ticket —
      // the ticket is identity proof only, exactly as the mismatch check above.
      const renewedAt = Math.floor(Date.now() / 1000) + INTERVIEW_SESSION_TTL_SECONDS;
      const renewed = await signTenantGrant({
        purpose: 'session', tenantId: active.tenantId, companyId: active.companyId,
        installationId: active.installationId, host: active.host,
        subject: active.subject, exp: renewedAt, nonce: randomUUID(),
      });
      const resumedResponse = NextResponse.json({ ok: true, resumed: true, expiresAt: renewedAt }, { headers });
      setInterviewSessionCookie(resumedResponse, renewed);
      return resumedResponse;
    }
    const grant = await verifyTenantGrant(ticket, host, 'enrollment');
    if (!grant) return NextResponse.json({ error: 'invalid_enrollment' }, { status: 403, headers });
    // The invitation never times out. Completing the interview is what ends it,
    // so this is the only reason a well-formed, correctly signed ticket is
    // turned away here.
    if (enrollmentWindowClosed(grant.companyId)) {
      return NextResponse.json({ error: 'interview_already_complete' }, { status: 403, headers });
    }
    const expiresAt = Math.floor(Date.now() / 1000) + INTERVIEW_SESSION_TTL_SECONDS;
    const token = await signTenantGrant({ ...grant, purpose: 'session', exp: expiresAt, nonce: randomUUID() });
    // The link is RE-OPENABLE until the interview is complete. Burning the nonce
    // on first redemption locked a client out of an unfinished interview the
    // moment they switched device, cleared cookies, or came back after the
    // browser session lapsed — a second way for the link to die early, which the
    // ruling forbids just as it forbids the clock. The first use is still
    // recorded, now as an audit trail rather than a gate.
    //
    // Identity does not widen. Every redemption issues a session for the subject
    // the ticket was signed for, so re-opening cannot switch owners, and the
    // completion check above is the one thing that ends the link.
    run('INSERT OR IGNORE INTO interview_enrollment_uses (nonce,used_at) VALUES (?,?)', [grant.nonce, new Date().toISOString()]);
    const response = NextResponse.json({ ok: true, resumed: false, expiresAt }, { headers });
    setInterviewSessionCookie(response, token);
    return response;
  } catch {
    return NextResponse.json({ error: 'enrollment_unavailable' }, { status: 503, headers });
  }
}
