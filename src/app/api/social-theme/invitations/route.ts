/**
 * POST /api/social-theme/invitations — F27 operator/service-authenticated
 * invitation issuance for the weekly theme mini app.
 *
 * Contract (SPEC "weekly mini app data and API"):
 *   - Operator/service auth ONLY (bearer MC_API_TOKEN or self tenant) — this
 *     is an outbound delivery trigger, never a client-facing surface.
 *   - Creates a company/cycle-bound invitation: the cycle row is keyed by
 *     (company_id, week_start_local) with UNIQUE — week 2 can never
 *     overwrite week 1, and a duplicate request collapses onto the same
 *     cycle instead of creating a second one.
 *   - The raw token is returned ONCE in this response (for the operator/
 *     service to deliver through the registered channel — Telegram, SMS,
 *     email). ONLY the SHA-256 hash is stored; the raw value never lands in
 *     logs or analytics (contract rule: no raw token in logs).
 *   - Queueing: writes a canonical social_notification_outbox record so the
 *     delivery is observable + retryable; the body carries the delivery
 *     metadata, never the raw token itself (delivery channels mint their
 *     own messages from this response's url field at send time).
 *
 * Response also carries the reachable public URL built from
 * MC_TENANT_PUBLIC_URL (never localhost in production, SPEC hosting rule).
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { resolveTenantContext, TenantAccessError } from '@/lib/auth/tenant-context';
import { getDb, run, queryOne } from '@/lib/db';
import {
  ensureCycle,
  ensureDraftSession,
  markCycleState,
} from '@/lib/social-theme/cycles';
import {
  mintInvitationToken,
  SOCIAL_THEME_INVITATION_PURPOSE,
} from '@/lib/social-theme/theme-sessions';
import { SOCIAL_THEME_INVITATION_TTL_SECONDS } from '@/lib/social-theme/session-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'private, no-store' };

/** Fallback public origin for the invitation link. */
function publicOrigin(): string | null {
  const configured = process.env.MC_TENANT_PUBLIC_URL || process.env.PUBLIC_BASE_URL;
  if (configured) return configured.replace(/\/$/, '');
  if (process.env.NODE_ENV !== 'production') return 'http://localhost:4000';
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const context = await resolveTenantContext(req);
    // Operator/service only. Client tenants cannot mint invitations.
    if (context.kind !== 'self' || context.subject !== 'operator:api') {
      return NextResponse.json({ error: 'operator_service_required' }, { status: 403, headers });
    }
    const body = (await req.json().catch(() => null)) as {
      company_id?: string;
      week_start_local?: string;
      timezone?: string;
    } | null;
    const companyId = typeof body?.company_id === 'string' ? body.company_id.trim() : '';
    const weekStart = typeof body?.week_start_local === 'string' ? body.week_start_local.trim() : '';
    const timezone = typeof body?.timezone === 'string' && body.timezone.trim() ? body.timezone : 'UTC';
    if (!companyId || !weekStart) {
      return NextResponse.json({ error: 'company_id_and_week_start_required' }, { status: 400, headers });
    }

    // The company must exist (E_COMPANY_NOT_FOUND per company_cycle contract).
    const company = queryOne<{ id: string }>(
      `SELECT id FROM clients WHERE id = ?`,
      [companyId],
    );
    if (!company) {
      return NextResponse.json({ error: 'E_COMPANY_NOT_FOUND' }, { status: 404, headers });
    }

    const origin = publicOrigin();
    if (!origin) {
      return NextResponse.json({ error: 'public_origin_unconfigured' }, { status: 409, headers });
    }

    // Cycle: unique(company_id, week_start_local) — collapses duplicates.
    const { cycle } = ensureCycle({
      companyId,
      weekStartLocal: weekStart,
      timezone,
    });
    if (cycle.state === 'closed' || cycle.state === 'skipped') {
      return NextResponse.json(
        { error: 'E_CYCLE_CLOSED', cycle_id: cycle.id, state: cycle.state },
        { status: 409, headers },
      );
    }

    const session = ensureDraftSession(cycle);
    const { raw, tokenHash } = mintInvitationToken();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SOCIAL_THEME_INVITATION_TTL_SECONDS * 1000).toISOString();
    const invitationId = randomUUID();
    run(
      `INSERT INTO social_invitations (id, token_hash, purpose, company_id, cycle_id, session_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [invitationId, tokenHash, SOCIAL_THEME_INVITATION_PURPOSE, companyId, cycle.id, session.id, expiresAt, now],
    );

    // Queue the delivery (outbox). The body references the invitation + cycle;
    // the raw token is NOT persisted anywhere — delivery metadata only.
    // Re-inviting the same cycle REUSES its outbox record (dedupe_key is
    // UNIQUE per company): the row flips back to pending with a bumped
    // attempt count instead of double-queueing.
    const outboxId = randomUUID();
    run(
      `INSERT INTO social_notification_outbox
         (id, company_id, event_id, dedupe_key, destination_ref, subject, body, delivery_state, attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
       ON CONFLICT (company_id, dedupe_key) DO UPDATE SET
         event_id = excluded.event_id,
         body = excluded.body,
         delivery_state = 'pending',
         attempt_count = attempt_count + 1,
         updated_at = excluded.updated_at`,
      [
        outboxId,
        companyId,
        `social-theme-invite:${cycle.id}:${now}`,
        `cycle-invite:${cycle.id}`,
        `company:${companyId}`,
        'Your weekly social plan is ready to review',
        JSON.stringify({ invitation_id: invitationId, cycle_id: cycle.id, expires_at: expiresAt }),
        now,
        now,
      ],
    );

    markCycleState(cycle.id, companyId, 'invited');

    const url = `${origin}/social-theme/welcome?ticket=${encodeURIComponent(raw)}`;
    return NextResponse.json(
      {
        protocol: 'social-theme-invitation.v1',
        invitation_id: invitationId,
        company_id: companyId,
        cycle_id: cycle.id,
        session_id: session.id,
        expires_at: expiresAt,
        one_use: true,
        purpose: SOCIAL_THEME_INVITATION_PURPOSE,
        outbox_id: outboxId,
        // Raw token appears HERE and ONLY here — never logged, never stored.
        url,
      },
      { headers },
    );
  } catch (error) {
    if (error instanceof TenantAccessError) {
      return NextResponse.json({ error: 'operator_service_required' }, { status: 403, headers });
    }
    if (error instanceof Error && error.message === 'invalid week_start_local') {
      return NextResponse.json({ error: 'invalid_week_start' }, { status: 400, headers });
    }
    if (process.env.NODE_ENV !== 'production') {
      console.error('[social-theme/invitations] failed:', error);
    }
    getDb(); // ensure the failure path still surfaces a real DB state for logs
    return NextResponse.json({ error: 'invitation_unavailable' }, { status: 503, headers });
  }
}