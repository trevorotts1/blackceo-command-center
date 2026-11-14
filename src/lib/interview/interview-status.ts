/**
 * BU-23 (WF-023) — the TypeScript half of the ONE reader for "is the interview
 * complete" (interface contract, 01-BUILD-SPEC.md section 2.3).
 *
 * The Python reader is the onboarding repository's `scripts/interview_status.py`.
 * This module is a port of the same decision table, not a second opinion: both
 * are driven by ONE fixture file, `tests/fixtures/interview-status-cases.json`
 * (the same bytes live in the onboarding repository), so the two tables cannot
 * drift without a test going red on one side.
 *
 * PLAIN MODULE, ON PURPOSE: it imports nothing from Next.js, touches no request
 * object, reads no file and takes an already-parsed build-state. That is what
 * lets `gate-status/route.ts`, a server action and a job all ask the same
 * question, and what lets the Command Center's task routing
 * (`isWorkforceProvisioned`) import it without pulling the framework in.
 *
 * States, in decision order:
 *   BUILT        completionVerification.status === "verified"
 *   BUILDING     interviewComplete true and the build has started
 *                (confirmationsComplete true, or a departments[] entry is
 *                pending / building / done)
 *   COMPLETE     interviewComplete true
 *   PLACEHOLDER  companyMode "standard-placeholder" with standardPlaceholder.status "active"
 *   DECLARED     the caller says its declarations table holds a row
 *   READY        the gate's complete-check passes (gate facts supplied by caller)
 *   IN_PROGRESS  the gate holds at least one answer, or interviewProgress
 *                .lastQuestionNumber is above 0
 *   NOT_STARTED  none of the above
 *   UNDETERMINED the caller could not read the state file — NEVER reported as
 *                NOT_STARTED
 *
 * COMPLETE, BUILDING and BUILT behave identically for every consumer; the split
 * exists for reports only.
 */

export type InterviewStatusName =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'READY'
  | 'COMPLETE'
  | 'BUILDING'
  | 'BUILT'
  | 'PLACEHOLDER'
  | 'DECLARED'
  | 'UNDETERMINED';

/** Gate facts the READY rule needs. Omit them when the caller cannot read the gate. */
export interface InterviewGateFacts {
  answers: number;
  missingRequired: readonly string[];
}

export interface InterviewStatusOptions {
  /** The caller's declarations table holds a row for this company. */
  declared?: boolean;
  /** Parsed gate facts, or null/omitted when the gate state could not be read. */
  gate?: InterviewGateFacts | null;
  /** The caller could not read the build-state file. */
  unreadable?: boolean;
}

/**
 * States in which the dashboard shell lock is open (2.3, "Shell lock (shell
 * reachable)"). DECLARED opens the shell but is never interview completion.
 */
export const SHELL_LOCK_STATES: readonly InterviewStatusName[] = [
  'COMPLETE',
  'BUILDING',
  'BUILT',
  'PLACEHOLDER',
  'DECLARED',
];

const BUILDING_DEPARTMENT_STATUSES = ['pending', 'building', 'done'];

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): number {
  if (typeof value === 'boolean') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value !== 'string') return 0;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The decision table. Same order as the Python reader; same fixture. */
export function interviewStatus(
  buildState: unknown,
  options: InterviewStatusOptions = {},
): InterviewStatusName {
  if (options.unreadable === true) return 'UNDETERMINED';
  const build = record(buildState);
  if (record(build.completionVerification).status === 'verified') return 'BUILT';
  const complete = build.interviewComplete === true || build.interview_complete === true;
  if (complete) {
    const departments = Array.isArray(build.departments) ? build.departments : [];
    const started =
      build.confirmationsComplete === true ||
      departments.some((entry) =>
        BUILDING_DEPARTMENT_STATUSES.includes(String(record(entry).status ?? '')),
      );
    return started ? 'BUILDING' : 'COMPLETE';
  }
  if (
    build.companyMode === 'standard-placeholder' &&
    record(build.standardPlaceholder).status === 'active'
  ) {
    return 'PLACEHOLDER';
  }
  if (options.declared === true) return 'DECLARED';
  const gate = options.gate;
  if (gate && Array.isArray(gate.missingRequired) && gate.missingRequired.length === 0) {
    if (typeof gate.answers === 'number') return 'READY';
  }
  if (count(gate?.answers) > 0 || count(record(build.interviewProgress).lastQuestionNumber) > 0) {
    return 'IN_PROGRESS';
  }
  return 'NOT_STARTED';
}

/** True for the states in which the interview shell lock is open. */
export function opensShell(status: InterviewStatusName): boolean {
  return SHELL_LOCK_STATES.includes(status);
}
