/**
 * interview-answer-contract.test.ts — pins the client↔route contract for
 * POST /api/interview/answer (v4.63).
 *
 * THE BUG THIS PREVENTS: the structured cards used to post
 * { questionId, storeOn, kind, value } while the route's zod schema required
 * { answer, prompt?, ... } — every card submit failed with a 400 and the owner
 * saw "Something went wrong saving that" on EVERY structured question. The two
 * sides each declared the shape locally and drifted.
 *
 * The fix routes every card through buildAnswerPayload()
 * (src/lib/interview/answer-payload.ts); this test parses the builder's output
 * with the route's OWN exported zod schema, so any future drift fails CI.
 *
 * No DB, no fs, no network — pure schema parsing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { answerRequestSchema } from '../../src/lib/interview/answer-schema';
import {
  buildAnswerPayload,
  phaseForQuestion,
} from '../../src/lib/interview/answer-payload';
import {
  IDENTITY_QUESTIONS,
  OPERATIONS_QUESTIONS,
} from '../../src/lib/interview/base-questions';
import { INTERVIEW_QUESTIONS } from '../../src/lib/interview-questions';

test('buildAnswerPayload output parses under the route schema for EVERY structured question', () => {
  for (const [i, q] of INTERVIEW_QUESTIONS.entries()) {
    const body = buildAnswerPayload({
      question: q,
      value: q.kind === 'color' ? '#1E3A8A' : 'A real answer from the owner',
      questionNumber: i + 1,
      sessionId: 'session-abc',
    });
    const parsed = answerRequestSchema.safeParse(body);
    assert.ok(
      parsed.success,
      `payload for ${q.id} failed route validation: ${
        parsed.success ? '' : JSON.stringify(parsed.error.issues)
      }`,
    );
  }
});

test('payload carries the canonical prompt + questionId + phase stamp', () => {
  const q = INTERVIEW_QUESTIONS[0];
  const body = buildAnswerPayload({ question: q, value: 'Acme Rockets', questionNumber: 1 });
  assert.equal(body.questionId, q.id);
  assert.equal(body.prompt, q.prompt); // canonical, never personalized
  assert.equal(body.answer, 'Acme Rockets');
  assert.equal(body.questionNumber, 1);
  assert.equal(body.phase, phaseForQuestion(q));
});

test('confirm-from-context provenance rides through when supplied', () => {
  const q = INTERVIEW_QUESTIONS[0];
  const body = buildAnswerPayload({
    question: q,
    value: 'Acme Rockets',
    confirmedFromContext: 'client-record',
  });
  assert.equal(body.confirmedFromContext, 'client-record');
  assert.ok(answerRequestSchema.safeParse(body).success);
});

test('branding questions stamp their canonical phase (phase3), CC-owned ones their section', () => {
  const branding = INTERVIEW_QUESTIONS.find((q) => q.id === 'brand_evokes');
  assert.ok(branding);
  assert.equal(phaseForQuestion(branding!), 'phase3');
  assert.equal(phaseForQuestion(IDENTITY_QUESTIONS[0]), 'identity');
  assert.equal(phaseForQuestion(OPERATIONS_QUESTIONS[0]), 'operations');
});

test('the legacy drifted shape ({value, storeOn, kind}) is REJECTED by the route schema', () => {
  const legacy = {
    questionId: 'company_name',
    storeOn: 'client.name',
    kind: 'text',
    value: 'Acme Rockets',
  };
  const parsed = answerRequestSchema.safeParse(legacy);
  assert.equal(parsed.success, false, 'legacy shape must not silently pass');
});

test('oversized free-text answers are rejected; inline logo images are allowed', () => {
  const textTooBig = answerRequestSchema.safeParse({
    prompt: 'What is your company name?',
    answer: 'x'.repeat(20_001),
  });
  assert.equal(textTooBig.success, false);

  const inlineLogo = answerRequestSchema.safeParse({
    prompt: 'Do you have a logo? Paste a public link to it (or upload one).',
    answer: `data:image/png;base64,${'A'.repeat(50_000)}`,
  });
  assert.ok(inlineLogo.success, 'a data:image logo within bounds must parse');
});

test('INTERVIEW_QUESTIONS = identity + branding + operations, ids unique, sections ordered', () => {
  assert.ok(INTERVIEW_QUESTIONS.length >= IDENTITY_QUESTIONS.length + OPERATIONS_QUESTIONS.length + 1);
  const ids = INTERVIEW_QUESTIONS.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length, 'question ids must be unique');
  // Sections appear in contiguous journey order: identity → branding → operations.
  const sections = INTERVIEW_QUESTIONS.map((q) => q.section);
  const firstBranding = sections.indexOf('branding');
  const firstOps = sections.indexOf('operations');
  assert.ok(firstBranding > 0, 'branding follows identity');
  assert.ok(firstOps > firstBranding, 'operations follows branding');
  assert.equal(sections.lastIndexOf('identity') < firstBranding, true);
  assert.equal(sections.lastIndexOf('branding') < firstOps, true);
});
