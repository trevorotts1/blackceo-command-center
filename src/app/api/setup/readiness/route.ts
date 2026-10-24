/**
 * GET  /api/setup/readiness — computed setup readiness (T-31).
 * POST /api/setup/readiness — run ONE owner action, then re-report readiness.
 *
 * Read-only GET: no mutations, no provider calls beyond the bounded gateway
 * reachability probe. POST mutates ONLY through the named action, and is gated
 * exactly like every other mutating board route: operator identity + CSRF +
 * same-origin.
 *
 * The handler never rounds an unanswerable question up. If a probe throws on
 * the way to the module, the response is an explicit 500 with the reason — an
 * empty-but-200 readiness payload would read as "nothing is wrong".
 */

import { NextRequest, NextResponse } from 'next/server';

import { requestHost, resolveTenantContext } from '@/lib/auth/tenant-context';
import { verifyCsrfToken } from '@/lib/csrf-protection';
import { computeSetupReadiness, runSetupAction } from '@/lib/readiness/setup';
import type { OwnerActionId } from '@/lib/readiness/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const headers = { 'cache-control': 'private, no-store' };

const VALID_ACTIONS: readonly OwnerActionId[] = [
  'apply_pending_migrations',
  'create_company_record',
  'create_default_workspace',
  'sync_agent_roster',
];

function hostFor(req: NextRequest): string | undefined {
  try {
    return requestHost(req);
  } catch {
    // Unparseable Host header: fall back to the module's configured default
    // rather than reporting the whole surface as broken.
    return undefined;
  }
}

/** Operator identity only, matching /api/auth/interview-ready. */
async function requireOperator(req: NextRequest): Promise<NextResponse | null> {
  try {
    const context = await resolveTenantContext(req);
    if (context.subject !== 'operator:api') {
      return NextResponse.json({ error: 'operator_required' }, { status: 403, headers });
    }
    return null;
  } catch {
    return NextResponse.json({ error: 'operator_required' }, { status: 403, headers });
  }
}

export async function GET(req: NextRequest) {
  const denied = await requireOperator(req);
  if (denied) return denied;
  try {
    const readiness = await computeSetupReadiness({ host: hostFor(req) });
    return NextResponse.json(readiness, { headers });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'setup_readiness_unavailable',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500, headers },
    );
  }
}

export async function POST(req: NextRequest) {
  if (!(await verifyCsrfToken(req.cookies.get('mc_csrf_token')?.value))) {
    return NextResponse.json({ error: 'missing_csrf_token' }, { status: 403, headers });
  }
  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return NextResponse.json({ error: 'cross_origin_forbidden' }, { status: 403, headers });
      }
    } catch {
      return NextResponse.json({ error: 'cross_origin_forbidden' }, { status: 403, headers });
    }
  }

  const denied = await requireOperator(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400, headers });
  }
  const actionId = (body as { action?: unknown } | null)?.action;
  if (typeof actionId !== 'string' || !VALID_ACTIONS.includes(actionId as OwnerActionId)) {
    return NextResponse.json(
      { error: 'invalid_action', valid: VALID_ACTIONS },
      { status: 400, headers },
    );
  }

  try {
    const options = { host: hostFor(req) };
    const result = await runSetupAction(actionId as OwnerActionId, options);
    const readiness = await computeSetupReadiness(options);
    // 409 for a refused action so a caller cannot mistake "disabled" for "done".
    return NextResponse.json(
      { result, readiness },
      { status: result.applied ? 200 : 409, headers },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: 'setup_action_failed',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500, headers },
    );
  }
}
