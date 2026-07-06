/**
 * structured-progress.ts — PURE, client-safe helpers for the structured half of
 * the AI Workforce Interview (continuity/P5-1).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Before this pass, the structured question position (`structIndex`) lived ONLY
 * in client component state. A refresh mid-set either restarted the owner at
 * question 1 (duplicating transcript blocks for questions they had already
 * answered) or — when a handoff existed — dropped them into the free-form
 * conversation, silently skipping every remaining structured card. The server
 * always KNEW which structured questions were answered (the transcript records
 * each Q/A block verbatim); nothing recomputed the position from that truth.
 *
 * This module is that recomputation, shared by BOTH sides so they can never
 * drift:
 *   • the /api/interview/state route (Node) matches transcript blocks against
 *     INTERVIEW_QUESTIONS and reports `structured.answeredIds`;
 *   • the client (browser) folds those ids over its mirrored question set to
 *     land the owner on the FIRST unanswered card — exactly where they left off.
 *
 * DOCTRINE
 * --------
 * Pure functions only. No fs, no child_process, no Node imports — this file is
 * imported by client bundles AND API routes. It reads nothing and writes
 * nothing; callers supply the parsed blocks / question sets.
 *
 * Prompt matching mirrors /api/interview/answers (normPrompt: lowercase +
 * collapse whitespace). The transcript stores the CANONICAL prompt (cards always
 * POST `question.prompt`, even when the on-screen copy is personalized), so an
 * exact normalized match is reliable — no fuzzy matching needed.
 */

/** The minimal question shape these helpers need (client + server compatible). */
export interface StructuredQuestionLike {
  id: string;
  prompt: string;
  section: string;
  required?: boolean;
}

/** One transcript Q/A block (question text as asked + current answer). */
export interface AnswerBlockLike {
  question: string;
  answer: string;
}

/** Where a paused owner should resume inside the structured set. */
export interface StructuredResume {
  /** Total structured questions in the set. */
  total: number;
  /** ids (in set order) that already carry a transcript answer. */
  answeredIds: string[];
  /** ids (in set order) not yet answered. */
  remainingIds: string[];
  /** Index of the FIRST unanswered question, or null when the set is complete. */
  nextIndex: number | null;
  /** True when every structured question has a recorded answer. */
  complete: boolean;
}

/** Normalize a prompt for tolerant matching — lowercase, collapse whitespace.
 *  Byte-identical to the /api/interview/answers route's normPrompt. */
export function normPrompt(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Index a question set by normalized prompt (first definition wins). */
export function buildPromptIndex<Q extends StructuredQuestionLike>(
  questions: readonly Q[],
): Map<string, Q> {
  const idx = new Map<string, Q>();
  for (const q of questions) {
    const key = normPrompt(q.prompt);
    if (key && !idx.has(key)) idx.set(key, q);
  }
  return idx;
}

/**
 * The set of structured question ids that already have a transcript answer.
 * A block matches a question when its recorded question text normalizes to the
 * question's canonical prompt. Blocks that match no structured question (the
 * conversational depth) are ignored. Blocks with an empty answer are ignored
 * too — an empty answer is not an answer.
 */
export function computeAnsweredIds(
  blocks: readonly AnswerBlockLike[],
  questions: readonly StructuredQuestionLike[],
): string[] {
  const idx = buildPromptIndex(questions);
  const answered = new Set<string>();
  for (const b of blocks) {
    if (!b.answer || !b.answer.trim()) continue;
    const q = idx.get(normPrompt(b.question));
    if (q) answered.add(q.id);
  }
  // Preserve set order (stable for UI rendering + tests).
  return questions.filter((q) => answered.has(q.id)).map((q) => q.id);
}

/**
 * Fold answered ids over the ordered question set → the exact resume position.
 * `nextIndex` is the first index whose id is NOT answered; null when complete.
 */
export function computeStructuredResume(
  questions: readonly StructuredQuestionLike[],
  answeredIds: readonly string[],
): StructuredResume {
  const answered = new Set(answeredIds);
  const remainingIds: string[] = [];
  let nextIndex: number | null = null;
  questions.forEach((q, i) => {
    if (answered.has(q.id)) return;
    remainingIds.push(q.id);
    if (nextIndex === null) nextIndex = i;
  });
  return {
    total: questions.length,
    answeredIds: questions.filter((q) => answered.has(q.id)).map((q) => q.id),
    remainingIds,
    nextIndex,
    complete: remainingIds.length === 0,
  };
}

/**
 * Given the current index and the answered/skipped sets, the NEXT structured
 * index to show (skipping questions that already have an answer), or null when
 * no structured card remains after `fromIndex`. Skipped-but-unanswered
 * questions are NOT auto-skipped — they stay in the deck only when the owner
 * explicitly circles back (the caller passes them in `alsoSkip` to move past
 * them in the forward pass).
 */
export function nextStructuredIndex(
  questions: readonly StructuredQuestionLike[],
  fromIndex: number,
  answeredIds: ReadonlySet<string> | readonly string[],
  alsoSkip: ReadonlySet<string> | readonly string[] = [],
): number | null {
  const answered = answeredIds instanceof Set ? answeredIds : new Set(answeredIds);
  const skipped = alsoSkip instanceof Set ? alsoSkip : new Set(alsoSkip);
  for (let i = Math.max(0, fromIndex); i < questions.length; i++) {
    const id = questions[i].id;
    if (answered.has(id) || skipped.has(id)) continue;
    return i;
  }
  return null;
}

/* ────────────────────────── prompt personalization ─────────────────────────── */

/**
 * Personalize the ON-SCREEN copy of a prompt with facts from earlier answers
 * (the memory affordance): once the owner has told us their company name, later
 * questions address the company by name instead of "your company".
 *
 * IMPORTANT: this is PRESENTATION ONLY. The card always POSTs the CANONICAL
 * `question.prompt` to /api/interview/answer, so the transcript records the
 * canonical question and prompt-matching (above) stays exact. Never feed a
 * personalized string back into the transcript.
 */
export function personalizePrompt(prompt: string, companyName?: string | null): string {
  const name = (companyName ?? '').trim();
  if (!name) return prompt;
  // Possessive form first ("your company's home base" → "Acme's home base"),
  // then the plain subject form. Names already ending in s get a bare apostrophe.
  const possessive = /s$/i.test(name) ? `${name}'` : `${name}'s`;
  return prompt
    .replace(/\byour company['’]s\b/gi, possessive)
    .replace(/\byour company\b/gi, name)
    .replace(/\byour brand\b/gi, `the ${name} brand`);
}
