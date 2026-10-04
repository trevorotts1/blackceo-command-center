/**
 * /api/auth/owner-session — redeem / report / renew / clear the owner session.
 *
 *   POST   {ticket}  redeem a one-use, ten-minute owner-login capability
 *   GET              report the authenticated browser scope (no secrets)
 *   PATCH            renew a still-valid browser session
 *   DELETE           clear THIS cookie (never claims to sign the owner out of
 *                    an independent Cloudflare Access identity)
 *
 * POST is the narrow, self-authenticating redemption in S7 (line 277). It is
 * exempted from generic Access/session/bearer enforcement by A04's middleware
 * edit — which is exactly why this handler performs every check itself rather
 * than inheriting any: exact configured Origin (scheme and port), the signed
 * anti-forgery cookie, same-origin Fetch Metadata when present, and the
 * ticket's signature/purpose/expiry/host/company/installation.
 *
 * GET/PATCH/DELETE are NOT part of that exemption and require a verified
 * existing browser identity (S7 line 277). They are drivable in tests without a
 * middleware change because a credential-less request is never blocked from
 * reaching its handler — the handler is the gate.
 *
 * Response shape mirrors the sibling interview-session route: a bare
 * `{error: '<code>'}` with `cache-control: private, no-store`. SPEC.md rev 4
 * S7 lines 271-283.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import {
  signTenantGrant,
  tenantSessionToken,
  TENANT_SESSION_COOKIE,
  verifyTenantGrant,
} from '@/lib/auth/tenant-context';
import {
  OWNER_LOGIN_PURPOSE,
  OWNER_LOGIN_TICKET_MAX,
  OWNER_REDIRECT_PATH,
  OWNER_SESSION_BODY_MAX,
  OWNER_SESSION_TTL_SECONDS,
  consumeOwnerLoginNonce,
  ownerSessionCookieAttributes,
  pruneOwnerLoginUses,
  registrationAllowsOwnerLogin,
  resolveOwnerBrowserIdentity,
  signOwnerSession,
  verifyAntiForgery,
  verifyExactOrigin,
  verifyFetchMetadata,
} from '@/lib/auth/owner-login';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const headers = { 'cache-control': 'private, no-store' };

/** No private data ever rides a refusal; every refusal has the same shape. */
const deny = (code: string, status: number) =>
  NextResponse.json({ error: code }, { status, headers });

/** The checks PATCH and DELETE share: exact Origin, Fetch Metadata, anti-forgery. */
async function mutationRefused(req: NextRequest): Promise<NextResponse | null> {
  const origin = verifyExactOrigin(req);
  if (origin === 'unconfigured') return deny('owner_origin_unconfigured', 503);
  if (origin !== 'ok') return deny('owner_origin_mismatch', 403);
  if (!verifyFetchMetadata(req)) return deny('owner_origin_mismatch', 403);
  if (!(await verifyAntiForgery(req))) return deny('owner_antiforgery_missing', 403);
  return null;
}

export async function POST(req: NextRequest) {
  try {
    // 1. Exact configured Origin, scheme and port included. An unconfigured
    //    public origin is a setup error, never a reason to skip the check.
    const origin = verifyExactOrigin(req);
    if (origin === 'unconfigured') return deny('owner_origin_unconfigured', 503);
    if (origin !== 'ok') return deny('owner_origin_mismatch', 403);

    // 2. Same-origin Fetch Metadata, when the browser sent one.
    if (!verifyFetchMetadata(req)) return deny('owner_origin_mismatch', 403);

    // 3. The signed anti-forgery cookie the landing page was served with.
    if (!(await verifyAntiForgery(req))) return deny('owner_antiforgery_missing', 403);

    // 4. Body `{ticket}` ONLY, max 4 KiB (S7 line 279).
    const raw = await req.text();
    if (raw.length > OWNER_SESSION_BODY_MAX) return deny('owner_ticket_invalid', 403);
    let ticket: string | null = null;
    try {
      const body = raw.trim() ? JSON.parse(raw) : null;
      ticket = typeof body?.ticket === 'string' ? body.ticket : null;
    } catch {
      return deny('owner_ticket_invalid', 403);
    }
    if (!ticket || ticket.length > OWNER_LOGIN_TICKET_MAX) return deny('owner_ticket_invalid', 403);

    // 5. Signature, purpose, expiry, host, company and installation. The
    //    `owner-login` purpose expires on the clock because grantExpired()
    //    bounds every purpose except the deliberately timeless enrollment.
    const host = req.headers.get('host') || '';
    const grant = await verifyTenantGrant(ticket, host, OWNER_LOGIN_PURPOSE);
    if (!grant) return deny('owner_ticket_invalid', 403);

    // 6. This installation must be able to authorize this owner at all.
    if (!registrationAllowsOwnerLogin(host)) return deny('owner_ticket_invalid', 403);

    // 7. A service bearer is not a browser owner. Refuse outright rather than
    //    silently falling back to one (S7 line 269).
    if (req.headers.get('authorization')) return deny('owner_bearer_not_accepted', 403);

    // 8. An existing verified browser identity is never silently replaced.
    //    Same stable subject continues; a different principal is told to sign
    //    out and back in — private transcripts are never merged implicitly.
    const existing = await resolveOwnerBrowserIdentity(req);
    if (existing && existing.subject !== grant.subject) {
      return deny('identity_switch_requires_signout', 409);
    }

    // 9. Sign the destination session BEFORE any mutation: a signing failure
    //    must not burn a valid ticket (same ordering as interview-session).
    const session = await signOwnerSession({
      tenantId: grant.tenantId,
      companyId: grant.companyId || '',
      installationId: grant.installationId,
      host: grant.host,
      subject: grant.subject,
    });

    // 10. One winner across every process and restart. The nonce primary key
    //     arbitrates; a lost response still consumes the ticket, so the owner
    //     gets a fresh minted link rather than a replayed one.
    pruneOwnerLoginUses();
    const consumed = consumeOwnerLoginNonce(grant.nonce, grant.exp);
    if (consumed === 'unavailable') return deny('owner_session_unavailable', 503);
    if (consumed !== 'consumed') return deny('owner_ticket_used', 403);

    const response = NextResponse.json(
      {
        ok: true,
        subject: grant.subject,
        companyId: grant.companyId || '',
        expiresAt: session.expiresAt,
        // S7 line 283: successful redeem navigates ONLY to /hq. The path is a
        // constant here; no caller-supplied next/returnTo exists anywhere.
        redirectTo: OWNER_REDIRECT_PATH,
      },
      { headers },
    );
    response.cookies.set(TENANT_SESSION_COOKIE, session.token, {
      ...ownerSessionCookieAttributes(),
      maxAge: OWNER_SESSION_TTL_SECONDS,
    });
    return response;
  } catch {
    return deny('owner_session_unavailable', 503);
  }
}

export async function GET(req: NextRequest) {
  try {
    const identity = await resolveOwnerBrowserIdentity(req);
    if (!identity) return deny('owner_session_missing', 403);
    // Reports scope only. No ticket, no token, no cookie value, no gateway key.
    return NextResponse.json(
      {
        authenticated: true,
        via: identity.via,
        subject: identity.subject,
        companyId: identity.companyId,
        expiresAt: identity.expiresAt,
      },
      { headers },
    );
  } catch {
    return deny('owner_session_unavailable', 503);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const refused = await mutationRefused(req);
    if (refused) return refused;

    const host = req.headers.get('host') || '';
    // Renewal is limited to the cookie this route owns. An Access-only visitor
    // has no local session to renew, and renewing one would be an implicit
    // principal merge S7 forbids.
    const active = await verifyTenantGrant(tenantSessionToken(req), host, 'session');
    if (!active) return deny('owner_session_missing', 403);

    // Current subject authorization is re-checked: a removed owner mapping must
    // not be able to renew. A verified identity that no longer matches the
    // presented session is a collision, not a renewal.
    if (!registrationAllowsOwnerLogin(host)) return deny('owner_session_renewal_refused', 403);
    const current = await resolveOwnerBrowserIdentity(req);
    if (!current || current.subject !== active.subject) {
      return deny('identity_switch_requires_signout', 409);
    }

    // Sliding renewal copies scope from the LIVE grant, never from a request.
    const expiresAt = Math.floor(Date.now() / 1000) + OWNER_SESSION_TTL_SECONDS;
    const token = await signTenantGrant({
      purpose: 'session',
      tenantId: active.tenantId,
      companyId: active.companyId || '',
      installationId: active.installationId,
      host: active.host,
      subject: active.subject,
      exp: expiresAt,
      nonce: randomUUID(),
    });
    const response = NextResponse.json({ ok: true, subject: active.subject, expiresAt }, { headers });
    response.cookies.set(TENANT_SESSION_COOKIE, token, {
      ...ownerSessionCookieAttributes(),
      maxAge: OWNER_SESSION_TTL_SECONDS,
    });
    return response;
  } catch {
    return deny('owner_session_unavailable', 503);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const refused = await mutationRefused(req);
    if (refused) return refused;

    // S7 line 277: DELETE requires a verified existing browser identity too —
    // it is not part of the unauthenticated redemption exemption.
    const identity = await resolveOwnerBrowserIdentity(req);
    if (!identity) return deny('owner_session_missing', 403);

    const response = NextResponse.json({ ok: true, cleared: true, via: identity.via }, { headers });
    response.cookies.set(TENANT_SESSION_COOKIE, '', {
      ...ownerSessionCookieAttributes(),
      maxAge: 0,
    });
    // Independent Access identity is NOT touched and is not claimed to be: a
    // browser that arrived through Access stays signed in at the edge.
    return response;
  } catch {
    return deny('owner_session_unavailable', 503);
  }
}
