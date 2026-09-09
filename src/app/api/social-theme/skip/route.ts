/**
 * POST /api/social-theme/skip — F27 "skip this week".
 *
 * Closes ONLY this week's cycle (state 'skipped'); other weeks are untouched
 * and week 2's invitation still fires (QC-F27: skip week1 still invites
 * week2). Skipped cycles cannot be submitted afterwards.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  readSocialThemeCookie,
  resolveSessionRow,
  verifySessionCookie,
} from '@/lib/social-theme/theme-sessions';
import { skipCycle, getCycle } from '@/lib/social-theme/cycles';
import { verifyCsrfToken } from '@/lib/csrf-protection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'private, no-store' };

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
    } catch { /* malformed origin */ }
  }
  const grant = await verifySessionCookie(readSocialThemeCookie(req));
  if (!grant) {
    return NextResponse.json({ error: 'social_theme_session_required' }, { status: 403, headers });
  }
  const session = resolveSessionRow(grant);
  if (!session) {
    return NextResponse.json({ error: 'social_theme_session_required' }, { status: 403, headers });
  }
  const cycle = getCycle(session.cycle_id, session.company_id);
  if (!cycle) return NextResponse.json({ error: 'cycle_not_found' }, { status: 404, headers });
  if (cycle.state === 'responded') {
    return NextResponse.json({ error: 'cycle_already_responded' }, { status: 409, headers });
  }
  const ok = skipCycle(session.company_id, session.cycle_id);
  if (!ok) {
    return NextResponse.json({ error: 'cycle_not_skippable' }, { status: 409, headers });
  }
  return NextResponse.json(
    {
      ok: true,
      week_skipped: cycle.week_start_local,
      note: 'Only this week was skipped. Next week\'s invitation still arrives on your usual schedule.',
    },
    { headers },
  );
}