import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@/lib/auth/tenant-context';
import { collectReadinessMissing, gatherReadinessInputs } from '@/lib/readiness';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * R-28 client-facing readiness checklist.
 *
 * Serves the CALLER's OWN tenant context (no operator subject required): the
 * client sees exactly the same derivation the operator handshake returns —
 * readiness is a shared per-surface list, not an operator-only secret.
 * Re-derived from live probes on every request (`private, no-store`), so a
 * rebind/disconnect/upgrade can never show a cached green (D-29).
 */
export async function GET(req: NextRequest) {
  try {
    const context = await resolveTenantContext(req);
    const requireRemoteReceiver = req.nextUrl.searchParams.get('requireRemoteReceiver') === '1';
    const inputs = await gatherReadinessInputs(
      { kind: context.kind, installationId: context.installationId, companyId: context.companyId },
      { requireRemoteReceiver },
    );
    const missing = collectReadinessMissing(inputs);
    return NextResponse.json(
      {
        ready: missing.length === 0,
        companyId: context.companyId,
        missing,
      },
      {
        status: missing.length ? 503 : 200,
        headers: { 'cache-control': 'private, no-store' },
      },
    );
  } catch {
    return NextResponse.json(
      { ready: false, error: 'tenant_registration_or_identity_unverified' },
      { status: 403 },
    );
  }
}
