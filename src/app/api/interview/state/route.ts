/**
 * GET /api/interview/state
 *
 * The readiness + gate-flag surface for the /interview experience. Node-runtime
 * (better-sqlite3/fs are available here; the Edge middleware reads a cookie set
 * elsewhere, never this route). Returns everything the Build button, progress
 * rail, resume screen, and decision-board completion badge read:
 *
 *   • progress-rail data  — lastQuestionNumber, phasesComplete, derived percent
 *   • resume position     — nextQuestionNumber, skippedQuestions, status
 *   • decision-board readiness — coverage.complete + missing[] (expected depts)
 *   • the three UI gate flags that enable/disable "Build my company":
 *       genuineTranscriptReady   (gate #2 — genuine, non-fabricated transcript)
 *       decisionCoverageComplete (gate #3 — every expected dept has a
 *                                 provenanced decision)
 *       noUnprovenancedDeclines  (gate #8 — zero un-provenanced declines)
 *
 * DOCTRINE: reads the canonical FILES (.workforce-build-state.json,
 * interview-handoff.md, workforce-interview-answers.md) via the P0-1 seam, NOT a
 * divergent DB copy. It NEVER writes interviewComplete or a decision — this is a
 * pure read. All gate math (coverage, provenance, the live canonical floor) lives
 * in the seam so the UI gate can never drift from the build-side enforcer.
 *
 * The percent is DERIVED (schema stores none): min(100, round(q/30*100)) — the
 * same q/30 denominator the client uses, computed once here so both agree.
 *
 * Fail-closed: if anything unexpected throws, the flags come back all-false so
 * the Build button stays disabled rather than green-lighting an unverifiable
 * state.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  derivedPercent,
  getInterviewGateSnapshot,
  readAnswerBlocks,
  type GateFlags,
} from '@/lib/interview/seam';
import { refreshInterviewMirror } from '@/lib/interview/mirror';
import {
  computeAnsweredIds,
  computeStructuredResume,
} from '@/lib/interview/structured-progress';
import { INTERVIEW_QUESTIONS } from '@/lib/interview-questions';
import { getClientContext } from '@/lib/clients';
import { loadCompanyConfig } from '@/lib/company-config';

/* -------------------------------------------------------------------------- */
/* known-context (memory) — facts already on file the interview can CONFIRM    */
/* -------------------------------------------------------------------------- */

/**
 * Facts the box already holds (clients row + company config) keyed by the
 * structured question that asks for them. The UI prefills the matching card and
 * offers "confirm or correct"; a confirm posts confirmedFromContext so the QC
 * gate classifies it as confirmed-from-context, never fabricated. Values are
 * read-only here; template/default values are filtered out so the owner is
 * never asked to "confirm" a placeholder.
 */
function readKnownContext(): Record<string, { value: string; source: string }> {
  const known: Record<string, { value: string; source: string }> = {};
  try {
    const client = getClientContext();
    const name = (client?.name ?? '').trim();
    // Placeholder names (fresh-box auto-seed rows) are NOT known facts.
    const placeholderName = /^(default|this box(\s*\(operator\))?|operator)$/i.test(name);
    if (name && !placeholderName) {
      known.company_name = { value: name, source: 'client-record' };
    }
    if (client?.brand_color && String(client.brand_color).trim()) {
      known.brand_primary_color = {
        value: String(client.brand_color).trim(),
        source: 'client-record',
      };
    }
    if (client?.logo_url && String(client.logo_url).trim()) {
      known.brand_logo = { value: String(client.logo_url).trim(), source: 'client-record' };
    }
  } catch {
    /* fail-soft: no client context → nothing known */
  }
  try {
    const cfg = loadCompanyConfig();
    const industry = (cfg.industry ?? '').trim();
    if (industry && !/^(unknown|general|template)$/i.test(industry)) {
      known.industry = { value: industry, source: 'company-settings' };
    }
    const ccName = (cfg.commandCenterName ?? '').trim();
    if (ccName && ccName.toLowerCase() !== 'command center') {
      known.command_center_name = { value: ccName, source: 'company-settings' };
    }
  } catch {
    /* fail-soft */
  }
  return known;
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Parse a comma-separated query param into a trimmed, de-duped string list. */
function parseIdList(raw: string | null): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  );
}

export async function GET(request: NextRequest) {
  // Owner-added custom depts (and configured implicit-YES customs) can be passed
  // by the board so decisionCoverage reflects them; both default to none. The
  // canonical floor (mandatory + universal-primary) is always read live from the
  // Skill-23 script inside the snapshot — never hardcoded here.
  const url = new URL(request.url);
  const customDeptIds = parseIdList(url.searchParams.get('customDeptIds'));
  const implicitYesCustomIds = parseIdList(url.searchParams.get('implicitYesCustomIds'));

  try {
    const snap = await getInterviewGateSnapshot({ customDeptIds, implicitYesCustomIds });

    // READ-MIRROR refresh (P2-2). Re-sync the interview_sessions/interview_answers
    // index FROM the canonical files this GET just read. READ-ONLY on the session
    // id (never mints one on a GET) and best-effort: refreshInterviewMirror never
    // throws and the state response is returned regardless of the mirror outcome.
    refreshInterviewMirror();

    // Rail's "current question": prefer the live progress stamp, fall back to the
    // handoff tracker. Used only for display + the derived percent.
    const lastQuestionNumber =
      (typeof snap.progress.lastQuestionNumber === 'number'
        ? snap.progress.lastQuestionNumber
        : null) ?? snap.handoff.lastQuestionNumber;

    const percent = derivedPercent(lastQuestionNumber);

    // ── Structured resume position (continuity) ──────────────────────────
    // Which structured questions already carry a transcript answer, and the
    // exact card index a paused owner resumes at. Computed from the canonical
    // transcript (files win) through the same matcher the client folds over
    // its mirrored question set — a refresh can never restart the deck.
    const blocks = readAnswerBlocks(snap.buildState);
    const answeredIds = computeAnsweredIds(blocks, INTERVIEW_QUESTIONS);
    const structured = computeStructuredResume(INTERVIEW_QUESTIONS, answeredIds);

    return NextResponse.json({
      ok: true,

      // ── Stable session + structured resume + known context ───────────
      // interviewSessionId is READ-only here (never minted on a GET); the
      // client uses it to key its gateway-session persistence.
      session: {
        interviewSessionId:
          (snap.buildState?.interviewSessionId as string | undefined) ?? null,
      },
      structured: {
        total: structured.total,
        answeredIds: structured.answeredIds,
        remainingIds: structured.remainingIds,
        nextIndex: structured.nextIndex,
        complete: structured.complete,
      },
      knownContext: readKnownContext(),

      // Top-level lifecycle signals (drive the locked-shell + redirect logic).
      interviewComplete: snap.interviewComplete,
      buildCompleted: snap.buildCompleted,
      qcStatus: snap.qcStatus,

      // ── Progress rail ────────────────────────────────────────────────
      progress: {
        lastQuestionNumber,
        phasesComplete: snap.progress.phasesComplete ?? [],
        percent, // derived q/30, capped 100 — never a stored field
      },

      // ── Resume position (welcome-back / continue) ────────────────────
      resume: {
        status: snap.handoff.status,
        nextQuestionNumber: snap.handoff.nextQuestionNumber,
        skippedQuestions: snap.handoff.skippedQuestions,
        totalQuestionsAnswered: snap.handoff.totalQuestionsAnswered,
        handoffExists: snap.handoff.exists,
      },

      // ── Transcript facts (gate #2 inputs, for debugging the rail) ────
      transcript: {
        exists: snap.answers.exists,
        qBlockCount: snap.answers.qBlockCount,
        sizeBytes: snap.answers.sizeBytes,
        hasSyntheticHeader: snap.answers.hasSyntheticHeader,
        genuine: snap.answers.genuine,
      },

      // ── Decision-board readiness (drives NOT-YET badges + complete) ──
      decisionCoverage: {
        complete: snap.coverage.complete,
        expected: snap.coverage.expected,
        covered: snap.coverage.covered,
        missing: snap.coverage.missing,
        declined: snap.coverage.declined,
        rejections: snap.coverage.rejections,
      },
      // The live floor the board renders from (null if the script is unavailable —
      // in which case decisionCoverageComplete is false, fail-closed).
      canonicalFloor: snap.canonical
        ? {
            floor: snap.canonical.floor,
            namingMapVersion: snap.canonical.naming_map_version,
            mandatoryCount: snap.canonical.mandatory_count,
            universalPrimaryCount: snap.canonical.universal_primary_count,
          }
        : null,

      // ── The three UI gate flags the Build button ANDs together ───────
      flags: snap.flags,
    });
  } catch {
    // Fail-closed snapshot: disabled Build button, empty rail. Never throws to
    // the client with a green-lightable partial state.
    const flags: GateFlags = {
      genuineTranscriptReady: false,
      decisionCoverageComplete: false,
      noUnprovenancedDeclines: false,
    };
    return NextResponse.json(
      {
        ok: false,
        session: { interviewSessionId: null },
        structured: {
          total: INTERVIEW_QUESTIONS.length,
          answeredIds: [],
          remainingIds: INTERVIEW_QUESTIONS.map((q) => q.id),
          nextIndex: 0,
          complete: false,
        },
        knownContext: {},
        interviewComplete: false,
        buildCompleted: false,
        qcStatus: 'pending',
        progress: { lastQuestionNumber: null, phasesComplete: [], percent: 0 },
        resume: {
          status: null,
          nextQuestionNumber: null,
          skippedQuestions: [],
          totalQuestionsAnswered: null,
          handoffExists: false,
        },
        transcript: {
          exists: false,
          qBlockCount: 0,
          sizeBytes: 0,
          hasSyntheticHeader: false,
          genuine: false,
        },
        decisionCoverage: {
          complete: false,
          expected: [],
          covered: [],
          missing: [],
          declined: [],
          rejections: [],
        },
        canonicalFloor: null,
        flags,
      },
      { status: 200 },
    );
  }
}
