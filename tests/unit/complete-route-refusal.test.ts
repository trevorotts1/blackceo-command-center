/**
 * complete-route-refusal.test.ts — BU-06 acceptance (QC runs it).
 *
 * THE BUG THIS PREVENTS (WF-003, WF-020, WF-029): a refused build reached the
 * owner as "The build refused: a genuine interview / consent is still
 * required." — a sentence that named nothing to fix. The real reasons sat in
 * interviewQc.reasons behind a branch exit 87 never reached.
 *
 * Proves the DOOR, not a re-implementation: drives the REAL
 * POST /api/interview/complete handler with a temp workspace and a stub
 * Skill-23 scripts folder, exactly like tests/unit/interview-gate-routes.test.ts.
 *
 *   1. exit 87 → 409 {error:'interview_incomplete'} whose reasons[0] is the
 *      plain sentence for `company_name`, never the raw gate string, and whose
 *      JSON never leaks `askedBy`.
 *   2. exit 89 → 429 {error:'try_again_later'} with the exact message.
 *
 * Nothing outside the temp workspace/scripts dir is read or written. No
 * network, no live box, no real Skill-23 checkout.
 */

import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

/** A verified self tenant: loopback host + the operator bearer. */
const OPERATOR_TOKEN = 'bu06-complete-route-test-token';
process.env.MC_API_TOKEN = OPERATOR_TOKEN;
// Deterministic transcript key: never derive one from the real home folder.
process.env.MC_INTERVIEW_SECRET =
  process.env.MC_INTERVIEW_SECRET || 'bu06-complete-route-test-secret';
if (process.env.NODE_ENV === 'production') process.env.NODE_ENV = 'test';

/**
 * The reproduction's case-B refusal: a company name the completion check
 * rejects on its hidden floor. The route must never show this string.
 */
const RAW_CASE_B_REASON =
  'Missing mandatory fields: company_name (answered with 3 characters; at least 12 are required)';

const COMPANY_PROMPT = 'What name should we put on everything we build for you?';

/** One throwaway workspace + stub scripts folder for this file. */
function makeBox(): { workspace: string; scripts: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bu06-complete-route-'));
  const workspace = path.join(root, 'workspace');
  const scripts = path.join(root, 'skill23-scripts');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });

  // The live floor printer. An empty floor means the pre-flight has no
  // department decisions to demand — this test is about the refusal path,
  // not about coverage arithmetic.
  fs.writeFileSync(
    path.join(scripts, 'list-canonical-departments.py'),
    'import json\n' +
      "print(json.dumps({'mandatory': [], 'universal_primary_vertical': []}))\n",
    { encoding: 'utf-8' },
  );

  // The completion trigger. It records nothing; it only exits with the code
  // the current case asks for, exactly as update-interview-state.sh does.
  fs.writeFileSync(
    path.join(scripts, 'update-interview-state.sh'),
    '#!/usr/bin/env bash\n' +
      'code="$(cat "$(dirname "$0")/exit-code")"\n' +
      'if [ "$code" = "87" ]; then echo "INTERVIEW_PENDING" >&2; fi\n' +
      'exit "$code"\n',
    { encoding: 'utf-8', mode: 0o755 },
  );
  setExitCode(scripts, 87);

  // Build-state: not yet complete; the QC verdict carries the raw case-B
  // reason and the open question id.
  fs.writeFileSync(
    path.join(workspace, '.workforce-build-state.json'),
    `${JSON.stringify(
      {
        interviewComplete: false,
        interviewQc: {
          status: 'fail',
          reasons: [RAW_CASE_B_REASON],
          missingQuestionIds: ['company_name'],
        },
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf-8' },
  );

  // A genuine transcript: no synthetic header, four Q blocks, over 512 bytes
  // (the gate-#2 rule the pre-flight mirrors).
  fs.mkdirSync(path.join(workspace, 'company-discovery'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'company-discovery', 'workforce-interview-answers.md'),
    [
      '# Workforce Interview Answers',
      '',
      '**Q:** ' + COMPANY_PROMPT,
      '**A:** Acme. We build one-to-one coaching plans for owners of small companies.',
      '',
      '---',
      '',
      '**Q:** What kind of business is it?',
      '**A:** Coaching for small business owners who need a plan they can actually follow. Most arrive with a full calendar and no clear priority, and leave with one written ninety-day plan they can hand to their team.',
      '',
      '---',
      '',
      '**Q:** What do you sell?',
      '**A:** One-on-one planning sessions and a written ninety-day roadmap for each owner, plus a short weekly check-in by phone so the plan keeps moving after the session ends.',
      '',
      '---',
      '',
      '**Q:** Who is your best kind of customer?',
      '**A:** An owner with five to fifty staff who is stuck doing everything alone and wants the business to run without them in every decision.',
      '',
    ].join('\n'),
    { encoding: 'utf-8' },
  );

  return { workspace, scripts };
}

function setExitCode(scripts: string, code: number): void {
  fs.writeFileSync(path.join(scripts, 'exit-code'), `${code}`, { encoding: 'utf-8' });
}

function post(): NextRequest {
  return new NextRequest('http://localhost/api/interview/complete', {
    method: 'POST',
    headers: { host: 'localhost', authorization: `Bearer ${OPERATOR_TOKEN}` },
  });
}

const box = makeBox();
process.env.OPENCLAW_WORKSPACE_ROOT = box.workspace;
process.env.OPENCLAW_WORKSPACE_PATH = box.workspace;
process.env.OPENCLAW_SKILL23_SCRIPTS = box.scripts;

test('exit 87: 409 names the company name in a plain sentence and never leaks the raw reason or askedBy', async () => {
  setExitCode(box.scripts, 87);
  const { POST } = await import('../../src/app/api/interview/complete/route');

  const res = await POST(post());
  assert.equal(res.status, 409);

  const body = (await res.json()) as {
    ok?: boolean;
    error?: string;
    reasons?: string[];
  };
  assert.equal(body.ok, false);
  assert.equal(body.error, 'interview_incomplete');
  assert.ok(Array.isArray(body.reasons), 'reasons is a list');
  assert.equal(body.reasons![0], 'Please check your company name.');

  const json = JSON.stringify(body);
  assert.ok(!json.includes(RAW_CASE_B_REASON), 'the raw gate sentence is never shown');
  assert.ok(!json.includes('askedBy'), 'no transcript-internal field leaks to the client');
});

test('exit 89: 429 try_again_later with the exact retry message', async () => {
  setExitCode(box.scripts, 89);
  const { POST } = await import('../../src/app/api/interview/complete/route');

  const res = await POST(post());
  assert.equal(res.status, 429);

  const body = (await res.json()) as { error?: string; message?: string };
  assert.equal(body.error, 'try_again_later');
  assert.equal(
    body.message,
    'Please wait a few minutes and press the button again.',
  );
});
