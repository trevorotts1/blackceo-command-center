import { NextRequest, NextResponse } from 'next/server';
import { resolveInterviewTenant, refuseUnverifiedTenant } from '@/lib/interview/tenant';
import { CSRF_COOKIE_NAME, verifyCsrfToken } from '@/lib/csrf-protection';
import { declarePriorCompletion } from '@/lib/interview/prior-completion';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'private, no-store' };

export async function POST(request: NextRequest) {
  const tenant = await resolveInterviewTenant(request);
  const refused = refuseUnverifiedTenant(tenant);
  if (refused) return refused;
  // Browser-only declaration: neither a service bearer nor an unverified header
  // may make an owner's attestation. Enforce CSRF here as well as middleware.
  if (tenant.context!.subject === 'operator:api' ||
      !await verifyCsrfToken(request.cookies.get(CSRF_COOKIE_NAME)?.value)) {
    return NextResponse.json({ error: 'owner_session_required' }, { status: 403, headers });
  }
  try {
    const origin = new URL(request.headers.get('origin') || '');
    if (origin.host !== request.headers.get('host') || !['https:', 'http:'].includes(origin.protocol)) throw new Error('foreign origin');
  } catch {
    return NextResponse.json({ error: 'same_origin_required' }, { status: 403, headers });
  }
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 256) throw new Error('oversized');
    body = JSON.parse(raw);
    if (!body || body.confirmed !== true || Object.keys(body).length !== 1) throw new Error('invalid');
  } catch {
    return NextResponse.json({ error: 'confirmation_required' }, { status: 400, headers });
  }
  try {
    const declaration = declarePriorCompletion(tenant.context!);
    return NextResponse.json({ ok: true, priorCompletionDeclared: true, declaration, redirect: '/' }, { headers });
  } catch {
    return NextResponse.json({ error: 'declaration_not_saved', message: 'Your declaration was not saved. Please retry.' }, { status: 503, headers });
  }
}
