import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  interviewStatus,
  opensShell,
  SHELL_LOCK_STATES,
  type InterviewStatusName,
} from '../../src/lib/interview/interview-status';

/**
 * BU-23 (WF-023) — one reader for "is the interview complete", TypeScript half.
 *
 * The decision table of interface contract 01-BUILD-SPEC.md section 2.3 is
 * driven by ONE fixture file, tests/fixtures/interview-status-cases.json. The
 * onboarding repository's scripts/test_interview_status.py reads the SAME bytes
 * (same sha256, re-copied whenever either side changes), so the Python reader
 * used by the mini app and the Telegram agent and this port used by the Command
 * Center cannot disagree about the same build-state.
 *
 * Covers: one case per state (plus the unreadable file), the shell-lock row of
 * the contract, and the rule that a missing gate can never invent READY.
 */

interface FixtureCase {
  name: string;
  expect: InterviewStatusName;
  declared?: boolean;
  gate?: { answers: number; missingRequired: readonly string[] } | null;
  unreadable?: boolean;
  buildState: unknown;
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'interview-status-cases.json'), 'utf-8'),
) as { version: number; cases: FixtureCase[] };

const STATES: readonly InterviewStatusName[] = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'READY',
  'COMPLETE',
  'BUILDING',
  'BUILT',
  'PLACEHOLDER',
  'DECLARED',
  'UNDETERMINED',
];

test('[BU-23] the fixture is versioned and covers every state', () => {
  assert.equal(fixture.version, 1);
  const covered = new Set(fixture.cases.map((entry) => entry.expect));
  for (const state of STATES) {
    assert.ok(covered.has(state), `fixture has no case for ${state}`);
  }
});

test('[BU-23] every fixture case matches the decision table', () => {
  for (const entry of fixture.cases) {
    assert.equal(
      interviewStatus(entry.buildState, {
        declared: entry.declared === true,
        gate: entry.gate ?? null,
        unreadable: entry.unreadable === true,
      }),
      entry.expect,
      entry.name,
    );
  }
});

test('[BU-23] the shell lock opens on exactly the contract row', () => {
  assert.deepEqual([...SHELL_LOCK_STATES].sort(), [
    'BUILDING',
    'BUILT',
    'COMPLETE',
    'DECLARED',
    'PLACEHOLDER',
  ]);
  for (const state of STATES) {
    const opens = state === 'COMPLETE' || state === 'BUILDING' || state === 'BUILT'
      || state === 'PLACEHOLDER' || state === 'DECLARED';
    assert.equal(opensShell(state), opens, state);
  }
});

test('[BU-23] DECLARED opens the shell but is never completion', () => {
  const declared = interviewStatus({ interviewComplete: false }, { declared: true });
  assert.equal(declared, 'DECLARED');
  assert.equal(opensShell(declared), true);
  // A declared company is not COMPLETE: task routing must not read it as one.
  assert.notEqual(declared, 'COMPLETE');
});

test('[BU-23] a missing gate never invents READY or NOT_STARTED on progress', () => {
  assert.equal(
    interviewStatus({ interviewProgress: { lastQuestionNumber: 4 } }),
    'IN_PROGRESS',
  );
  assert.equal(interviewStatus({}), 'NOT_STARTED');
  assert.equal(
    interviewStatus({ interviewComplete: true, gaps: [] }, { gate: { answers: 9, missingRequired: [] } }),
    'COMPLETE',
    'build-state alone decides when it can',
  );
});

test('[BU-23] unreadable is never reported as NOT_STARTED', () => {
  assert.equal(interviewStatus(null, { unreadable: true }), 'UNDETERMINED');
  assert.equal(interviewStatus({}, { unreadable: true }), 'UNDETERMINED');
});

test('[BU-23] BUILDING needs evidence the build started', () => {
  assert.equal(interviewStatus({ interviewComplete: true }), 'COMPLETE');
  assert.equal(
    interviewStatus({ interviewComplete: true, confirmationsComplete: true }),
    'BUILDING',
  );
  assert.equal(
    interviewStatus({ interviewComplete: true, departments: [{ slug: 'sales', status: 'pending' }] }),
    'BUILDING',
  );
  assert.equal(
    interviewStatus({ interviewComplete: true, departments: [{ slug: 'sales', status: 'prebuilt' }] }),
    'COMPLETE',
    'a prebuilt department is not a build in flight',
  );
});
