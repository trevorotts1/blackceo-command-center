/**
 * GET + PATCH /api/social-theme/session — F27 draft state.
 *
 * GET: server derives company/cycle from the HttpOnly social-theme session
 * cookie (resolveSessionRow re-proofs the grant against the sessions table;
 * query-string ids are NEVER trusted). Returns cycle metadata (week, state),
 * saved answers + revision, and this client's theme suggestions drawn ONLY
 * from its own submitted history.
 *
 * PATCH: revision-checked autosave. Body { answers, expectedRevision } —
 * schema-validated; on revision mismatch returns 409 with the SERVER's
 * current row (conflict information WITHOUT losing either answer; the
 * client surfaces "the client decides" resolution per SPEC). Submitted
 * sessions are immutable (409).
 *
 * Mutating cookie-authenticated requests enforce MR-23 IN THE ROUTE (the
 * middleware exempts /api/social-theme/* — these routes verify their own
 * narrow capability): the signed mc_csrf_token cookie AND same-origin.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  readSocialThemeCookie,
  resolveSessionRow,
  verifySessionCookie,
  type SocialThemeGrant,
} from '@/lib/social-theme/theme-sessions';
import { verifyCsrfToken } from '@/lib/csrf-protection';
import {
  getCycle,
  listCycles,
  patchDraftAnswers,
  themeSuggestions,
  validateAnswers,
} from '@/lib/social-theme/cycles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'private, no-store' };

/** Company identity of the caller — cookie-granted, re-proofs against DB. */
async function requireSession(
  req: NextRequest,
): Promise<{ grant: SocialThemeGrant; session: NonNullable<ReturnType<typeof resolveSessionRow>> } | null> {
  const grant = await verifySessionCookie(readSocialThemeCookie(req));
  if (!grant) return null;
  const session = resolveSessionRow(grant);
  if (!session) return null;
  return { grant, session };
}

export async function GET(req: NextRequest) {
  const auth = await requireSession(req);
  if (!auth) {
    return NextResponse.json(
      { error: 'social_theme_session_required', renew_hint: 'Request a fresh link from your assistant conversation.' },
      { status: 403, headers },
    );
  }
  const { session } = auth;
  const cycle = getCycle(session.cycle_id, session.company_id);
  if (!cycle) {
    return NextResponse.json({ error: 'cycle_not_found' }, { status: 404, headers });
  }
  const answers = JSON.parse(session.answers_json || '{}') as Record<string, string>;
  return NextResponse.json(
    {
      company_id: session.company_id,
      cycle: {
        id: cycle.id,
        week_start_local: cycle.week_start_local,
        timezone: cycle.timezone,
        state: cycle.state,
      },
      session: {
        id: session.id,
        revision: session.revision,
        status: session.status,
        saved_at: session.saved_at,
        submitted_at: session.submitted_at,
      },
      answers,
      // Client A can only ever see client A's approved history.
      suggestions: themeSuggestions(session.company_id),
      history: listCycles(session.company_id, 12).map((c) => ({
        week_start_local: c.week_start_local,
        state: c.state,
      })),
    },
    { headers },
  );
}

export async function PATCH(req: NextRequest) {
  // The route owns its own authz (middleware exempts /api/social-theme/*);
  // mutating cookie-authenticated requests therefore enforce BOTH halves of
  // MR-23 here: the signed CSRF cookie AND same-origin.
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
    } catch { /* malformed origin header — treat as absent */ }
  }
  const auth = await requireSession(req);
  if (!auth) {
    return NextResponse.json({ error: 'social_theme_session_required' }, { status: 403, headers });
  }
  const { session } = auth;
  if (session.status !== 'draft') {
    return NextResponse.json(
      { error: 'session_already_submitted', receipt_hint: 'Use the submitted receipt; this draft is sealed.' },
      { status: 409, headers },
    );
  }
  const body = (await req.json().catch(() => null)) as {
    answers?: unknown;
    expected_revision?: unknown;
  } | null;
  if (!body || typeof body.expected_revision !== 'number' || !Number.isInteger(body.expected_revision)) {
    return NextResponse.json({ error: 'expected_revision_required' }, { status: 400, headers });
  }
  const answersCheck = validateAnswers(body.answers);
  if (!answersCheck.ok) {
    return NextResponse.json({ error: answersCheck.error }, { status: 400, headers });
  }
  const result = patchDraftAnswers(
    session.id,
    session.company_id,
    body.expected_revision,
    answersCheck.normalized,
  );
  switch (result.kind) {
    case 'saved':
      return NextResponse.json(
        {
          ok: true,
          revision: result.session.revision,
          saved_at: result.session.saved_at,
          status: result.session.status,
        },
        { headers },
      );
    case 'conflict':
      // 409 carries the SERVER's current answers + revision — the client
      // asks the client (human) to resolve; nothing is silently overwritten.
      return NextResponse.json(
        {
          error: 'revision_conflict',
          server: {
            revision: result.session.revision,
            answers: JSON.parse(result.session.answers_json || '{}'),
            saved_at: result.session.saved_at,
          },
          client: { revision: body.expected_revision },
        },
        { status: 409, headers },
      );
    case 'immutable':
      return NextResponse.json({ error: 'session_already_submitted' }, { status: 409, headers });
    case 'invalid':
      return NextResponse.json({ error: result.error }, { status: 400, headers });
    default:
      return NextResponse.json({ error: 'session_not_found' }, { status: 404, headers });
  }
}