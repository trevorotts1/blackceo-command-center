/**
 * answer-schema.ts — the ONE zod schema for POST /api/interview/answer bodies.
 *
 * Lives outside the route file so the contract test
 * (tests/unit/interview-answer-contract.test.ts) can parse client-built
 * payloads with the route's REAL schema without importing next/server — the
 * route imports THIS module, so route and test can never see different rules.
 *
 * See src/lib/interview/answer-payload.ts for the client-side builder this
 * schema pins (the pre-v4.63 drift 400'd every structured card submit).
 */

import { z } from 'zod';

/** Ordinary answers stay bounded at 20k chars; an inline (data:image/…) logo is
 *  allowed up to ~2.9M chars (a 2MB image base64-encoded — the LogoDropCard cap). */
export const MAX_TEXT_ANSWER_CHARS = 20_000;
export const MAX_DATA_URL_CHARS = 2_900_000;

/** True for a data:image/… URL (the LogoDropCard file-drop shape). */
export function isDataImageUrl(value: string): boolean {
  return /^data:image\/[a-z0-9.+-]+;/i.test(value.trim());
}

export const answerRequestSchema = z
  .object({
    // Preferred: the stable interview-questions.ts id (resolves prompt + storeOn).
    questionId: z.string().min(1).max(128).optional(),
    // The question text actually shown to the client. Required only when questionId
    // is absent/unknown (so the transcript always records a real question line).
    prompt: z.string().min(1).max(2000).optional(),
    // The client's answer value (a color, a URL, an inline logo, or free text).
    answer: z.string().min(1).max(MAX_DATA_URL_CHARS),
    // Progress stamp inputs (pressed straight through to update-interview-state.sh).
    phase: z.string().min(1).max(64).optional(),
    questionNumber: z.number().int().min(0).max(100000).optional(),
    // Who asked — provenance for the state stamp. Defaults to the web surface.
    askedBy: z.string().min(1).max(128).optional(),
    // When this answer CONFIRMS a known-context fact, the source is recorded as a
    // `confirmed-from-context: <source>` provenance note inside the Q/A block, so
    // qc-interview-completion.py check #5 classifies it as confirmed, not fabricated.
    confirmedFromContext: z.string().min(1).max(256).optional(),
    // Interview session attribution (optional, tolerated for the read-mirror).
    sessionId: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine(
    (b) => isDataImageUrl(b.answer) || b.answer.length <= MAX_TEXT_ANSWER_CHARS,
    {
      message: `answer exceeds ${MAX_TEXT_ANSWER_CHARS} characters (only an inline logo image may be longer)`,
      path: ['answer'],
    },
  );

export type AnswerRequestBody = z.infer<typeof answerRequestSchema>;
