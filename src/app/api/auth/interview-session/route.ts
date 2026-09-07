import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { run } from '@/lib/db';
import { requestHost, verifyTenantGrant, verifyEnrollmentIdentity, signTenantGrant, tenantSessionToken, TENANT_SESSION_COOKIE } from '@/lib/auth/tenant-context';
import { INTERVIEW_SESSION_TTL_SECONDS } from '@/lib/interview/session-policy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'private, no-store' };

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
    const body = await req.json();
    const ticket = typeof body?.ticket === 'string' ? body.ticket : null;
    const host = requestHost(req);
    const active = await verifyTenantGrant(tenantSessionToken(req), host, 'session');
    if (active) {
      // An already authenticated browser may reopen its one-use link. Verify
      // signature AND ownership even after ticket expiry; never switch owners.
      const identity = await verifyEnrollmentIdentity(ticket, host);
      if (!identity || identity.subject !== active.subject) {
        return NextResponse.json({ error: 'enrollment_session_mismatch' }, { status: 403, headers });
      }
      return NextResponse.json({ ok: true, resumed: true, expiresAt: active.exp }, { headers });
    }
    const grant = await verifyTenantGrant(ticket, host, 'enrollment');
    if (!grant) return NextResponse.json({ error: 'invalid_enrollment' }, { status: 403, headers });
    const expiresAt = Math.floor(Date.now() / 1000) + INTERVIEW_SESSION_TTL_SECONDS;
    // Prepare the cookie before consuming the nonce so signing failure cannot
    // burn an otherwise valid entry ticket.
    const token = await signTenantGrant({ ...grant, purpose: 'session', exp: expiresAt, nonce: randomUUID() });
    const used = run('INSERT OR IGNORE INTO interview_enrollment_uses (nonce,used_at) VALUES (?,?)', [grant.nonce, new Date().toISOString()]);
    if (!used.changes) return NextResponse.json({ error: 'enrollment_already_used' }, { status: 409, headers });
    const response = NextResponse.json({ ok: true, resumed: false, expiresAt }, { headers });
    response.cookies.set(TENANT_SESSION_COOKIE, token, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict',
      path: '/', maxAge: INTERVIEW_SESSION_TTL_SECONDS,
    });
    return response;
  } catch {
    return NextResponse.json({ error: 'enrollment_unavailable' }, { status: 503, headers });
  }
}
