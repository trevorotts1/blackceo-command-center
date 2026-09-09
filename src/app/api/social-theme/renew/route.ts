/**
 * POST /api/social-theme/renew — F27 expired-invitation renewal.
 *
 * Re-authentication: the caller must present EITHER
 *   a) an ACTIVE social-theme session cookie (the same draft, on any device
 *      — QC-F27 "resume on another device"), or
 *   b) operator/service auth + company_id + week_start_local (the verified
 *      client session / registered notification channel path: the assistant
 *      conversation re-issues a fresh link for the SAME draft).
 *
 * Renew mints a NEW single-use invitation ticket bound to the SAME draft
 * session (contract: "renew mints new ticket to same draft"). The old
 * invitation is NOT revoked individually — it expires naturally; revocation
 * stays an explicit operator action. Rate limited with exchange.
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { resolveTenantContext, TenantAccessError } from '@/lib/auth/tenant-context';
import { run, queryOne } from '@/lib/db';
import {
  getCycleByWeek,
  ensureDraftSession,
  getCycle,
} from '@/lib/social-theme/cycles';
import {
  mintInvitationToken,
  readSocialThemeCookie,
  resolveSessionRow,
  verifySessionCookie,
  allowExchangeAttempt,
  SOCIAL_THEME_INVITATION_PURPOSE,
} from '@/lib/social-theme/theme-sessions';
import { SOCIAL_THEME_EXCHANGE_RATE_LIMIT, SOCIAL_THEME_INVITATION_TTL_SECONDS } from '@/lib/social-theme/session-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'private, no-store' };

function publicOrigin(): string | null {
  const configured = process.env.MC_TENANT_PUBLIC_URL || process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, '');
  if (process.env.NODE_ENV !== 'production') return 'http://localhost:4000';
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      company_id?: string;
      week_start_local?: string;
    };
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';

    // Path A: an active social-theme session cookie renews its own draft
    // (another device or expired LINK — the cookie is separate from the ticket).
    const grant = await verifySessionCookie(readSocialThemeCookie(req));
    if (grant) {
      const session = resolveSessionRow(grant);
      if (session) {
        if (!allowExchangeAttempt(
          `${session.company_id}:${ip}`,
          SOCIAL_THEME_EXCHANGE_RATE_LIMIT.windowSeconds,
          SOCIAL_THEME_EXCHANGE_RATE_LIMIT.max,
        )) {
          return NextResponse.json({ error: 'too_many_attempts' }, { status: 429, headers });
        }
        return mintForSession(session.id, session.company_id, session.cycle_id);
      }
    }

    // Path B: operator/service renewal for a registered company+week.
    const context = await resolveTenantContext(req);
    if (context.kind !== 'self' || context.subject !== 'operator:api') {
      return NextResponse.json({ error: 'renewal_auth_required' }, { status: 403, headers });
    }
    const companyId = typeof body.company_id === 'string' ? body.company_id.trim() : '';
    const weekStart = typeof body.week_start_local === 'string' ? body.week_start_local.trim() : '';
    if (!companyId || !weekStart) {
      return NextResponse.json({ error: 'company_id_and_week_start_required' }, { status: 400, headers });
    }
    if (!allowExchangeAttempt(`${companyId}:${ip}`, SOCIAL_THEME_EXCHANGE_RATE_LIMIT.windowSeconds, SOCIAL_THEME_EXCHANGE_RATE_LIMIT.max)) {
      return NextResponse.json({ error: 'too_many_attempts' }, { status: 429, headers });
    }
    const cycle = getCycleByWeek(companyId, weekStart);
    if (!cycle) return NextResponse.json({ error: 'cycle_not_found' }, { status: 404, headers });
    if (cycle.state === 'closed' || cycle.state === 'skipped') {
      return NextResponse.json({ error: 'cycle_closed' }, { status: 409, headers });
    }
    const session = queryOne<{ id: string; company_id: string; cycle_id: string }>(
      `SELECT id, company_id, cycle_id FROM social_theme_sessions WHERE company_id = ? AND cycle_id = ?`,
      [companyId, cycle.id],
    );
    if (!session) return NextResponse.json({ error: 'session_not_found' }, { status: 404, headers });
    return mintForSession(session.id, session.company_id, session.cycle_id);
  } catch (error) {
    if (error instanceof TenantAccessError) {
      return NextResponse.json({ error: 'renewal_auth_required' }, { status: 403, headers });
    }
    return NextResponse.json({ error: 'renew_unavailable' }, { status: 503, headers });
  }
}

async function mintForSession(sessionId: string, companyId: string, cycleId: string) {
  const cycle = getCycle(cycleId, companyId);
  if (!cycle || cycle.state === 'closed' || cycle.state === 'skipped') {
    return NextResponse.json({ error: 'cycle_closed' }, { status: 409, headers });
  }
  const { raw, tokenHash } = mintInvitationToken();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SOCIAL_THEME_INVITATION_TTL_SECONDS * 1000).toISOString();
  const invitationId = randomUUID();
  run(
    `INSERT INTO social_invitations (id, token_hash, purpose, company_id, cycle_id, session_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [invitationId, tokenHash, SOCIAL_THEME_INVITATION_PURPOSE, companyId, cycleId, sessionId, expiresAt, now],
  );
  const origin = publicOrigin();
  if (!origin) {
    return NextResponse.json({ error: 'public_origin_unconfigured' }, { status: 409, headers });
  }
  return NextResponse.json(
    {
      protocol: 'social-theme-invitation.v1',
      invitation_id: invitationId,
      company_id: companyId,
      cycle_id: cycleId,
      session_id: sessionId,
      expires_at: expiresAt,
      one_use: true,
      purpose: SOCIAL_THEME_INVITATION_PURPOSE,
      // Raw token HERE ONLY — never stored or logged.
      url: `${origin}/social-theme/welcome?ticket=${encodeURIComponent(raw)}`,
    },
    { headers },
  );
}