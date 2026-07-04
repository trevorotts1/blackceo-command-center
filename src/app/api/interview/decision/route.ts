/**
 * POST /api/interview/decision  (P2-4)
 *
 * The Phase-5.5 department-board write path — and the ONLY sanctioned way the
 * web surface records an owner's YES / NO / LATER on a department.
 *
 * It presses the EXACT same button the Telegram agent presses:
 *
 *   record-dept-decision.sh --dept <id> --decision yes|no|later \
 *       --source owner-interview --by <ownerId> --session <interviewSessionId>
 *
 * (via seam.recordDeptDecision → execFile). The script writes the fully
 * provenanced object {decision, source, decidedAt, decidedBy, sessionId} into
 * canonicalReconciliation.decisions[dept]. This route NEVER hand-writes a
 * decision, NEVER touches the state file with jq/TS, and NEVER records a bare
 * string — so every downstream gate is inherited for free:
 *
 *   • a NO carries provenance → canonical_decline classifies it "declined"
 *     (honored, the dept is NOT built), not a "rejection" that force-adds it back;
 *   • an un-provenanced / bare-string decline is impossible from this path
 *     (gate #8), because the script is the sole writer and always attaches
 *     {source, decidedAt, decidedBy, sessionId};
 *   • a decision with an EMPTY decidedBy is refused up front (a "no" with empty
 *     provenance is IGNORED by the enforcer, so it must never be recorded).
 *
 * Provenance sourcing (OQ-5), never hardcoded / never empty:
 *   decidedBy ← Cf-Access-Authenticated-User-Email (or the middleware-injected
 *               x-operator-email mirror) → else the clients-row identity.
 *   sessionId ← the caller's sessionId, else the stable interviewSessionId the
 *               seam persists in build-state (getOrCreateInterviewSessionId()).
 *
 * Error mapping:
 *   400 invalid_request   — bad body (missing dept / bad decision verb)
 *   400 unknown_dept      — record-dept-decision.sh exit 1 (unknown/misspelled id)
 *   401 owner_unresolved  — no CF-Access email and no clients row → no decidedBy
 *   503 script_unavailable — the Skill-23 script is not installed on this box
 *   502 decision_write_failed — any other non-zero script exit
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  recordDeptDecision,
  getOrCreateInterviewSessionId,
  InterviewScriptError,
  InterviewScriptMissingError,
} from '@/lib/interview/seam';
import { getClientContext } from '@/lib/clients';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const requestSchema = z.object({
  // Canonical department id (e.g. "marketing"). Validated for existence by the
  // script itself — an unknown/misspelled id surfaces as exit 1 → 400 here.
  dept: z.string().min(1).max(128),
  // The owner's verb on this department. Exactly the three the script accepts;
  // a NO becomes a provenanced canonical_decline "declined", never a rejection.
  decision: z.enum(['yes', 'no', 'later']),
  // Optional: pin to an existing interview session id. When absent, the seam
  // resolves/persists the stable interviewSessionId from build-state.
  sessionId: z.string().min(1).max(128).optional(),
});

/**
 * Resolve the owner identity for --by, NEVER hardcoded and NEVER empty:
 *   1. the Cloudflare-Access authenticated email (the real person), or the
 *      middleware-injected `x-operator-email` mirror of it;
 *   2. else the clients-row identity (this box's client id).
 * Returns '' only when neither is available — the caller then refuses with 401
 * rather than recording a decision with un-honorable (empty) provenance.
 */
function resolveOwnerId(req: NextRequest): string {
  const email =
    req.headers.get('Cf-Access-Authenticated-User-Email') ||
    req.headers.get('x-operator-email');
  if (email && email.trim()) return email.trim();

  try {
    const client = getClientContext();
    if (client?.id && client.id.trim()) return client.id.trim();
  } catch {
    // DB not seeded / outside request scope — fall through to the 401 refusal.
  }
  return '';
}

export async function POST(req: NextRequest) {
  // 1) Validate the body.
  let body: z.infer<typeof requestSchema>;
  try {
    body = requestSchema.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      {
        error: 'invalid_request',
        detail: err instanceof Error ? err.message : 'bad body',
      },
      { status: 400 },
    );
  }

  // 2) Resolve provenance. An empty decidedBy is refused BEFORE any write so a
  //    "no" can never be recorded in a shape the enforcer would ignore.
  const decidedBy = resolveOwnerId(req);
  if (!decidedBy) {
    return NextResponse.json(
      {
        error: 'owner_unresolved',
        message:
          'Could not identify who is making this decision (no Cloudflare-Access ' +
          'email and no client on record). A department decision requires a ' +
          'non-empty owner so a decline stays honored.',
      },
      { status: 401 },
    );
  }

  const sessionId =
    (body.sessionId && body.sessionId.trim()) || getOrCreateInterviewSessionId();

  // 3) Press the ONE sanctioned writer. The script owns the provenance object
  //    and the canonical_decline classification; this route only relays flags.
  try {
    await recordDeptDecision({
      dept: body.dept,
      decision: body.decision,
      by: decidedBy,
      session: sessionId,
      source: 'owner-interview',
    });
  } catch (err) {
    if (err instanceof InterviewScriptMissingError) {
      return NextResponse.json(
        {
          error: 'script_unavailable',
          message:
            'The department-decision recorder is not installed on this box yet. ' +
            'Your interviewer is reconnecting — the decision was not saved.',
          script: err.script,
        },
        { status: 503 },
      );
    }
    if (err instanceof InterviewScriptError) {
      // exit 1 = unknown / misspelled department id (or the script's own empty-by
      // guard, which resolveOwnerId already prevents). Surface as a 400 so the
      // board can flag the bad id rather than a server fault.
      if (err.exitCode === 1) {
        return NextResponse.json(
          {
            error: 'unknown_dept',
            message: `"${body.dept}" is not a recognized department id.`,
            dept: body.dept,
            detail: err.stderr.trim().split('\n').slice(-1)[0] || undefined,
          },
          { status: 400 },
        );
      }
      return NextResponse.json(
        {
          error: 'decision_write_failed',
          message: 'The decision could not be saved. Please try again.',
          exitCode: err.exitCode,
          detail: err.stderr.trim().split('\n').slice(-1)[0] || undefined,
        },
        { status: 502 },
      );
    }
    // Unexpected non-script error.
    return NextResponse.json(
      {
        error: 'decision_write_failed',
        message: err instanceof Error ? err.message : 'unknown error',
      },
      { status: 502 },
    );
  }

  // 4) Success. The provenanced object now lives in build-state; echo the shape
  //    the script wrote (decidedAt is stamped by the script, so we don't invent
  //    it — the board re-reads /api/interview/state for the authoritative view).
  return NextResponse.json({
    ok: true,
    dept: body.dept,
    decision: body.decision,
    source: 'owner-interview',
    decidedBy,
    sessionId,
  });
}
