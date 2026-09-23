import { queueInterviewOperation } from '@/lib/interview/remote-store';
import { deliverInterviewOperation, drainInterviewOperations } from '@/lib/interview/remote-protocol';
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
 * Provenance sourcing: the verified tenant subject (resolveTenantContext —
 *   operator bearer, browser session grant, or cryptographically verified
 *   Access JWT subject). DecidedBy is never an unsigned header and never empty.
 *   sessionId ← the caller's sessionId, else the stable interviewSessionId the
 *               seam persists in build-state (getOrCreateInterviewSessionId()).
 *
 * Error mapping:
 *   400 invalid_request   — bad body (missing dept / bad decision verb)
 *   400 unknown_dept      — record-dept-decision.sh exit 1 (unknown/misspelled id)
 *   401 owner_unresolved  — no verified tenant identity → no decidedBy
 *   403 missing_csrf_token / cross_origin_forbidden — session-write forgery guard
 *   409 confirm_loss_required — floor decline without explicit loss acknowledgement
 *   503 script_unavailable — the Skill-23 script is not installed on this box
 *   502 decision_write_failed — any other non-zero script exit
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  lossWarningFor,
  recordDeptDecision,
  getOrCreateInterviewSessionId,
  InterviewScriptError,
  InterviewScriptMissingError,
} from '@/lib/interview/seam';
import { verifyCsrfToken } from '@/lib/csrf-protection';
import { refreshInterviewMirror } from '@/lib/interview/mirror';
import { resolveInterviewTenant, refuseUnverifiedTenant } from '@/lib/interview/tenant';

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
  // Floor-decline loss acknowledgement. Required to record a "no" for a floor
  // department: the client MUST have shown the route's `warning` text and the
  // owner must have explicitly confirmed. The writer still fails closed (exit
  // 2) without it, so this flag is an explicit ack relay — never auto-added by
  // the client, never defaulted true. Ignored for yes/later.
  confirmLoss: z.boolean().optional(),
});

/** Constant-time bearer compare so the CSRF-skip check is not a token oracle. */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (!a || !b) return false;
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export async function POST(req: NextRequest) {
  // Same-origin CSRF on session writes (ISR-001): the browser interview session
  // cookie authenticates this write, so a cross-site forgery must not be able
  // to record decisions. Same posture as the social-theme routes (route owns
  // its authz): the signed mc_csrf_token cookie is verified here, and the
  // same-origin check treats a malformed origin as a refusal, never as absent.
  // Operator bearer (`operator:api`) callers skip this — they authenticate via
  // the Authorization header, not the cookie, and carry no CSRF surface.
  // Tenant resolution is NOT trusted for the skip: the Authorization header is
  // checked directly, so a forged tenant context can never waive the check.
  const authHeader = req.headers.get('authorization') || '';
  const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
  const isOperatorBearer =
    !!bearer && !!process.env.MC_API_TOKEN && timingSafeEqualStr(bearer, process.env.MC_API_TOKEN);
  if (!isOperatorBearer) {
    if (!(await verifyCsrfToken(req.cookies.get('mc_csrf_token')?.value))) {
      return NextResponse.json({ error: 'missing_csrf_token' }, { status: 403 });
    }
    const origin = req.headers.get('origin');
    const host = req.headers.get('host');
    if (origin && host) {
      let same = false;
      try {
        same = new URL(origin).host === host;
      } catch {
        same = false;
      }
      if (!same) {
        return NextResponse.json({ error: 'cross_origin_forbidden' }, { status: 403 });
      }
    }
  }
  // FAIL CLOSED for client tenants (JANET-INTERVIEW-FIX phase 2). This route
  // presses record-dept-decision.sh against the OPERATOR's canonical build
  // state, so a remote client's department decision would be written as the
  // operator's. Client tenants queue through the remote receiver instead.
  const tenant = await resolveInterviewTenant(req);
  const refusedTenant = refuseUnverifiedTenant(tenant);
  if (refusedTenant) return refusedTenant;
  if (tenant.kind === 'client') {
    try {
      const raw=await req.text();
      const payload=requestSchema.parse(raw.trim()?JSON.parse(raw):undefined) || {};
      const op=queueInterviewOperation(tenant.context!, 'decision', payload, req.headers.get('idempotency-key') || undefined);
      await drainInterviewOperations(tenant.context!);
      const delivery=await deliverInterviewOperation(tenant.context!,op);
      if(delivery.receipt)return NextResponse.json(delivery.receipt.result,{status:delivery.receipt.httpStatus});
      return NextResponse.json({error:'decision_waiting_sync',message:'Your decision is saved and waiting to synchronize.',operationId:op.operation_id},{status:503});
    } catch { return NextResponse.json({error:'decision_not_saved',message:'The request could not be saved. Please retry.'},{status:503}); }
  }

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
  //    decidedBy is the VERIFIED tenant subject (operator bearer, session
  //    grant, or signature-verified Access JWT sub) — never an unsigned
  //    header, never empty, never invented.
  const decidedBy = tenant.context?.subject || null;
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

  // Floor-decline loss confirmation (ISR-001): a "no" for a floor department
  // costs guaranteed functionality, so the route reads the AUTHORITATIVE
  // warning (department-loss-warning.py via seam.lossWarningFor — the same
  // single source the writer enforces) and refuses to write until the owner
  // explicitly acknowledges THAT text. Never auto-confirmed: cancel leaves
  // state untouched, restore/keep stays the default, and the writer's own
  // exit-2 gate remains the backstop (a forged/omitted confirmLoss still
  // fails in the script). Non-floor declines and yes/later need no ack.
  if (body.decision === 'no') {
    const loss = await lossWarningFor(body.dept);
    if (loss.indeterminate) {
      return NextResponse.json(
        {
          error: 'loss_warning_unavailable',
          message:
            'We could not verify what removing this department would cost ' +
            '(the department map is unavailable). Nothing was recorded — ' +
            'please try again, or ask your assistant to restore the department list first.',
          dept: body.dept,
          detail: loss.reason,
        },
        { status: 503 },
      );
    }
    if (loss.warning && body.confirmLoss !== true) {
      return NextResponse.json(
        {
          error: 'confirm_loss_required',
          message:
            `Removing “${body.dept}” means: ${loss.warning} ` +
            'Confirm you still want to skip it — otherwise it stays in your workforce.',
          dept: body.dept,
          decision: body.decision,
          warning: loss.warning,
          confirmLossRequired: true,
        },
        { status: 409 },
      );
    }
  }

  // 3) Press the ONE sanctioned writer. The script owns the provenance object
  //    and the canonical_decline classification; this route only relays flags.
  try {
    await recordDeptDecision({
      dept: body.dept,
      decision: body.decision,
      by: decidedBy,
      session: sessionId,
      source: 'owner-interview',
      // Relayed ONLY when the owner explicitly acknowledged the warning above.
      // The writer re-checks independently (exit 2 without it), so a forged
      // flag with no shown warning still cannot silently drop a floor dept.
      confirmLoss: body.decision === 'no' && body.confirmLoss === true,
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
      // guard). Surface as a 400 so the board can flag the bad id rather than a
      // server fault.
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
      // exit 2 = the writer's loss-confirmation gate (floor decline without an
      // acknowledged --confirm-loss). The route pre-checks this above, so
      // reaching here means the flag was forged past the check or the map
      // changed mid-flight — fail closed with the same confirm shape, never a
      // bare write error. Nothing was recorded.
      if (err.exitCode === 2) {
        const loss = await lossWarningFor(body.dept);
        return NextResponse.json(
          {
            error: 'confirm_loss_required',
            message:
              loss.warning
                ? `Removing “${body.dept}” means: ${loss.warning} ` +
                  'Confirm you still want to skip it — otherwise it stays in your workforce.'
                : 'Removing this department needs explicit confirmation — otherwise it stays in your workforce.',
            dept: body.dept,
            decision: body.decision,
            ...(loss.warning ? { warning: loss.warning } : {}),
            confirmLossRequired: true,
          },
          { status: 409 },
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

  // 3b) READ-MIRROR refresh (P2-2). Re-sync the interview index FROM the canonical
  //     files the script just wrote. Best-effort and READ-ONLY on the files:
  //     refreshInterviewMirror never throws and never gates — a mirror failure
  //     NEVER fails this request (the decision already landed in build-state). The
  //     mirror caches NO decision authority; the board reads coverage from the
  //     files via /api/interview/state.
  try {
    refreshInterviewMirror({ sessionId, ownerId: decidedBy });
  } catch {
    // swallow — mirror is non-authoritative and must never affect the response.
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
