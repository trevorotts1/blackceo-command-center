/**
 * answer-payload.ts — the ONE builder for the POST /api/interview/answer body.
 *
 * WHY THIS MODULE EXISTS (the bug it closes)
 * ------------------------------------------
 * The structured cards (QuestionCard / ColorPickerCard / LogoDropCard) used to
 * post `{ questionId, storeOn, kind, value }` while the route's zod schema
 * required `{ questionId?, prompt?, answer }` — so EVERY structured submit
 * failed schema validation with a 400 and the owner saw "Something went wrong
 * saving that" on every card. The client and the route each declared the
 * contract locally and drifted.
 *
 * This module is the single, shared source of that request shape:
 *   • the cards build their body EXCLUSIVELY through buildAnswerPayload();
 *   • tests/unit/interview-answer-contract.test.ts parses the builder's output
 *     with the route's OWN exported zod schema, so any future drift fails CI
 *     instead of failing owners.
 *
 * PURE + client-safe: no Node imports, no fetch — just shaping.
 */

/** The request body POST /api/interview/answer accepts (mirrors its zod schema). */
export interface InterviewAnswerBody {
  /** Stable interview-questions.ts id (resolves prompt + storeOn server-side). */
  questionId?: string;
  /** The CANONICAL question text. Always sent so the transcript records the real
   *  question even if the server's question set is older/newer than the client's.
   *  NOTE: when the on-screen prompt was personalized ("What does Acme make?"),
   *  callers MUST still pass the canonical prompt here (see personalizePrompt). */
  prompt?: string;
  /** The owner's answer value (validated text / resolved hex / logo URL). */
  answer: string;
  /** Progress stamp: interview phase (pressed through to update-interview-state.sh). */
  phase?: string;
  /** Progress stamp: 1-based question number in the owner's journey. */
  questionNumber?: number;
  /** Provenance of who asked (defaults server-side to the web surface). */
  askedBy?: string;
  /** When this answer CONFIRMS a fact we already had on file, the source of that
   *  fact — recorded as `confirmed-from-context: <source>` provenance so QC
   *  check #5 classifies it as confirmed, never fabricated. */
  confirmedFromContext?: string;
  /** Interview session attribution for the read-mirror (optional). */
  sessionId?: string;
}

export interface BuildAnswerPayloadArgs {
  /** The structured question being answered (canonical prompt + stable id). */
  question: { id: string; prompt: string; phase?: string; section?: string };
  /** The final, client-validated value. */
  value: string;
  /** 1-based position of this question in the structured set (progress stamp). */
  questionNumber?: number;
  /** Confirm-from-context source, when the owner confirmed a known fact. */
  confirmedFromContext?: string;
  /** Interview session attribution (optional). */
  sessionId?: string | null;
}

/** Map a structured section to the interview phase update-interview-state.sh
 *  stamps. Branding questions carry an explicit `phase` (e.g. "phase3") from the
 *  canonical JSON; identity/operations fall back to their section names. */
export function phaseForQuestion(q: { phase?: string; section?: string }): string {
  if (q.phase && q.phase.trim()) return q.phase.trim();
  return q.section && q.section.trim() ? q.section.trim() : 'structured';
}

/**
 * Build the exact body the /api/interview/answer route validates. Keys with
 * empty/undefined values are omitted (the schema treats absent and undefined
 * identically; omitting keeps the wire payload minimal and log-friendly).
 */
export function buildAnswerPayload(args: BuildAnswerPayloadArgs): InterviewAnswerBody {
  const body: InterviewAnswerBody = {
    questionId: args.question.id,
    prompt: args.question.prompt,
    answer: args.value,
    phase: phaseForQuestion(args.question),
  };
  if (typeof args.questionNumber === 'number' && args.questionNumber > 0) {
    body.questionNumber = args.questionNumber;
  }
  if (args.confirmedFromContext && args.confirmedFromContext.trim()) {
    body.confirmedFromContext = args.confirmedFromContext.trim();
  }
  if (args.sessionId && args.sessionId.trim()) {
    body.sessionId = args.sessionId.trim();
  }
  return body;
}
