/**
 * POST /api/social-theme/exchange — F27 single-use invitation redemption.
 *
 * Redeems an UNexpired, UNused, UNrevoked social-theme invitation (raw token
 * in the body, exactly once) into a scoped HttpOnly session cookie. On
 * success the RAW token is consumed (used_at stamped) so the same link can
 * never mint a second session (QC-F27 replay rejected), and the client is
 * instructed to strip the token from the address bar (history.replaceState)
 * — the mini-app page does this automatically after exchange.
 *
 * Rate limited per company+IP (sliding window) — SPEC: rate-limit invitation
 * exchange/renewal.
 *
 * The cookie's grant is purpose 'social-theme-session' and binds
 * sessionId + companyId + cycleId; GET/PATCH /api/social-theme/session
 * derives company/cycle from IT, never from query strings.
 */

import { NextRequest, NextResponse } from 'next/server';
import { run, queryOne } from '@/lib/db';
import {
  hashInvitationToken,
  signSessionCookie,
  SOCIAL_THEME_COOKIE,
  allowExchangeAttempt,
  markInvitationUsed,
} from '@/lib/social-theme/theme-sessions';
import { SOCIAL_THEME_EXCHANGE_RATE_LIMIT } from '@/lib/social-theme/session-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'private, no-store' };

interface InvitationRow {
  id: string;
  token_hash: string;
  company_id: string;
  cycle_id: string;
  session_id: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { ticket?: string } | null;
    const ticket = typeof body?.ticket === 'string' ? body.ticket : '';
    if (!ticket || ticket.length > 512) {
      return NextResponse.json({ error: 'invalid_ticket' }, { status: 400, headers });
    }

    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    // Rate limit FIRST — an unknown ticket has no company to scope a bucket
    // to, so blind token probing burns the IP-only bucket BEFORE the lookup
    // (SPEC: rate-limit invitation exchange/renewal).
    if (!allowExchangeAttempt(`ip-only:${ip}`, SOCIAL_THEME_EXCHANGE_RATE_LIMIT.windowSeconds, SOCIAL_THEME_EXCHANGE_RATE_LIMIT.max)) {
      return NextResponse.json({ error: 'too_many_attempts' }, { status: 429, headers });
    }
    const tokenHash = hashInvitationToken(ticket);
    const invitation = queryOne<InvitationRow>(
      `SELECT id, token_hash, company_id, cycle_id, session_id, expires_at, used_at, revoked_at
         FROM social_invitations WHERE token_hash = ? AND purpose = 'social-theme'`,
      [tokenHash],
    );
    // Same failure shape for unknown/expired/used/revoked: no oracle.
    if (!invitation) {
      return NextResponse.json({ error: 'invitation_invalid_or_expired' }, { status: 403, headers });
    }

    // Second, company-scoped bucket (the same IP may legitimately hold
    // invitations for more than one company).
    if (!allowExchangeAttempt(`${invitation.company_id}:${ip}`, SOCIAL_THEME_EXCHANGE_RATE_LIMIT.windowSeconds, SOCIAL_THEME_EXCHANGE_RATE_LIMIT.max)) {
      return NextResponse.json({ error: 'too_many_attempts' }, { status: 429, headers });
    }

    if (invitation.used_at || invitation.revoked_at) {
      return NextResponse.json({ error: 'invitation_invalid_or_expired' }, { status: 403, headers });
    }
    if (new Date(invitation.expires_at).getTime() <= Date.now()) {
      return NextResponse.json(
        {
          error: 'invitation_invalid_or_expired',
          renew_hint: 'Your saved answers are still there. Use renew from your assistant conversation for a fresh link.',
        },
        { status: 403, headers },
      );
    }

    // Session row must still exist and belong to the same company.
    const session = queryOne<{ id: string; company_id: string; cycle_id: string; status: string }>(
      `SELECT id, company_id, cycle_id, status FROM social_theme_sessions WHERE id = ?`,
      [invitation.session_id],
    );
    if (!session || session.company_id !== invitation.company_id || session.cycle_id !== invitation.cycle_id) {
      return NextResponse.json({ error: 'invitation_invalid_or_expired' }, { status: 403, headers });
    }

    const { value, maxAge } = await signSessionCookie({
      sessionId: session.id,
      companyId: session.company_id,
      cycleId: session.cycle_id,
    });

    // Consume the invitation AFTER cookie signing (signing failure must not
    // burn a valid ticket — same ordering as interview-session).
    if (!markInvitationUsed(invitation.id)) {
      return NextResponse.json({ error: 'invitation_invalid_or_expired' }, { status: 403, headers });
    }
    run(`UPDATE social_notification_outbox SET delivery_state = 'sent', updated_at = ?
          WHERE company_id = ? AND dedupe_key = ? AND delivery_state = 'pending'`,
      [new Date().toISOString(), session.company_id, `cycle-invite:${session.cycle_id}`]);

    const response = NextResponse.json(
      {
        ok: true,
        session_id: session.id,
        cycle_id: session.cycle_id,
        status: session.status,
        // The raw token must disappear from the URL/history; the page calls
        // history.replaceState immediately after this 200.
        clear_ticket_from_url: true,
      },
      { headers },
    );
    response.cookies.set(SOCIAL_THEME_COOKIE, value, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge,
    });
    return response;
  } catch {
    return NextResponse.json({ error: 'exchange_unavailable' }, { status: 503, headers });
  }
}