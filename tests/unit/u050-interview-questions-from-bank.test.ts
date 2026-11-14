/**
 * u050-interview-questions-from-bank.test.ts — U050 regression guard.
 *
 * Proves the interview flow is driven from a CONFIGURABLE question bank, not
 * hardcoded question literals in the React component (InterviewClient.tsx).
 *
 * BU-14 moved the page onto the step gate, so the guard now pins the new shape:
 *
 *   T1  the component asks the gate for the current question
 *       (GET /api/interview/next) instead of holding the question set itself
 *   T2  the component names set-aside questions from the vendored v2 registry
 *       (interview-questions.v2.json) — never from its own copy
 *   T3  the component contains NO inline question object literals
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

test('T1: the component asks the step gate for the current question', () => {
  const src = readComponent();
  assert.match(
    src,
    /fetch\(\s*['"]\/api\/interview\/next['"]/,
    'InterviewClient must read the current question from GET /api/interview/next',
  );
});

test('T2: the component names set-aside questions from the vendored v2 registry', () => {
  const src = readComponent();
  assert.match(
    src,
    /import\s+\w+\s+from\s+['"]@\/lib\/interview-questions\.v2\.json['"]/,
    'InterviewClient must import the vendored v2 registry for question wording',
  );
});

test('T3: the component contains NO inline question object literals', () => {
  const src = readComponent();
  // An inline question definition looks like { id: 'some_id', prompt: ... } or
  // { id: 'some_id', question: ... } — a question object literal baked into the
  // component. The gate-driven component must have none.
  const inlineQuestion = /\{\s*id:\s*['"][a-z0-9_-]+['"]\s*,\s*(prompt|question|label)\s*:/i;
  assert.doesNotMatch(
    src,
    inlineQuestion,
    'InterviewClient must not contain inline question object literals — questions come from the registry',
  );
});

test('T4: MUTATION — planting an inline question literal makes the guard FAIL (RED), removing it restores GREEN', () => {
  const src = readComponent();
  // Plant an inline question literal (the pre-U050 shape).
  const mutated = `const PLANTED = [{ id: "planted_q", prompt: "inline?" }];\n${src}`;
  assert.notEqual(mutated, src, 'mutation must actually change the source');
  const inlineQuestion = /\{\s*id:\s*['"][a-z0-9_-]+['"]\s*,\s*(prompt|question|label)\s*:/i;
  // RED: the mutated source matches the inline-question pattern.
  assert.match(mutated, inlineQuestion, 'the planted inline literal must be detected (RED)');
  // GREEN: the original source does not.
  assert.doesNotMatch(src, inlineQuestion, 'the original source must stay clean (GREEN)');
});
