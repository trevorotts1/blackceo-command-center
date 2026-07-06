/**
 * interview-structured-progress.test.ts — the continuity math (v4.63).
 *
 * Proves the pause/resume behavior that used to be impossible: the structured
 * position is recomputed from the canonical transcript (answered blocks), so a
 * refresh / new browser / Telegram hop resumes on the EXACT next unanswered
 * card and never re-asks an answered question.
 *
 * Pure functions — no DB, no fs, no network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeAnsweredIds,
  computeStructuredResume,
  nextStructuredIndex,
  normPrompt,
  personalizePrompt,
} from '../../src/lib/interview/structured-progress';
import { INTERVIEW_QUESTIONS } from '../../src/lib/interview-questions';

const QS = INTERVIEW_QUESTIONS;

function blockFor(id: string, answer = 'a real answer'): { question: string; answer: string } {
  const q = QS.find((x) => x.id === id);
  if (!q) throw new Error(`unknown question id ${id}`);
  return { question: q.prompt, answer };
}

test('answered blocks map back to their question ids by canonical prompt', () => {
  const blocks = [blockFor('company_name', 'Acme Rockets'), blockFor('industry', 'aerospace')];
  assert.deepEqual(computeAnsweredIds(blocks, QS), ['company_name', 'industry']);
});

test('matching tolerates whitespace/case drift but not different questions', () => {
  const q = QS[0];
  const messy = { question: `  ${q.prompt.toUpperCase()}  `, answer: 'yes' };
  assert.deepEqual(computeAnsweredIds([messy], QS), [q.id]);
  const other = { question: 'A question the deck never asked?', answer: 'yes' };
  assert.deepEqual(computeAnsweredIds([other], QS), []);
});

test('empty answers do not count as answered', () => {
  const blocks = [{ question: QS[0].prompt, answer: '   ' }];
  assert.deepEqual(computeAnsweredIds(blocks, QS), []);
});

test('resume lands on the FIRST unanswered card after a mid-deck pause', () => {
  // Owner answered questions 1..3, refreshed. They must resume at index 3.
  const answered = QS.slice(0, 3).map((q) => q.id);
  const resume = computeStructuredResume(QS, answered);
  assert.equal(resume.nextIndex, 3);
  assert.equal(resume.complete, false);
  assert.equal(resume.answeredIds.length, 3);
  assert.equal(resume.remainingIds.length, QS.length - 3);
});

test('resume handles non-contiguous answers (skipped in the middle)', () => {
  // Answered 1, 2 and 4 — the first unanswered is index 2 (question 3).
  const answered = [QS[0].id, QS[1].id, QS[3].id];
  const resume = computeStructuredResume(QS, answered);
  assert.equal(resume.nextIndex, 2);
  assert.equal(resume.remainingIds[0], QS[2].id);
});

test('a fully answered deck reports complete with no next index', () => {
  const resume = computeStructuredResume(QS, QS.map((q) => q.id));
  assert.equal(resume.complete, true);
  assert.equal(resume.nextIndex, null);
  assert.deepEqual(resume.remainingIds, []);
});

test('nextStructuredIndex skips answered AND explicitly-skipped questions', () => {
  const answered = new Set([QS[0].id]);
  const skipped = new Set([QS[1].id]);
  assert.equal(nextStructuredIndex(QS, 0, answered, skipped), 2);
  // Nothing left → null.
  assert.equal(
    nextStructuredIndex(QS, 0, new Set(QS.map((q) => q.id)), new Set()),
    null,
  );
});

test('normPrompt collapses whitespace + case (parity with the answers route)', () => {
  assert.equal(normPrompt('  What   IS your\ncompany name? '), 'what is your company name?');
});

test('personalizePrompt swaps "your company" for the name — display only', () => {
  assert.equal(
    personalizePrompt('What industry is your company in?', 'Acme Rockets'),
    'What industry is Acme Rockets in?',
  );
  // No name → untouched.
  assert.equal(personalizePrompt('What is your company name?', null), 'What is your company name?');
});
