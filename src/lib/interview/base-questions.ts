/**
 * base-questions.ts — the CC-owned (non-branding) structured questions of the
 * AI Workforce Interview, in ONE client-safe module.
 *
 * WHY: the two identity questions used to be defined TWICE — once in the
 * Node-only src/lib/interview-questions.ts and once inline in
 * InterviewClient.tsx ("a byte-for-byte mirror … kept inline") — a hand-synced
 * duplication that would silently drift. This module is pure data with zero
 * Node imports, so BOTH sides import the same array and drift is impossible.
 *
 * SCOPE: identity + operations questions only. The BRANDING section's single
 * source of truth remains the onboarding repo's canonical
 * 23-ai-workforce-blueprint/interview/branding-questions.json (vendored at
 * src/lib/interview-questions.branding-questions.json, pinned by the CI sync
 * test) — never define or edit branding questions here.
 *
 * QUESTION QUALITY NOTES (v4.63):
 *   • company_name gains help copy — owners were unsure whether to give the
 *     legal name or the brand name; the display name is what every surface uses.
 *   • industry's help now also explains WHY we ask (it shapes which departments
 *     are recommended), which measurably improves answer specificity.
 *   • command_center_name is NEW and completes the pre-plumbed `operations`
 *     section (its section labels/milestones already existed with zero
 *     questions). It fills company.commandCenterName — previously only settable
 *     by an operator in Settings after closeout — so the home screen the owner
 *     unlocks is already named in their own words. Optional by design.
 */

/** Kinds of structured answers (mirrored from interview-questions.ts). */
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
  /** Guidance for the interviewer (not shown to the client). */
  interviewGuidance?: string;
  /** Hint for the value resolver (e.g. resolveBrandColor). */
  resolverHint?: string;
  /** Interview phase this question belongs to. */
  phase?: string;
}

/** The identity questions that open the structured set. */
export const IDENTITY_QUESTIONS: InterviewQuestion[] = [
  {
    id: 'company_name',
    section: 'identity',
    prompt: 'What is your company name?',
    help: 'The name you want on everything we build — your dashboard, documents, and materials. If your everyday brand name differs from the legal name, use the brand name.',
    kind: 'text',
    storeOn: 'client.name',
    required: true,
  },
  {
    id: 'industry',
    section: 'identity',
    prompt: 'What industry are you in?',
    help: 'For example: SaaS, e-commerce, healthcare, real estate, coaching. This shapes which departments we recommend for you, so the more specific the better — "residential real estate" beats "real estate".',
    kind: 'text',
    storeOn: 'company.industry',
    required: true,
  },
];

/** The operations questions that close the structured set (after branding). */
export const OPERATIONS_QUESTIONS: InterviewQuestion[] = [
  {
    id: 'command_center_name',
    section: 'operations',
    prompt: "What would you like to name your company's home base?",
    help: 'This is the screen where you’ll watch your company work — many owners name it something personal, like "Mission Control" or "The Bridge". Skip it and we’ll use a sensible default you can change anytime.',
    kind: 'text',
    storeOn: 'company.commandCenterName',
    required: false,
    interviewGuidance:
      'Optional flavor question — never drill. Any non-empty answer is accepted verbatim; it becomes the dashboard title the owner sees at closeout.',
  },
];
