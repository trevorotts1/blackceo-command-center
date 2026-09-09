/**
 * GET /api/health/service — the F21 sanitized service-health view.
 *
 * Mirrors the ONB social-planner-doctor contract against the CC-native
 * durable records (src/lib/health/service-health.ts). SANITIZED: states,
 * ids, counts and repair actions only — never a credential value, never a
 * raw token. The response NEVER claims work is progressing when a worker is
 * stopped: a stale tick, a missed invitation or an overdue queue row is an
 * actionable health state, not "working".
 *
 * Response: 200 with { ok, degraded, generated_at, checks, actionable }.
 * No company secrets, no GHL tokens, no sheet URLs beyond registry ids.
 */
import { NextResponse } from 'next/server';
import { serviceHealthReport } from '@/lib/health/service-health';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const report = serviceHealthReport();
    return NextResponse.json(report, { status: 200 });
  } catch (error) {
    // Fail-closed but never crash: report the compute failure as unhealthy.
    return NextResponse.json(
      {
        ok: false,
        degraded: false,
        generated_at: new Date().toISOString(),
        checks: {},
        actionable: [{ check: 'report', state: 'compute_error', detail: String(error).slice(0, 160) }],
      },
      { status: 200 },
    );
  }
}