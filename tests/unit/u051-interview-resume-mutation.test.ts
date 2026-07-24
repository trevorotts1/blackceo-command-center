/**
 * u051-interview-resume-mutation.test.ts — U051 mutation proof.
 *
 * The interview's pause/resume continuity (structured-progress.ts, commit
 * be4d61a6) recomputes the owner's position from the canonical transcript so a
 * refresh / crash / new browser resumes on the EXACT next unanswered card and
 * never restarts at question 1. The existing interview-structured-progress
 * test proves the behavior (9 tests) but carries no mutation proof — this file
 * supplies it (AC#3).
 *
 * The load-bearing line is computeStructuredResume's answered-skip
 * (`if (answered.has(q.id)) return;`). Removing it makes every question look
 * unanswered → nextIndex is always 0 → the owner restarts at question 1, the
 * exact regression U051 closes.
 *
 *   T1  baseline: with 2 of 3 questions answered, resume lands on index 2
 *   T2  MUTATION (RED): with the answered-skip removed, resume lands on index 0
 *       (restarts at question 1) — the regression is exposed
 *   T3  GREEN: the real module still lands on index 2 (mutation reverted)
 *
 * Pure functions — no DB, no fs, no network.
 * Run: node --import tsx --test tests/unit/u051-interview-resume-mutation.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { computeStructuredResume } from '../../src/lib/interview/structured-progress';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SOURCE = path.join(REPO_ROOT, 'src', 'lib', 'interview', 'structured-progress.ts');

const QUESTIONS = [
  { id: 'company_name', prompt: 'What is your company name?', section: 'identity' },
  { id: 'industry', prompt: 'What industry are you in?', section: 'identity' },
  { id: 'challenge', prompt: 'What is your biggest challenge?', section: 'operations' },
];
const ANSWERED = ['company_name', 'industry']; // first two answered

test('T1: baseline — 2 of 3 answered resumes on index 2 (the first unanswered card)', () => {
  const resume = computeStructuredResume(QUESTIONS, ANSWERED);
  assert.equal(resume.nextIndex, 2, 'must resume on the first unanswered card (index 2)');
  assert.deepEqual(resume.remainingIds, ['challenge']);
  assert.equal(resume.complete, false);
});

test('T2: MUTATION (RED) — removing the answered-skip restarts at question 1', async () => {
  const src = fs.readFileSync(SOURCE, 'utf-8');
  const needle = '    if (answered.has(q.id)) return;';
  assert.ok(src.includes(needle), 'the load-bearing answered-skip line must exist');

  // Remove the answered-skip → every question looks unanswered → nextIndex 0.
  const mutated = src.replace(needle, '    // MUTATION: answered-skip removed');
  assert.notEqual(mutated, src, 'mutation must change the source');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u051-mut-'));
  const mutFile = path.join(tmp, 'structured-progress.mutated.ts');
  // The runner is tsx, so the mutated source can be imported as TypeScript
  // directly — no manual type-stripping (which is fragile). structured-progress
  // is self-contained (pure functions, no imports), so the mutated copy stands
  // alone.
  fs.writeFileSync(mutFile, mutated);

  try {
    const mod = await import(pathToFileURL(mutFile).href);
    const resume = mod.computeStructuredResume(QUESTIONS, ANSWERED);
    // RED: with the skip gone, resume restarts at index 0 (question 1) — the
    // regression U051 closes.
    assert.equal(resume.nextIndex, 0, 'MUTATION must restart at question 1 (index 0) — RED');
    assert.deepEqual(resume.remainingIds, ['company_name', 'industry', 'challenge'],
      'MUTATION must treat every question as unanswered');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('T3: GREEN — the real module still resumes on index 2 (mutation reverted)', () => {
  const resume = computeStructuredResume(QUESTIONS, ANSWERED);
  assert.equal(resume.nextIndex, 2, 'the real module must still resume on index 2 — GREEN');
  assert.deepEqual(resume.remainingIds, ['challenge']);
});
