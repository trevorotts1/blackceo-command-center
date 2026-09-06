import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { resolveTenantContext, signTenantGrant } from '@/lib/auth/tenant-context';
import { GET as readiness } from '../interview-ready/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Operator-authorized issuance; one-use redemption stays in interview-session. */
export async function POST(req: NextRequest) {
  const headers = { 'cache-control': 'private, no-store' };
  try {
    const context = await resolveTenantContext(req);
    if (
      context.subject !== 'operator:api' || context.kind !== 'self' ||
      context.installationId !== process.env.MC_INSTALLATION_ID
    ) {
      return NextResponse.json({ error: 'operator_required' }, { status: 403, headers });
    }
    const body = await req.json();
    if (typeof body.recipientHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.recipientHash)) {
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
    const expiresAt = Math.floor(Date.now() / 1000) + 900;
    const ticket = await signTenantGrant({
      purpose: 'enrollment',
      tenantId: context.tenantId,
      installationId: context.installationId,
      host: context.host,
      subject: 'invited-owner:' + body.recipientHash,
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
      oneUse: true,
      url: `${publicUrl.origin}/interview#enroll=${encodeURIComponent(ticket)}`,
    }, { headers });
  } catch {
    return NextResponse.json({ error: 'invitation_unavailable' }, { status: 403, headers });
  }
}
