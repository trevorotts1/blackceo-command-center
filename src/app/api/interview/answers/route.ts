/**
 * GET /api/interview/answers  (P2-6 review read-back)
 *
 * The READ-ONLY answers-list surface the ReviewScreen renders. It reads the
 * canonical interview FILES through the P0-1 seam and returns the grouped
 * read-back the owner reviews before the gated build:
 *
 *   {
 *     groups: [{ phase, label, answers: [{ questionId?, question, answer,
 *                                          loggedAt?, id, provenance?, editable }] }],
 *     synthesis?: string,   // the agent's plain-English read-back, when present
 *     skipped: number[],    // question numbers the owner passed on (from handoff)
 *   }
 *
 * DOCTRINE (do not violate):
 *   • The FILES are the single source of truth. This route READS
 *       - <workspace>/company-discovery/workforce-interview-answers.md (Q/A)
 *       - <workspace>/company-discovery/interview-handoff.md           (resume + synthesis)
 *       - <workspace>/.workforce-build-state.json                      (progress)
 *     via the seam's pure fs readers (readAnswerBlocks / readHandoff /
 *     readInterviewProgress / readInterviewSynthesis) and returns their derived,
 *     UI-facing shape. It performs NO writes and execFiles NO Skill-23 script
 *     (SAFETY — no update-interview-state.sh / record-dept-decision.sh /
 *     list-canonical-departments.py). It NEVER touches build-state, a decision,
 *     or interviewComplete.
 *   • Missing / garbage files degrade to empty groups (never a throw). Fail-soft:
 *     any unexpected error returns 200 with empty groups so the review screen
 *     renders its calm empty state rather than an error.
 *
 * Grouping: the transcript does not record a per-block phase, so each block's
 * question text is matched (best-effort) against the INTERVIEW_QUESTIONS set to
 * recover its section/phase; unmatched blocks fall into a single "Your answers"
 * group. Order is first-seen, so the read-back reads top-to-bottom like the
 * interview. Structured branding answers (brand color / logo) are marked
 * editable:false so they keep their strict storeOn validation on the card path.
 */

import { NextResponse } from 'next/server';
import {
  readBuildState,
  readAnswerBlocks,
  readHandoff,
  readInterviewSynthesis,
  type AnswerBlock,
} from '@/lib/interview/seam';
import { INTERVIEW_QUESTIONS, type InterviewQuestion } from '@/lib/interview-questions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/* -------------------------------------------------------------------------- */
/* response shapes                                                             */
/* -------------------------------------------------------------------------- */

interface AnswersRouteAnswer {
  /** Stable positional row key (1-based index in the append-only transcript). */
  id: string;
  /** The interview-questions.ts id, when the question text resolves to one. */
  questionId?: string;
  /** The exact question that was asked (verbatim). */
  question: string;
  /** The current answer text. */
  answer: string;
  /** The `**Logged:**` human timestamp, when the block carries one. */
  loggedAt?: string;
  /** Any provenance note on the block (confirmed-from-context / updated-on). */
  provenance?: string;
  /** False for structured branding answers (color/logo) — not free-text editable. */
  editable: boolean;
}

interface AnswersGroup {
  /** Machine key for the group (a question phase, a section id, or 'general'). */
  phase: string;
  /** Human, display-facing group heading. */
  label: string;
  answers: AnswersRouteAnswer[];
}

interface AnswersResponse {
  groups: AnswersGroup[];
  synthesis?: string;
  skipped: number[];
}

/* -------------------------------------------------------------------------- */
/* question matching + grouping                                                */
/* -------------------------------------------------------------------------- */

/** Friendly, display-facing heading for a known interview section. */
const SECTION_LABELS: Record<InterviewQuestion['section'], string> = {
  identity: 'About your company',
  branding: 'Your brand',
  operations: 'How you operate',
};

const DEFAULT_GROUP = { phase: 'general', label: 'Your answers' } as const;

/** Normalize a question prompt for tolerant matching (lowercase, collapse ws). */
function normPrompt(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Index INTERVIEW_QUESTIONS by normalized prompt for O(1) block → question match. */
function buildPromptIndex(): Map<string, InterviewQuestion> {
  const idx = new Map<string, InterviewQuestion>();
  for (const q of INTERVIEW_QUESTIONS) {
    const key = normPrompt(q.prompt);
    if (key && !idx.has(key)) idx.set(key, q);
  }
  return idx;
}

/** Resolve the {phase, label} group a matched (or unmatched) question belongs to. */
function groupFor(q: InterviewQuestion | undefined): { phase: string; label: string } {
  if (!q) return { ...DEFAULT_GROUP };
  if (q.phase && q.phase.trim()) {
    // A phase is already a human-ish label; reuse it for both keys.
    return { phase: q.phase.trim(), label: q.phase.trim() };
  }
  return { phase: q.section, label: SECTION_LABELS[q.section] ?? q.section };
}

/** Structured branding answers (color/logo) are not free-text editable here. */
function isEditable(q: InterviewQuestion | undefined): boolean {
  if (!q) return true;
  return q.storeOn !== 'client.brand_color' && q.storeOn !== 'client.logo_url';
}

/**
 * Turn the parsed transcript blocks into phase-grouped answers, preserving
 * first-seen order at both the group and answer level. Each block keeps its
 * 1-based positional index as a stable id (matching the read-mirror key).
 */
function toGroups(blocks: AnswerBlock[]): AnswersGroup[] {
  const promptIndex = buildPromptIndex();
  const order: string[] = [];
  const byPhase = new Map<string, AnswersGroup>();

  blocks.forEach((b, i) => {
    const q = promptIndex.get(normPrompt(b.question));
    const g = groupFor(q);
    let group = byPhase.get(g.phase);
    if (!group) {
      group = { phase: g.phase, label: g.label, answers: [] };
      byPhase.set(g.phase, group);
      order.push(g.phase);
    }
    const answer: AnswersRouteAnswer = {
      id: String(i + 1),
      question: b.question,
      answer: b.answer,
      editable: isEditable(q),
    };
    if (q) answer.questionId = q.id;
    if (b.loggedAt) answer.loggedAt = b.loggedAt;
    if (b.provenance) answer.provenance = b.provenance;
    group.answers.push(answer);
  });

  return order.map((phase) => byPhase.get(phase)!);
}

/* -------------------------------------------------------------------------- */
/* handler                                                                     */
/* -------------------------------------------------------------------------- */

export async function GET() {
  try {
    const state = readBuildState();
    const blocks = readAnswerBlocks(state);
    const handoff = readHandoff();
    const synthesis = readInterviewSynthesis();

    const body: AnswersResponse = {
      groups: toGroups(blocks),
      skipped: handoff.skippedQuestions ?? [],
    };
    if (synthesis) body.synthesis = synthesis;

    return NextResponse.json(body);
  } catch {
    // Fail-soft: empty read-back so the review screen shows its calm empty state
    // instead of an error. This route never writes, so there is nothing to unwind.
    const empty: AnswersResponse = { groups: [], skipped: [] };
    return NextResponse.json(empty, { status: 200 });
  }
}
