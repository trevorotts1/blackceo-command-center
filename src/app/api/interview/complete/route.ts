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
 *   • This route NEVER sends a [WORKFORCE-RESUME] kick and NEVER talks to the
 *     OpenClaw gateway — it does not import getOpenClawClient at all. The kick is
 *     the script's job and fires only on interviewQc.status==pass.
 *   • It adds NO new trigger path: the only mutating call is the seam's
 *     updateInterviewState({ complete: true }) wrapper around the shell script.
 *   • Reads come from the canonical files, never a divergent DB copy.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Optional overrides so the server-side coverage computation stays consistent
 * with what the board (P2-5) and the /api/interview/state gate route (P0-4)
 * used. When omitted, coverage is computed against the bare canonical floor
 * (mandatory + universal-primary) — the strictest expected set — so the
 * pre-flight can only ever be MORE conservative than the UI, never laxer.
 */
const requestSchema = z
  .object({
    customDeptIds: z.array(z.string().min(1)).max(200).optional(),
    implicitYesCustomIds: z.array(z.string().min(1)).max(200).optional(),
  })
  .strict()
  .optional();

/** What the client redirects into on a passing QC (already exists, Wave 3 #9). */
const BUILD_REDIRECT = '/onboarding/building';

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
 */
function collectMissing(snapshot: InterviewGateSnapshot): MissingItem[] {
  const missing: MissingItem[] = [];
  const { flags, answers, coverage, canonical } = snapshot;

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
      reason: canonical
        ? 'Some departments still need a yes / no / later decision on the board.'
        : 'Could not load the live department floor to verify decision coverage.',
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

/* -------------------------------------------------------------------------- */
/* handler                                                                     */
/* -------------------------------------------------------------------------- */

export async function POST(req: NextRequest) {
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
  //    script (that could re-fire the one-shot build kick). Report the current,
  //    authoritative QC status from the canonical file instead.
  const priorState = readBuildState();
  if (priorState?.interviewComplete === true) {
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
        return NextResponse.json(
          {
            ok: false,
            error: err.exitCode === 87 ? 'interview_pending' : 'reconciliation_pending',
            message:
              err.exitCode === 87
                ? 'The build refused: a genuine interview / consent is still required.'
                : 'The build refused: the department reconciliation board is incomplete.',
            missing: collectMissing(await getInterviewGateSnapshot(coverageOpts).catch(() => snapshot)),
          },
          { status: 409 },
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
      return NextResponse.json({
        status: 'needs-review',
        operatorPing: true,
        message:
          "Thanks — we're reviewing your answers. Your workforce will start building shortly; no action is needed from you.",
        alreadyComplete: ctx.alreadyComplete,
      });

    default:
      // interviewComplete is set but QC has not resolved yet (still pending): the
      // auto-QC runs synchronously inside the script, so this is unexpected. Treat
      // it as needs-review (gentle + operator ping) — never a false `pass`.
      return NextResponse.json({
        status: 'needs-review',
        operatorPing: true,
        message:
          "Thanks — we're reviewing your answers. Your workforce will start building shortly; no action is needed from you.",
        qcStatus: rawStatus,
        alreadyComplete: ctx.alreadyComplete,
      });
  }
}
