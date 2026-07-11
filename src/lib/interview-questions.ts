/**
 * AI Workforce interview / discovery question set (D1).
 *
 * The Command Center's onboarding interview gathers the facts needed to build
 * and brand a client's zero-human company.
 *
 * BRANDING SECTION — single source of truth is the onboarding repo:
 *   openclaw-onboarding/23-ai-workforce-blueprint/interview/branding-questions.json
 *
 * The vendored copy lives at:
 *   src/lib/interview-questions.branding-questions.json
 *
 * DO NOT hand-edit BRANDING_QUESTIONS in this file. Edit the canonical source
 * in the onboarding repo, then update the vendored copy here. The sync test at
 * scripts/sync-branding-questions-test.ts will fail if the two diverge on any
 * question id, prompt, storeOn, or kind field — keeping the two repos in lock-step.
 *
 * To update the vendored copy after changing the canonical source:
 *   cp path/to/openclaw-onboarding/23-ai-workforce-blueprint/interview/branding-questions.json \
 *      src/lib/interview-questions.branding-questions.json
 *   npm run test:sync:branding  # must pass before committing
 */

import { createRequire } from 'node:module';
import {
  IDENTITY_QUESTIONS,
  OPERATIONS_QUESTIONS,
  type InterviewAnswerKind,
  type InterviewQuestion,
} from './interview/base-questions';

const _require = createRequire(import.meta.url);
const brandingQuestionsRaw: {
  questions: InterviewQuestion[];
  [key: string]: unknown;
} = _require('./interview-questions.branding-questions.json');

// The question/kind types + the CC-owned (identity/operations) question arrays
// live in the client-safe src/lib/interview/base-questions.ts so the browser
// bundle and this Node module can never drift. Re-exported for compatibility.
export type { InterviewAnswerKind, InterviewQuestion };
export { IDENTITY_QUESTIONS, OPERATIONS_QUESTIONS };

/**
 * Branding questions sourced from the vendored onboarding canonical file.
 * Shape is asserted at import time via the typed _require call above;
 * any structural mismatch is a TypeScript error.
 */
export const BRANDING_QUESTIONS: InterviewQuestion[] =
  brandingQuestionsRaw.questions;

/** The full ordered interview question set: identity → branding → operations. */
export const INTERVIEW_QUESTIONS: InterviewQuestion[] = [
  ...IDENTITY_QUESTIONS,
  ...BRANDING_QUESTIONS,
  ...OPERATIONS_QUESTIONS,
];
