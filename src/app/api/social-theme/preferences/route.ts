/**
 * GET + PATCH /api/social-theme/preferences — F27 explicit pause/resume +
 * policy display.
 *
 * GET (session or operator): the company's policy row — mode, budget,
 * reminder day/time, paused flag, approval/evergreen policy, enabled
 * accounts. Pause/resume is an EXPLICIT preference (reminders_paused) and
 * never mutates cycle rows or future scheduling semantics (SPEC: skip vs
 * pause are distinct controls).
 *
 * PATCH: operator/service can update policy choices (bumps policy_revision);
 * a logged-in mini-app session may toggle reminders_paused only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext, TenantAccessError } from '@/lib/auth/tenant-context';
import {
  getPolicy,
  setRemindersPaused,
  updatePolicy,
} from '@/lib/social-theme/cycles';
import {
  readSocialThemeCookie,
  resolveSessionRow,
  verifySessionCookie,
} from '@/lib/social-theme/theme-sessions';
import { verifyCsrfToken } from '@/lib/csrf-protection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'private, no-store' };

function policyView(p: ReturnType<typeof getPolicy>) {
  if (!p) return null;
  return {
    policy_revision: p.policy_revision,
    mode: p.mode,
    budget_usd: p.budget_usd,
    role_model: p.role_model,
    provider: p.provider,
    reminder_day: p.reminder_day,
    reminder_time: p.reminder_time,
    reminders_paused: p.reminders_paused === 1,
    approval_policy: p.approval_policy,
    evergreen_policy: p.evergreen_policy,
    enabled_account_ids: JSON.parse(p.enabled_account_ids || '[]') as string[],
  };
}

export async function GET(req: NextRequest) {
  try {
    // Session path (the mini-app settings view).
    const grant = await verifySessionCookie(readSocialThemeCookie(req));
    if (grant) {
      const session = resolveSessionRow(grant);
      if (session) {
        return NextResponse.json({ company_id: session.company_id, policy: policyView(getPolicy(session.company_id)) }, { headers });
      }
    }
    // Operator path.
    const context = await resolveTenantContext(req);
    const url = new URL(req.url);
    const companyId = url.searchParams.get('company_id') || (context.kind === 'self' ? '' : context.companyId);
    if (!companyId) {
      return NextResponse.json({ error: 'company_id_required' }, { status: 400, headers });
    }
    return NextResponse.json({ company_id: companyId, policy: policyView(getPolicy(companyId)) }, { headers });
  } catch (error) {
    if (error instanceof TenantAccessError) {
      return NextResponse.json({ error: 'social_theme_session_required' }, { status: 403, headers });
    }
    return NextResponse.json({ error: 'preferences_unavailable' }, { status: 503, headers });
  }
}

export async function PATCH(req: NextRequest) {
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
    } catch { /* malformed origin */ }
  }
  try {
    const body = (await req.json().catch(() => ({}))) as {
      reminders_paused?: unknown;
      mode?: unknown;
      budget_usd?: unknown;
      reminder_day?: unknown;
      reminder_time?: unknown;
      evergreen_policy?: unknown;
    };
    // Session path: pause/resume toggle only.
    const grant = await verifySessionCookie(readSocialThemeCookie(req));
    if (grant) {
      const session = resolveSessionRow(grant);
      if (session) {
        if (typeof body.reminders_paused !== 'boolean') {
          return NextResponse.json({ error: 'reminders_paused_boolean_required' }, { status: 400, headers });
        }
        setRemindersPaused(session.company_id, body.reminders_paused);
        return NextResponse.json({ company_id: session.company_id, policy: policyView(getPolicy(session.company_id)) }, { headers });
      }
    }
    // Operator path: full policy update.
    const context = await resolveTenantContext(req);
    if (context.kind !== 'self' || context.subject !== 'operator:api') {
      return NextResponse.json({ error: 'operator_service_required' }, { status: 403, headers });
    }
    const companyId = typeof (body as { company_id?: unknown }).company_id === 'string'
      ? (body as { company_id: string }).company_id.trim()
      : '';
    if (!companyId) {
      return NextResponse.json({ error: 'company_id_required' }, { status: 400, headers });
    }
    const patch: Record<string, unknown> = {};
    if (typeof body.mode === 'string' && ['standard', 'ultra'].includes(body.mode)) patch.mode = body.mode;
    if (typeof body.budget_usd === 'number' && Number.isFinite(body.budget_usd) && body.budget_usd >= 0) patch.budget_usd = body.budget_usd;
    if (typeof body.reminder_day === 'string' && /^[a-zA-Z]{3,9}$/.test(body.reminder_day)) patch.reminder_day = body.reminder_day;
    if (typeof body.reminder_time === 'string' && /^\d{2}:\d{2}$/.test(body.reminder_time)) patch.reminder_time = body.reminder_time;
    if (typeof body.evergreen_policy === 'string' && ['off', 'on'].includes(body.evergreen_policy)) patch.evergreen_policy = body.evergreen_policy;
    if (typeof body.reminders_paused === 'boolean') patch.reminders_paused = body.reminders_paused ? 1 : 0;
    updatePolicy(companyId, patch);
    return NextResponse.json({ company_id: companyId, policy: policyView(getPolicy(companyId)) }, { headers });
  } catch (error) {
    if (error instanceof TenantAccessError) {
      return NextResponse.json({ error: 'operator_service_required' }, { status: 403, headers });
    }
    return NextResponse.json({ error: 'preferences_unavailable' }, { status: 503, headers });
  }
}