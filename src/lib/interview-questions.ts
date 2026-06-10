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

const _require = createRequire(import.meta.url);
const brandingQuestionsRaw: {
  questions: InterviewQuestion[];
  [key: string]: unknown;
} = _require('./interview-questions.branding-questions.json');

export type InterviewAnswerKind = 'text' | 'color' | 'url' | 'choice';

export interface InterviewQuestion {
  /** Stable id used when persisting the answer. */
  id: string;
  /** Which interview section it belongs to. */
  section: 'identity' | 'branding' | 'operations';
  /** The question shown to the client. */
  prompt: string;
  /** Helper / clarifying text shown under the prompt. */
  help?: string;
  kind: InterviewAnswerKind;
  /**
   * Where the answer is stored. `client.<col>` → clients tenant record;
   * `company.<col>` → company-level config.
   */
  storeOn:
    | 'client.name'
    | 'client.brand_color'
    | 'client.logo_url'
    | 'company.industry'
    | 'company.commandCenterName'
    | 'company.brand_voice'
    | 'company.brand_evokes'
    | 'company.customer_feeling'
    | 'company.brand_descriptors'
    | 'company.ideal_customer'
    | 'company.unique_differentiator';
  required?: boolean;
  /** Guidance for the interviewer agent (not shown to the client). */
  interviewGuidance?: string;
  /** Hint for the value resolver (e.g. resolveBrandColor). */
  resolverHint?: string;
  /** Interview phase this question belongs to. */
  phase?: string;
}

/**
 * Branding questions sourced from the vendored onboarding canonical file.
 * Shape is asserted at import time via the typed _require call above;
 * any structural mismatch is a TypeScript error.
 */
export const BRANDING_QUESTIONS: InterviewQuestion[] =
  brandingQuestionsRaw.questions;

/** The full ordered interview question set (branding section included). */
export const INTERVIEW_QUESTIONS: InterviewQuestion[] = [
  {
    id: 'company_name',
    section: 'identity',
    prompt: 'What is your company name?',
    kind: 'text',
    storeOn: 'client.name',
    required: true,
  },
  {
    id: 'industry',
    section: 'identity',
    prompt: 'What industry are you in?',
    help: 'e.g. SaaS, e-commerce, healthcare, real estate.',
    kind: 'text',
    storeOn: 'company.industry',
    required: true,
  },
  ...BRANDING_QUESTIONS,
];
