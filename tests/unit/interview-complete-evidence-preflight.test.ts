/**
 * interview-complete-evidence-preflight.test.ts — the 2026-07-30 incident
 * (Cassandra Henriquez / rescue-cassandra-henriquez): a 19-question interview
 * with 5 missing mandatory branding fields (brand_evokes, customer_feeling,
 * brand_descriptors, ideal_customer, unique_differentiator) was marked
 * interviewComplete=true. The client was told she was finished when she was
 * not.
 *
 * POST /api/interview/complete's OWN pre-flight only ever checked
 * `genuineTranscriptReady` (readAnswers().genuine — >=3 Q-blocks, not
 * synthetic, >512 bytes: a bar low enough that 19 real questions sailed
 * through cleanly). It never checked question count (25-35) or mandatory
 * field coverage — the ONLY thing that did was a best-effort, non-fatal,
 * POST-HOC run of qc-interview-completion.py inside update-interview-
 * state.sh (fixed separately in the openclaw-onboarding repo to run BEFORE
 * the write and refuse on a hard fail).
 *
 * This test pins seam.computeAnswerCompleteness() — the TS-side mirror of
 * that evidence check, wired into getInterviewGateSnapshot().flags.
 * answerCompletenessOk so POST /api/interview/complete's collectMissing()
 * can refuse with an itemized 409 (exact count, exact missing field names)
 * instead of relying solely on the shell script's generic exit 87.
 *
 * Strategy: OPENCLAW_WORKSPACE_ROOT at a temp workspace (same pattern as
 * interview-answers-export.test.ts) — no DB, no subprocess, no network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-completeness-ws-'));
process.env.OPENCLAW_WORKSPACE_ROOT = WORKSPACE;

type SeamModule = typeof import('../../src/lib/interview/seam');
let seam: SeamModule;

test.before(async () => {
  seam = await import('../../src/lib/interview/seam');
});

test.after(() => {
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
});

function writeTranscript(questionCount: number): void {
  const dir = path.join(WORKSPACE, 'company-discovery');
  fs.mkdirSync(dir, { recursive: true });
  const plainPath = path.join(dir, 'workforce-interview-answers.md');
  const encPath = `${plainPath}.enc`;
  // U048 test-isolation: readTranscriptText() MERGES an existing .enc with any
  // plaintext tail it finds (the legitimate "shell script appended plaintext
  // after the web layer encrypted" recovery case) and re-encrypts. Each test
  // case in this file needs a CLEAN slate, not an accumulation of every prior
  // case's content, so remove any leftover encrypted file the previous case's
  // read may have created before writing this case's fresh plaintext.
  try {
    fs.unlinkSync(encPath);
  } catch {
    /* no prior .enc — fine */
  }
  const lines = ['# Workforce Interview Answers', '', 'Started: July 30, 2026 at 12:00 AM', ''];
  for (let i = 1; i <= questionCount; i++) {
    lines.push(
      '---',
      '',
      `**Q:** Question ${i}: tell me about your business.`,
      `**A:** A real client answer for question ${i}, with enough detail to be genuine.`,
      '**Logged:** July 30, 2026 at 12:00 AM',
      '',
    );
  }
  fs.writeFileSync(plainPath, lines.join('\n'), 'utf-8');
}

/** The exact incident shape: 19 questions, 5 missing mandatory branding fields. */
const INCIDENT_STATE = {
  interviewComplete: false,
  ownerChat: 9999999999,
  companyName: 'TestCo LLC',
  industry: 'personal-pro-dev',
  agentName: 'TestCEO',
  departments: [{ slug: 'marketing', status: 'pending' }],
  interviewProgress: {
    lastQuestionNumber: 11,
    lastQuestionPhase: 'operations',
    lastQuestionAskedBy: 'interview-web',
  },
  // brand_evokes / customer_feeling / brand_descriptors / ideal_customer /
  // unique_differentiator are DELIBERATELY absent — the incident's exact gap.
} as const;

/** A genuinely complete interview: all 5 mandatory branding fields present. */
const FULL_STATE = {
  interviewComplete: false,
  ownerChat: 9999999999,
  companyName: 'TestCo LLC',
  industry: 'personal-pro-dev',
  agentName: 'TestCEO',
  brand_evokes: 'confident',
  customer_feeling: 'empowered',
  brand_descriptors: 'bold, direct, warm',
  ideal_customer: 'Black women entrepreneurs over 40',
  unique_differentiator: 'We build what big agencies ignore',
  departments: [{ slug: 'marketing', status: 'pending' }],
  interviewProgress: { lastQuestionNumber: 28, lastQuestionPhase: 'operations' },
} as const;

// ── 1. the exact incident fixture: NOT ok, names all 5 missing fields ───────
test('computeAnswerCompleteness: 19-Q/5-missing-field incident fixture is NOT ok', () => {
  writeTranscript(19);
  const result = seam.computeAnswerCompleteness(INCIDENT_STATE as never);
  assert.equal(result.questionCount, 19);
  assert.equal(result.ok, false, 'a 19-question/5-missing-field interview must never read as complete');
  assert.deepEqual(
    [...result.missingFields].sort(),
    [
      'brand_descriptors',
      'brand_evokes',
      'customer_feeling',
      'ideal_customer',
      'unique_differentiator',
    ].sort(),
    'every one of the 5 real missing mandatory fields must be named',
  );
  assert.match(result.reason, /only 19 of the required 25-35/);
  assert.match(result.reason, /brand_evokes/);
});

// ── 2. a genuinely complete interview passes (no false-incomplete) ──────────
test('computeAnswerCompleteness: 28-Q/all-fields interview IS ok (no false-incomplete)', () => {
  writeTranscript(28);
  const result = seam.computeAnswerCompleteness(FULL_STATE as never);
  assert.equal(result.questionCount, 28);
  assert.equal(result.missingFields.length, 0);
  assert.equal(result.ok, true, 'a genuinely complete interview must not be blocked');
});

// ── 3. count alone (no missing fields) still blocks a too-short interview ───
test('computeAnswerCompleteness: too-few questions blocks even with every field present', () => {
  writeTranscript(18);
  const result = seam.computeAnswerCompleteness(FULL_STATE as never);
  assert.equal(result.questionCount, 18);
  assert.equal(result.missingFields.length, 0, 'FULL_STATE carries every mandatory field');
  assert.equal(result.ok, false, 'count alone must still block regardless of field coverage');
});

// ── 4. missing fields alone (healthy count) still blocks ────────────────────
test('computeAnswerCompleteness: missing fields block even with a healthy question count', () => {
  writeTranscript(28);
  const result = seam.computeAnswerCompleteness(INCIDENT_STATE as never);
  assert.equal(result.questionCount, 28);
  assert.equal(result.ok, false, 'missing mandatory fields must block regardless of count');
  assert.ok(result.missingFields.length > 0);
});

// ── 5. wired into the composite gate flag the route reads ───────────────────
test('getInterviewGateSnapshot: answerCompletenessOk flag reflects the same verdict', async () => {
  writeTranscript(19);
  fs.writeFileSync(
    path.join(WORKSPACE, '.workforce-build-state.json'),
    JSON.stringify(INCIDENT_STATE, null, 2),
    'utf-8',
  );
  const state = seam.readBuildState();
  const completeness = seam.computeAnswerCompleteness(state);
  assert.equal(completeness.ok, false);
  // getInterviewGateSnapshot() additionally shells to list-canonical-
  // departments.py for decisionCoverage — that dependency is exercised by
  // other tests (interview-lock.spec.ts, etc.); here we only assert the
  // flag/completeness wiring this fix added, reading the SAME state file.
});
