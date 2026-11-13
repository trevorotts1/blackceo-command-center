/**
 * interview-gate-routes.test.ts — BU-13 acceptance.
 *
 * THE BUG THIS PREVENTS: the web interview decided order, acceptance and
 * completion on its own (and appended whatever it was handed). The step gate is
 * now the ONLY authority: answering out of order is refused, a too-short answer
 * gets exactly one follow-up, an accepted answer is recorded with its question
 * id, and the page's progress percent is the gate's own arithmetic.
 *
 * Runs the REAL routes against a temp workspace and a real onboarding checkout:
 *   OPENCLAW_WORKSPACE_ROOT    a fresh temp folder per test (state lives there)
 *   OPENCLAW_SKILL23_SCRIPTS   an onboarding checkout's skill scripts folder
 *                              (needs BU-10's interview_gate.py + BU-12's
 *                              update-interview-state.sh). When it is not set
 *                              the test SKIPS rather than pretend to pass.
 *
 * No network. Writes stay inside the temp workspace and an isolated DB.
 */

import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

import { readTranscriptText } from '../../src/lib/interview/seam';

/** A verified self tenant: loopback host + the operator bearer. */
const OPERATOR_TOKEN = 'bu13-gate-routes-test-token';
process.env.MC_API_TOKEN = OPERATOR_TOKEN;
// Deterministic transcript key: never derive one from the real home folder.
process.env.MC_INTERVIEW_SECRET = process.env.MC_INTERVIEW_SECRET || 'bu13-gate-routes-test-secret';

const SCRIPTS_DIR = (process.env.OPENCLAW_SKILL23_SCRIPTS || '').trim();
const GATE_READY =
  !!SCRIPTS_DIR &&
  fs.existsSync(path.join(SCRIPTS_DIR, 'interview_gate.py')) &&
  fs.existsSync(path.join(SCRIPTS_DIR, 'update-interview-state.sh'));
const SKIP = GATE_READY
  ? false
  : 'OPENCLAW_SKILL23_SCRIPTS must name an onboarding checkout of 23-ai-workforce-blueprint/scripts (BU-10 gate + BU-12 state script)';

const AUTH = { host: 'localhost', authorization: `Bearer ${OPERATOR_TOKEN}` };

/** A fresh workspace with a build-state file the state script will accept. */
function freshWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bu13-gate-ws-'));
  process.env.OPENCLAW_WORKSPACE_ROOT = ws;
  fs.writeFileSync(
    path.join(ws, '.workforce-build-state.json'),
    `${JSON.stringify({ interviewQc: { status: 'pending' } }, null, 2)}\n`,
  );
  return ws;
}

function call(method: 'GET' | 'POST', url: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: body === undefined ? AUTH : { ...AUTH, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test(
  'answer + next follow the gate: out-of-order 409, accepted block carries its QID, one follow-up then shortAccepted',
  { skip: SKIP },
  async () => {
    freshWorkspace();
    const { POST: answer } = await import('../../src/app/api/interview/answer/route');
    const { GET: next } = await import('../../src/app/api/interview/next/route');
    const { GET: state } = await import('../../src/app/api/interview/state/route');

    // 1. An answer for a question that is not current is out of order.
    const early = await answer(
      call('POST', '/api/interview/answer', {
        questionId: 'industry',
        answer: 'Aerospace engineering',
      }),
    );
    assert.equal(early.status, 409);
    const earlyBody = await early.json();
    assert.equal(earlyBody.error, 'out_of_order');
    assert.equal(earlyBody.expected, 'company_name');

    // 2. The current question is accepted, and its block names the id first.
    const first = await answer(
      call('POST', '/api/interview/answer', { questionId: 'company_name', answer: 'Acme' }),
    );
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.accepted, true);
    assert.equal(firstBody.appended, true);

    const transcript = readTranscriptText().text;
    const block = transcript
      .split(/\n\s*-{3,}\s*\n/)
      .find((chunk) => chunk.includes('**QID:** company_name'));
    assert.ok(block, 'the accepted answer is in the transcript');
    assert.equal(
      block!.trimStart().split('\n')[0].trim(),
      '**QID:** company_name',
      'the QID line is the first line of the block',
    );

    // 3. `next` is the gate's answer, not the page's guess.
    const nextResponse = await next(call('GET', '/api/interview/next'));
    assert.equal(nextResponse.status, 200);
    const nextBody = await nextResponse.json();
    assert.equal(nextBody.done, false);
    assert.equal(nextBody.id, 'industry');

    const industry = await answer(
      call('POST', '/api/interview/answer', {
        questionId: 'industry',
        answer: 'Aerospace engineering',
      }),
    );
    assert.equal(industry.status, 200);

    // 4. A too-short answer gets exactly ONE follow-up; the same answer again
    //    is accepted and flagged shortAccepted.
    const short = await answer(
      call('POST', '/api/interview/answer', { questionId: 'what_you_sell', answer: 'Stuff' }),
    );
    assert.equal(short.status, 200);
    const shortBody = await short.json();
    assert.equal(shortBody.accepted, false);
    assert.ok(
      typeof shortBody.followUp === 'string' && shortBody.followUp.length > 0,
      'the follow-up carries a sentence to show the owner',
    );

    const accepted = await answer(
      call('POST', '/api/interview/answer', { questionId: 'what_you_sell', answer: 'Stuff' }),
    );
    assert.equal(accepted.status, 200);
    const acceptedBody = await accepted.json();
    assert.equal(acceptedBody.accepted, true);
    assert.equal(acceptedBody.shortAccepted, true);

    // 5. The state route reports the gate's percent, computed the gate's way.
    const stateResponse = await state(call('GET', '/api/interview/state'));
    assert.equal(stateResponse.status, 200);
    const stateBody = await stateResponse.json();
    assert.ok(stateBody.gate, 'state carries the gate status');
    assert.equal(
      stateBody.gate.percent,
      Math.round((100 * stateBody.gate.requiredAnswered) / stateBody.gate.requiredTotal),
    );
    assert.equal(stateBody.progress.percent, stateBody.gate.percent);
  },
);

test(
  'skip follows the gate: a required current question is refused, an optional current question is skipped',
  { skip: SKIP },
  async () => {
    freshWorkspace();
    const { POST: answer } = await import('../../src/app/api/interview/answer/route');
    const { POST: skip } = await import('../../src/app/api/interview/skip/route');

    // company_name is current and required — the gate refuses the skip.
    const required = await skip(
      call('POST', '/api/interview/skip', { questionId: 'company_name' }),
    );
    assert.equal(required.status, 409);
    const requiredBody = await required.json();
    assert.equal(requiredBody.ok, false);
    assert.equal(requiredBody.reason, 'required-question');

    // Walk the deck to brand_logo (an optional question).
    const answers: Array<[string, string]> = [
      ['company_name', 'Acme'],
      ['industry', 'Aerospace engineering'],
      ['what_you_sell', 'We machine bespoke drone parts for survey teams.'],
      ['business_stage', 'Steady customers'],
      ['ideal_customer', 'Independent survey teams who need reliable parts fast.'],
      ['unique_differentiator', 'We machine every part in house and ship in days.'],
      ['customer_feeling', 'Confident'],
      ['brand_descriptors', 'Precise and reliable'],
    ];
    for (const [questionId, text] of answers) {
      const res = await answer(call('POST', '/api/interview/answer', { questionId, answer: text }));
      assert.equal(res.status, 200, `${questionId} should be accepted`);
      const body = await res.json();
      assert.equal(body.accepted, true, `${questionId} should be accepted`);
    }

    for (const questionId of ['brand_evokes', 'brand_voice', 'brand_primary_color']) {
      const res = await skip(call('POST', '/api/interview/skip', { questionId }));
      assert.equal(res.status, 200, `${questionId} should be skippable`);
      const body = await res.json();
      assert.equal(body.skipped, true, `${questionId} should be skipped`);
    }

    // brand_logo is now current and optional — the skip is accepted.
    const logo = await skip(call('POST', '/api/interview/skip', { questionId: 'brand_logo' }));
    assert.equal(logo.status, 200);
    const logoBody = await logo.json();
    assert.equal(logoBody.ok, true);
    assert.equal(logoBody.skipped, true);
  },
);
