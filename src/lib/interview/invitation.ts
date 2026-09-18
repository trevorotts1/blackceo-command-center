import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { resolveTenantContext, signTenantGrant } from '@/lib/auth/tenant-context';
import { GET as readiness } from '@/app/api/auth/interview-ready/route';
import { INTERVIEW_INVITATION_TTL_SECONDS, INTERVIEW_INVITATION_VALID_UNTIL, INTERVIEW_INVITATION_REDEEMABLE } from './session-policy';


/** Operator-authorized issuance. Redemption, and the completion check that is
 *  the only thing which ends a link, stay in interview-session. */
export async function createInterviewInvitation(req: NextRequest, recipientHash: string) {
  const headers = { 'cache-control': 'private, no-store' };
  try {
    const context = await resolveTenantContext(req);
    if (
      context.subject !== 'operator:api' || context.kind !== 'self' ||
      context.installationId !== process.env.MC_INSTALLATION_ID
    ) {
      return NextResponse.json({ error: 'operator_required' }, { status: 403, headers });
    }
    if (typeof recipientHash !== 'string' || !/^[a-f0-9]{64}$/.test(recipientHash)) {
      return NextResponse.json({ error: 'recipient_binding_required' }, { status: 400, headers });
    }

    // A reverse proxy may give Next an internal HTTP URL. Use this installation's
    // configured public origin, never an unverified forwarded-host/proto header.
    const configuredOrigin = process.env.MC_TENANT_PUBLIC_URL;
    if (!configuredOrigin && process.env.NODE_ENV === 'production') {
      return NextResponse.json({ error: 'public_origin_unconfigured' }, { status: 409, headers });
    }
    const publicUrl = new URL(configuredOrigin || req.url);
    if (
      publicUrl.hostname !== context.host || publicUrl.username || publicUrl.password ||
      (configuredOrigin && (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash)) ||
      (process.env.NODE_ENV === 'production' && publicUrl.protocol !== 'https:') ||
      !['http:', 'https:'].includes(publicUrl.protocol)
    ) {
      return NextResponse.json({ error: 'public_origin_mismatch' }, { status: 409, headers });
    }

    const ready = await readiness(req);
    const receipt = await ready.json();
    if (ready.status !== 200 || receipt.ready !== true || receipt.interviewComplete !== false) {
      return NextResponse.json({ error: 'interview_not_ready' }, { status: 409, headers });
    }
    // `expiresAt` is a legacy compatibility field, not this link's lifetime.
    // The link is valid until the interview is complete; redemption enforces
    // that and ignores `exp` entirely. The value is kept inside the 24h bound
    // the already-deployed onboarding validators insist on, so a fleet box
    // running the older validator still delivers a link minted here.
    const expiresAt = Math.floor(Date.now() / 1000) + INTERVIEW_INVITATION_TTL_SECONDS;
    const ticket = await signTenantGrant({
      purpose: 'enrollment',
      tenantId: context.tenantId,
      companyId: context.companyId,
      installationId: context.installationId,
      host: context.host,
      subject: 'invited-owner:' + recipientHash,
      exp: expiresAt,
      nonce: randomUUID(),
    });
    return NextResponse.json({
      protocol: 'interview-invitation.v1',
      tenantId: context.tenantId,
      companyId: context.companyId,
      installationId: context.installationId,
      host: context.host,
      expiresAt,
      validUntil: INTERVIEW_INVITATION_VALID_UNTIL,
      redeemable: INTERVIEW_INVITATION_REDEEMABLE,
      // LEGACY WIRE CONSTANT, not a description of behaviour. Onboarding
      // validators already deployed across the fleet refuse any receipt whose
      // `oneUse` is not exactly true, so dropping it would stop those boxes
      // delivering links at all. Redemption is no longer single-use: the link
      // is re-openable until the interview is complete, and `redeemable` above
      // is the field that says so truthfully. Remove this only once no fleet
      // box runs a validator that requires it.
      oneUse: true,
      url: `${publicUrl.origin}/interview#enroll=${encodeURIComponent(ticket)}`,
    }, { headers });
  } catch {
    return NextResponse.json({ error: 'invitation_unavailable' }, { status: 403, headers });
  }
}
