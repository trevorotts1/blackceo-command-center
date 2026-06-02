/**
 * AI Workforce interview / discovery question set (D1).
 *
 * The Command Center's onboarding interview gathers the facts needed to build
 * and brand a client's zero-human company. This module is the in-repo source of
 * truth for the BRANDING portion of that question set — in particular the
 * brand-color question, which must:
 *
 *   - ASK the client for their brand colors,
 *   - ask whether they know the exact HEX codes,
 *   - if they DON'T, accept plain color NAMES ("navy", "forest green", "coral")
 *     and resolve name → hex automatically (see resolveBrandColor in
 *     src/lib/branding.ts), and
 *   - store the resolved primary on the client tenant record (clients.brand_color).
 *
 * Keeping the questions here (rather than only in the external Skill-23 prompt)
 * lets the in-app discovery UI render them and lets tests assert the brand
 * question exists and resolves names.
 */

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
  /** Where the answer is stored. `client.<col>` → clients tenant record. */
  storeOn:
    | 'client.name'
    | 'client.brand_color'
    | 'client.logo_url'
    | 'company.industry'
    | 'company.commandCenterName';
  required?: boolean;
}

/**
 * The branding questions. D1 lives in `brand_primary_color`: it explicitly asks
 * for a hex code AND accepts a color name as a fallback.
 */
export const BRANDING_QUESTIONS: InterviewQuestion[] = [
  {
    id: 'brand_primary_color',
    section: 'branding',
    prompt: 'What is your primary brand color?',
    help:
      "If you know the exact hex code (like #1E3A8A) enter it. If not, just type the color name — for example \"navy\", \"forest green\", or \"coral\" — and we'll convert it to the right hex automatically.",
    kind: 'color',
    storeOn: 'client.brand_color',
    required: false,
  },
  {
    id: 'brand_logo',
    section: 'branding',
    prompt: 'Do you have a logo? Paste a public link to it (or upload one).',
    help:
      "We'll use your logo across the Command Center in place of the default, and upload it to your GoHighLevel media library so it's available for your funnels and emails too.",
    kind: 'url',
    storeOn: 'client.logo_url',
    required: false,
  },
];

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
