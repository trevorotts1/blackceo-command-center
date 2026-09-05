import { resolveInterviewTenant, refuseUnverifiedTenant } from '@/lib/interview/tenant';
import { queueInterviewOperation } from '@/lib/interview/remote-store';
import { deliverInterviewOperation } from '@/lib/interview/remote-protocol';
/**
 * GET /api/interview/canonical-departments
 *
 * Proxy list-canonical-departments.py --json at runtime to get the LIVE
 * mandatory + universal-primary department set, decorated with emoji and
 * one-liners from the naming map.
 *
 * The department board (P2-5) renders exactly this list at runtime, so the
 * floor count is never hardcoded and always matches the current naming map
 * version. Exit 1 (missing naming map) is handled gracefully with a 503 so
 * the board can still render from cached data or show a gentle 'loading'
 * state rather than crashing.
 *
 * Returns:
 *   200 { mandatory[], universal_primary_vertical[], floor }
 *   503 { error, message } — naming map unreachable/missing (fail-closed)
 *   500 { error, message } — unexpected script failure
 */

import { NextRequest, NextResponse } from 'next/server';
import { listCanonicalDepartments, InterviewScriptError } from '@/lib/interview/seam';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const tenant=await resolveInterviewTenant(req); const refused=refuseUnverifiedTenant(tenant); if(refused)return refused;
  if(tenant.kind==='client') {
    try { const op=queueInterviewOperation(tenant.context!,'departments',{}); const delivery=await deliverInterviewOperation(tenant.context!,op);
      return delivery.receipt ? NextResponse.json(delivery.receipt.result,{status:delivery.receipt.httpStatus}) : NextResponse.json({error:'remote_departments_unavailable',reason:delivery.reason},{status:503});
    } catch { return NextResponse.json({error:'remote_departments_unavailable'},{status:503}); }
  }

  try {
    const departments = await listCanonicalDepartments();
    return NextResponse.json(departments, { status: 200 });
  } catch (err) {
    // Exit 1 from list-canonical-departments.py means the naming map is
    // missing/broken. This is a transient infrastructure issue, not a client
    // error, so we return 503 to signal the board can degrade gracefully
    // (render cached/fallback, show 'loading', etc.).
    if (err instanceof InterviewScriptError && err.exitCode === 1) {
      return NextResponse.json(
        {
          error: 'naming_map_unavailable',
          message:
            'Unable to load the department naming map. The board will render from cached data.',
        },
        { status: 503 },
      );
    }

    // Unexpected failure (missing script, timeout, bad JSON parse, etc.).
    const message =
      err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : 'Unknown error fetching canonical departments';
    return NextResponse.json(
      {
        error: 'internal_error',
        message,
      },
      { status: 500 },
    );
  }
}
