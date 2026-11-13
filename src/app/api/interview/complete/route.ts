import { queueInterviewOperation } from '@/lib/interview/remote-store';
import { deliverInterviewOperation, drainInterviewOperations } from '@/lib/interview/remote-protocol';
/**
 * POST /api/interview/complete
 *
 * The build TRIGGER for the /interview surface. This is the exact button the
 * Telegram agent presses at the end of a Skill-23 interview, exposed to the web
 * skin — and NOTHING MORE. Its whole job is:
 *
 *   1. PRE-FLIGHT (defense-in-depth, mirrors server gates #2/#3/#8 via P0-1):
 *      confirm the answers transcript is genuine, decision coverage is complete,
 *      and there are zero un-provenanced declines. If anything is missing, refuse
 *      with a structured 409 that lists exactly what is missing — the UI's own
 *      gate flags should already make this unreachable, but the route fails closed.
 *
 *   2. TRIGGER: execFile `update-interview-state.sh --complete` (via the P0-1 seam
 *      wrapper) — the SAME script the Telegram agent presses. That script owns:
 *        • setting `interviewComplete` (+ interviewCompletedAt),
 *        • seeding interviewQc.status=pending + the *Status pendings + the
 *          departments=[] sentinel + buildKickRequestedAt,
 *        • auto-running qc-interview-completion.py --write-state,
 *        • firing the ONE [WORKFORCE-RESUME] build-kick — and ONLY when
 *          interviewQc.status==pass.
 *
 *   3. REPORT: re-read the canonical build-state FILE (files are the single source
 *      of truth) and return interviewQc.status as { status: 'pass' | 'needs-review'
 *      | 'fail', ... } so the client can redirect / render the right screen.
 *
 * HARD CONSTRAINTS (see P0-1 doctrine):
 *   • This route NEVER hand-writes interviewComplete (only the script does).
 *   • This route talks to the OpenClaw gateway through exactly ONE call —
 *     kickWorkforceBuild(), after a pass or needs-review result, fired without
 *     waiting on it. The kick is what starts the agent turn a script cannot
 *     (BU-30); it does nothing unless the state itself says build-eligible, and
 *     the 15-minute job repeats it if this one is lost.
 *   • It adds NO new trigger path: the only mutating call is the seam's
 *     updateInterviewState({ complete: true }) wrapper around the shell script.
 *   • Reads come from the canonical files, never a divergent DB copy.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveInterviewTenant, refuseUnverifiedTenant } from '@/lib/interview/tenant';
import {
  InterviewScriptError,
  InterviewScriptMissingError,
  getInterviewGateSnapshot,
  readBuildState,
  readInterviewQcStatus,
  updateInterviewState,
  type BuildState,
  type InterviewGateSnapshot,
} from '@/lib/interview/seam';
import { kickWorkforceBuild } from '@/lib/jobs/workforce-build-kick';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Optional overrides so the server-side coverage computation stays consistent
 * with what the board (P2-5) and the /api/interview/state gate route (P0-4)
 * used. When omitted, coverage is computed against the bare canonical floor
 * (mandatory + universal-primary) — the strictest expected set — so the
 * pre-flight can only ever be MORE conservative than the UI, never laxer.
 *
 * `retryKick` is the recovery path for the rare case where the build kick fires
 * into a down gateway or the [WORKFORCE-RESUME] dispatch is lost after the
 * interview was already marked complete. When true and the interview is already
 * complete, the idempotency guard is bypassed and the completion script is
 * re-pressed — re-running QC and re-firing the kick — so the operator has a
 * one-click retry from the UI rather than a dead-end "already complete" state.
 */
const requestSchema = z
  .object({
    customDeptIds: z.array(z.string().min(1)).max(200).optional(),
    implicitYesCustomIds: z.array(z.string().min(1)).max(200).optional(),
    retryKick: z.boolean().optional(),
  })
  .strict()
  .optional();

/** What the client redirects into on a passing QC (already exists, Wave 3 #9). */
const BUILD_REDIRECT = '/onboarding/building';

/** The one completion message, shown for pass and needs-review alike. */
const DONE_MESSAGE =
  'You are done. Your company is being built now. This usually takes 30 to 45 minutes. We will message you when it is ready.';

/* -------------------------------------------------------------------------- */
/* pre-flight                                                                  */
/* -------------------------------------------------------------------------- */

interface MissingItem {
  /** which server gate this maps to (#2 transcript / #3 coverage / #8 declines). */
  gate: 'transcript' | 'decision_coverage' | 'unprovenanced_declines';
  reason: string;
  /** dept ids still needing a provenanced decision (gate #3). */
  departments?: string[];
  /** dept ids whose decline is not provenanced and would be rejected (gate #8). */
  rejections?: string[];
}

/**
 * Build the `missing[]` list from a gate snapshot. Empty array === ready to
 * press the trigger. Mirrors the three server gates so the 409 tells the owner
 * (or the UI) precisely what still blocks the build.
 *
 * AI Workforce standard-first (PHASE 6 item 3): gate #3 (decision_coverage)
 * RELAXES on the standard-first lane — the snapshot's expected set already
 * contains ONLY recorded declines + customs there (KEEPS are implicit; the
 * seam's computeExpectedDecisionIds standardFirst branch), so a prebuilt box
 * with no adds and no declines passes gate #3 with zero decisions. Gates #2
 * (genuine transcript) and #8 (un-provenanced declines) stay STRICT — the
 * edit-mode interview still needs a genuine transcript, and a recorded decline
 * still needs full provenance. The 409 mapping for the script's exit 87/88
 * below is unchanged.
 */
function collectMissing(snapshot: InterviewGateSnapshot): MissingItem[] {
  const missing: MissingItem[] = [];
  const { flags, answers, coverage, canonical, standardFirst } = snapshot;

  if (!flags.genuineTranscriptReady) {
    missing.push({
      gate: 'transcript',
      reason: answers.hasSyntheticHeader
        ? 'The answers file is a non-interactive (synthetic) transcript, which does not count as a genuine interview.'
        : !answers.exists
          ? 'No interview transcript has been recorded yet.'
          : `The interview transcript is too thin (found ${answers.qBlockCount} answered question(s); a genuine interview needs more).`,
    });
  }

  if (!flags.decisionCoverageComplete) {
    // If the canonical floor could not be resolved we fail closed with a clear
    // reason rather than pretending coverage is complete.
    missing.push({
      gate: 'decision_coverage',
      reason: !canonical
        ? 'Could not load the live department floor to verify decision coverage.'
        : standardFirst
          ? 'Some added or removed departments still need a provenanced decision (kept departments need none).'
          : 'Some departments still need a yes / no / later decision on the board.',
      departments: coverage.missing.length ? coverage.missing : undefined,
    });
  }

  if (!flags.noUnprovenancedDeclines) {
    missing.push({
      gate: 'unprovenanced_declines',
      reason:
        'One or more department declines are missing provenance and would be rejected by the build enforcer.',
      rejections: coverage.rejections.length ? coverage.rejections : undefined,
    });
  }

  return missing;
}

/* -------------------------------------------------------------------------- */
/* QC status → response mapping                                                */
/* -------------------------------------------------------------------------- */

type QcOutcome = 'pass' | 'needs-review' | 'fail';

/** Normalize the many spellings the state / scripts might use for QC status. */
function normalizeQcStatus(raw: string): QcOutcome | 'pending' | 'unknown' {
  const s = raw.trim().toLowerCase();
  if (s === 'pass' || s === 'passed' || s === 'ok') return 'pass';
  if (s === 'needs-review' || s === 'needs_review' || s === 'review' || s === 'warn') {
    return 'needs-review';
  }
  if (s === 'fail' || s === 'failed' || s === 'error') return 'fail';
  if (s === 'pending' || s === '') return 'pending';
  return 'unknown';
}

/**
 * Pull human-readable QC failure reasons out of interviewQc for the drill-back
 * screen. The exact shape qc-interview-completion.py writes is not strongly
 * typed here, so we tolerate the common shapes (reasons / failures / issues /
 * findings / notes as string | string[] | {message}[]) and de-dupe.
 */
function extractQcReasons(state: BuildState | null): string[] {
  const qc = state?.interviewQc as Record<string, unknown> | undefined;
  if (!qc) return [];
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
    else if (v && typeof v === 'object') {
      const m = (v as Record<string, unknown>).message ?? (v as Record<string, unknown>).reason;
      if (typeof m === 'string' && m.trim()) out.push(m.trim());
    }
  };
  for (const key of ['reasons', 'failures', 'issues', 'findings', 'errors', 'notes']) {
    const v = qc[key];
    if (Array.isArray(v)) v.forEach(push);
    else if (v != null) push(v);
  }
  return Array.from(new Set(out));
}

/**
 * The question prompts a "not enough yet" reason points back to. Copied from
 * the final question set character for character; used only to name the
 * question inside a plain sentence, never to change its wording.
 */
const QUESTION_PROMPTS: Record<string, string> = {
  brand_evokes:
    'When someone sees your brand for the first time, what should they feel in the first five seconds?',
  customer_feeling: 'After working with you, how should a customer feel?',
  brand_descriptors: 'Give me three words a happy customer would use to describe you.',
  ideal_customer: 'Who is your best kind of customer?',
  unique_differentiator: 'Why do customers pick you instead of someone else?',
};

/** Fallback for a QC reason that matches no known key (never the raw string). */
const GENERIC_REASON = 'One of your answers needs another look.';

/**
 * Substring → plain sentence. Checked in order, so the most specific key wins
 * (a "Missing mandatory fields: company_name" line names the company name).
 */
const PLAIN_REASON_RULES: Array<{ key: string; sentence: string }> = [
  { key: 'company_name', sentence: 'Please check your company name.' },
  { key: 'industry', sentence: 'Please check what kind of business it is.' },
  ...Object.entries(QUESTION_PROMPTS).map(([id, prompt]) => ({
    key: id,
    sentence: `Please add a little more to: ${prompt}`,
  })),
  {
    key: 'disagree',
    sentence: 'We are double-checking your saved answers. Please press the button again in a minute.',
  },
  { key: 'Missing mandatory fields', sentence: 'A required question is still open.' },
  { key: 'departments[at-least-one]', sentence: 'Please confirm your team on the team screen.' },
];

/**
 * Turn the QC verdict's raw reason strings into sentences an owner can act on.
 * A reason that matches no key becomes GENERIC_REASON — the raw gate string is
 * never shown to a client. De-duped, order preserved.
 */
function plainReasons(state: BuildState | null): string[] {
  const raw = state?.interviewQc?.reasons;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const hit = PLAIN_REASON_RULES.find((rule) => entry.includes(rule.key));
    out.push(hit ? hit.sentence : GENERIC_REASON);
  }
  return Array.from(new Set(out));
}

/** The question ids the gate says are still open (drives "Answer now"). */
function missingQuestionIds(state: BuildState | null): string[] {
  const raw = state?.interviewQc?.missingQuestionIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

/* -------------------------------------------------------------------------- */
/* handler                                                                     */
/* -------------------------------------------------------------------------- */

export async function POST(req: NextRequest) {
  // FAIL CLOSED for client tenants (TENANT-INTERVIEW-FIX phase 2). This route
  // presses update-interview-state.sh --complete and kicks the workforce build
  // — on THIS box, the operator's. Run by a remote client it would mark the
  // OPERATOR's interview complete and start the OPERATOR's build from the
  // client's data. Refuse until a per-client build path exists; a 501 is
  // strictly better than running the wrong box's build.
  const tenant = await resolveInterviewTenant(req);
  const refusedTenant = refuseUnverifiedTenant(tenant);
  if (refusedTenant) return refusedTenant;
  if (tenant.kind === 'client') {
    try {
      const raw=await req.text();
      const payload=requestSchema.parse(raw.trim()?JSON.parse(raw):undefined) || {};
      const op=queueInterviewOperation(tenant.context!, 'complete', payload, req.headers.get('idempotency-key') || undefined);
      await drainInterviewOperations(tenant.context!);
      const delivery=await deliverInterviewOperation(tenant.context!,op);
      if(delivery.receipt) {
        if(delivery.receipt.result?.status==='pass' && !delivery.receipt.buildId)return NextResponse.json({status:'needs-review',message:'Your interview was acknowledged. We are waiting for your installation to identify the build.',operationId:op.operation_id},{status:202});
        return NextResponse.json({...delivery.receipt.result,operationId:op.operation_id,buildId:delivery.receipt.buildId,installationId:delivery.receipt.installationId},{status:delivery.receipt.httpStatus});
      }
      return NextResponse.json({status:'needs-review',message:'Your request is saved and waiting for your installation to acknowledge it.',handoff:delivery,operationId:op.operation_id},{status:202});
    } catch { return NextResponse.json({error:'complete_not_saved',message:'The request could not be saved. Please retry.'},{status:503}); }
  }

  // Body is optional; tolerate an empty/absent body.
  let body: z.infer<typeof requestSchema>;
  try {
    const text = await req.text();
    body = text.trim() ? requestSchema.parse(JSON.parse(text)) : undefined;
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid_request', detail: err instanceof Error ? err.message : 'bad body' },
      { status: 400 },
    );
  }

  const coverageOpts = {
    customDeptIds: body?.customDeptIds,
    implicitYesCustomIds: body?.implicitYesCustomIds,
  };

  // -- Idempotency: if the interview is already complete, do NOT re-press the
  //    script unless the caller explicitly requested a retryKick (recovery path
  //    for a lost [WORKFORCE-RESUME] dispatch). Report the current, authoritative
  //    QC status from the canonical file instead when retryKick is absent/false.
  const priorState = readBuildState();
  if (priorState?.interviewComplete === true && !body?.retryKick) {
    return finalResponse(priorState, { alreadyComplete: true });
  }

  // -- Pre-flight (gates #2/#3/#8). Fail closed with a structured 409.
  let snapshot: InterviewGateSnapshot;
  try {
    snapshot = await getInterviewGateSnapshot(coverageOpts);
  } catch (err) {
    return NextResponse.json(
      {
        error: 'preflight_failed',
        message: `Could not verify interview readiness: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      { status: 500 },
    );
  }

  const missing = collectMissing(snapshot);
  if (missing.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: 'interview_incomplete',
        message: 'The interview cannot be completed yet — some items are still missing.',
        missing,
      },
      { status: 409 },
    );
  }

  // -- TRIGGER: press the exact same script the Telegram agent presses. The
  //    script owns interviewComplete, the QC auto-run, and the single kick.
  let scriptError: InterviewScriptError | null = null;
  try {
    await updateInterviewState({ complete: true });
  } catch (err) {
    if (err instanceof InterviewScriptMissingError) {
      return NextResponse.json(
        {
          error: 'script_missing',
          message:
            'The interview completion script is not installed on this box. An operator has been notified.',
          operatorPing: true,
        },
        { status: 500 },
      );
    }
    if (err instanceof InterviewScriptError) {
      // exit 87 (INTERVIEW_PENDING) / 88 (RECONCILIATION_PENDING): the script's
      // own fail-closed enforcement disagreed with our pre-flight — surface it as
      // a 409 so the UI re-checks the gates rather than treating it as a crash.
      if (err.exitCode === 87 || err.exitCode === 88) {
        // Name what to fix instead of relaying the gate's own sentence: re-read
        // the canonical file for the QC reasons and the open question ids.
        const state = readBuildState();
        return NextResponse.json(
          {
            ok: false,
            error: 'interview_incomplete',
            reasons: plainReasons(state),
            missingQuestionIds: missingQuestionIds(state),
            missing: collectMissing(await getInterviewGateSnapshot(coverageOpts).catch(() => snapshot)),
          },
          { status: 409 },
        );
      }
      // exit 89 (rate limited / too many tries): say what to do, not that it broke.
      if (err.exitCode === 89) {
        return NextResponse.json(
          {
            error: 'try_again_later',
            message: 'Please wait a few minutes and press the button again.',
          },
          { status: 429 },
        );
      }
      // exit 2 (needs-review) / exit 3 (fail): NOT a crash — the QC verdict is
      // carried in the state file, which we read authoritatively below. Remember
      // the error so an inconclusive state can fall back to the exit code.
      scriptError = err;
    } else {
      return NextResponse.json(
        {
          error: 'trigger_failed',
          message: `The interview completion trigger failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          operatorPing: true,
        },
        { status: 500 },
      );
    }
  }

  // -- REPORT: re-read the canonical FILE (source of truth) for the QC verdict.
  const finalState = readBuildState();
  return finalResponse(finalState, { alreadyComplete: false, scriptError });
}

/**
 * Map the authoritative interviewQc.status (from the canonical file) to the
 * route's response contract. Never returns `pass` unless the file says pass —
 * so the client only redirects to /onboarding/building when the script has
 * actually fired (or is entitled to fire) the build kick.
 */
function finalResponse(
  state: BuildState | null,
  ctx: { alreadyComplete: boolean; scriptError?: InterviewScriptError | null },
): NextResponse {
  const rawStatus = readInterviewQcStatus(state);
  let outcome = normalizeQcStatus(rawStatus);

  // If the file is inconclusive but the script exited with a QC code, trust it.
  if ((outcome === 'pending' || outcome === 'unknown') && ctx.scriptError) {
    if (ctx.scriptError.exitCode === 2) outcome = 'needs-review';
    else if (ctx.scriptError.exitCode === 3) outcome = 'fail';
  }

  // BU-30: the interview is build-eligible. Start the agent turn a script cannot
  // — fired WITHOUT waiting on it, so a slow or down gateway never delays this
  // response. kickWorkforceBuild() decides from the state files whether there is
  // anything to start, and the 15-minute job repeats it if this one is lost.
  if (outcome === 'pass' || outcome === 'needs-review') {
    void kickWorkforceBuild('interview-complete').catch(() => {});
  }

  switch (outcome) {
    case 'pass':
      return NextResponse.json({
        status: 'pass',
        redirect: BUILD_REDIRECT,
        alreadyComplete: ctx.alreadyComplete,
      });

    case 'fail':
      return NextResponse.json({
        status: 'fail',
        reasons: extractQcReasons(state),
        alreadyComplete: ctx.alreadyComplete,
      });

    case 'needs-review':
      // needs-review is the pass outcome from the owner's side: the build runs.
      return NextResponse.json({
        status: 'needs-review',
        redirect: BUILD_REDIRECT,
        operatorPing: true,
        message: DONE_MESSAGE,
        alreadyComplete: ctx.alreadyComplete,
      });

    default:
      // interviewComplete is set but QC has not resolved yet (still pending): the
      // auto-QC runs synchronously inside the script, so this is unexpected. Treat
      // it as needs-review (gentle + operator ping) — never a false `pass`.
      return NextResponse.json({
        status: 'needs-review',
        redirect: BUILD_REDIRECT,
        operatorPing: true,
        message: DONE_MESSAGE,
        qcStatus: rawStatus,
        alreadyComplete: ctx.alreadyComplete,
      });
  }
}
