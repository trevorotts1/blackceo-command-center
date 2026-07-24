/**
 * u050-interview-questions-from-bank.test.ts — U050 regression guard.
 *
 * Proves the interview flow is driven from a CONFIGURABLE question bank, not
 * hardcoded question literals in the React component (InterviewClient.tsx):
 *
 *   T1  the component imports IDENTITY_QUESTIONS + OPERATIONS_QUESTIONS from the
 *       shared client-safe module (@/lib/interview/base-questions)
 *   T2  the component imports the branding set from the vendored JSON bank
 *       (interview-questions.branding-questions.json)
 *   T3  the component contains NO inline question object literals — adding or
 *       reordering a question requires editing the bank, not the component
 *   T4  MUTATION: planting an inline question literal in the component makes T3
 *       FAIL (RED); removing it restores GREEN — the guard has teeth
 *
 * Static source inspection (no DB, no network).
 * Run: node --import tsx --test tests/unit/u050-interview-questions-from-bank.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const COMPONENT = path.join(REPO_ROOT, 'src', 'app', 'interview', 'InterviewClient.tsx');

function readComponent(): string {
  return fs.readFileSync(COMPONENT, 'utf-8');
}

test('T1: the component imports identity + operations questions from the shared bank module', () => {
  const src = readComponent();
  assert.match(
    src,
    /import\s*\{[^}]*IDENTITY_QUESTIONS[^}]*\}\s*from\s*['"]@\/lib\/interview\/base-questions['"]/,
    'InterviewClient must import IDENTITY_QUESTIONS from the shared base-questions module',
  );
  assert.match(
    src,
    /import\s*\{[^}]*OPERATIONS_QUESTIONS[^}]*\}\s*from\s*['"]@\/lib\/interview\/base-questions['"]/,
    'InterviewClient must import OPERATIONS_QUESTIONS from the shared base-questions module',
  );
});

test('T2: the component imports the branding set from the vendored JSON bank', () => {
  const src = readComponent();
  assert.match(
    src,
    /import\s+\w+\s+from\s+['"]@\/lib\/interview-questions\.branding-questions\.json['"]/,
    'InterviewClient must import the branding questions from the vendored JSON bank',
  );
});

test('T3: the component contains NO inline question object literals', () => {
  const src = readComponent();
  // An inline question definition looks like { id: 'some_id', prompt: ... } or
  // { id: 'some_id', question: ... } — a question object literal baked into the
  // component. The bank-driven component must have none.
  const inlineQuestion = /\{\s*id:\s*['"][a-z0-9_-]+['"]\s*,\s*(prompt|question|label)\s*:/i;
  assert.doesNotMatch(
    src,
    inlineQuestion,
    'InterviewClient must not contain inline question object literals — questions come from the bank',
  );
});

test('T4: MUTATION — planting an inline question literal makes the guard FAIL (RED), removing it restores GREEN', () => {
  const src = readComponent();
  // Plant an inline question literal (the pre-fix shape).
  const mutated = src.replace(
    'const STRUCTURED_QUESTIONS: InterviewQuestion[] = [',
    'const PLANTED: InterviewQuestion[] = [{ id: "planted_q", prompt: "inline?" }];\nconst STRUCTURED_QUESTIONS: InterviewQuestion[] = [',
  );
  assert.notEqual(mutated, src, 'mutation must actually change the source');
  const inlineQuestion = /\{\s*id:\s*['"][a-z0-9_-]+['"]\s*,\s*(prompt|question|label)\s*:/i;
  // RED: the mutated source matches the inline-question pattern.
  assert.match(mutated, inlineQuestion, 'the planted inline literal must be detected (RED)');
  // GREEN: the original source does not.
  assert.doesNotMatch(src, inlineQuestion, 'the original source must stay clean (GREEN)');
});
