/**
 * POST /api/social-theme/submit — F27 idempotent submission.
 *
 * Transaction seals the answer revision, flips the cycle to 'responded',
 * and writes the canonical dispatch outbox record — all in ONE SQLite
 * transaction (submitThemeSession). A double submit or replay returns the
 * ORIGINAL receipt (already_submitted: true) and writes nothing new; two
 * racing submits serialize on SQLite's single writer and the UNIQUE
 * (company_id, dedupe_key) outbox index.
 *
 * The client can only ever submit its OWN session: company/cycle derive from
 * the social-theme cookie, re-proofs against the sessions table.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  readSocialThemeCookie,
  resolveSessionRow,
  verifySessionCookie,
} from '@/lib/social-theme/theme-sessions';
import { submitThemeSession, getCycle, getPolicy } from '@/lib/social-theme/cycles';
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
    } catch { /* malformed origin — absent equivalent */ }
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
  if (!cycle) {
    return NextResponse.json({ error: 'cycle_not_found' }, { status: 404, headers });
  }
  if (cycle.state === 'skipped' || cycle.state === 'closed') {
    return NextResponse.json({ error: 'cycle_closed' }, { status: 409, headers });
  }

  const body = (await req.json().catch(() => ({}))) as {
    answers?: unknown;
    expected_revision?: unknown;
  };
  const expectedRevision = typeof body.expected_revision === 'number'
    && Number.isInteger(body.expected_revision)
    ? body.expected_revision
    : session.revision;
  const answers = typeof body.answers === 'object' && body.answers !== null
    ? body.answers as Record<string, string>
    : (JSON.parse(session.answers_json || '{}') as Record<string, string>);

  const policy = getPolicy(session.company_id);
  const result = submitThemeSession({
    companyId: session.company_id,
    cycleId: session.cycle_id,
    sessionId: session.id,
    expectedRevision,
    answers,
    destinationRef: `company:${session.company_id}`,
    policy: {
      mode: policy?.mode || 'standard',
      budgetUsd: policy?.budget_usd ?? null,
      approvalPolicy: policy?.approval_policy || 'client-approve',
    },
  });

  if ('kind' in result) {
    if (result.kind === 'conflict') {
      return NextResponse.json(
        {
          error: 'revision_conflict',
          server: {
            revision: result.session.revision,
            answers: JSON.parse(result.session.answers_json || '{}'),
            saved_at: result.session.saved_at,
          },
        },
        { status: 409, headers },
      );
    }
    if (result.kind === 'invalid') {
      return NextResponse.json({ error: 'invalid_answers' }, { status: 400, headers });
    }
    return NextResponse.json({ error: 'session_not_found' }, { status: 404, headers });
  }

  return NextResponse.json(
    {
      ok: true,
      receipt: {
        receipt_id: result.receiptId,
        cycle_id: result.cycleId,
        revision: result.revision,
        submitted_at: result.submittedAt,
      },
      already_submitted: result.alreadySubmitted,
      // The real work-task stage is surfaced by the progress screen through
      // the campaign board's canonical task state (SPEC: one canonical task).
      next_step: 'production_started',
    },
    { headers },
  );
}