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
  type GateFlags,
} from '@/lib/interview/seam';

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

    // Rail's "current question": prefer the live progress stamp, fall back to the
    // handoff tracker. Used only for display + the derived percent.
    const lastQuestionNumber =
      (typeof snap.progress.lastQuestionNumber === 'number'
        ? snap.progress.lastQuestionNumber
        : null) ?? snap.handoff.lastQuestionNumber;

    const percent = derivedPercent(lastQuestionNumber);

    return NextResponse.json({
      ok: true,

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
