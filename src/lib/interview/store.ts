/**
 * Interview mirror store — a READ-MIRROR / fast-UI index over the interview
 * files (P2-1). Backed by the `interview_sessions` + `interview_answers` tables
 * created in migration 087.
 *
 * DOCTRINE (do not violate):
 *   • The FILES are the single source of truth. The canonical artifacts
 *       - <workspace>/.workforce-build-state.json
 *       - <workspace>/company-discovery/workforce-interview-answers.md
 *       - <workspace>/company-discovery/interview-handoff.md
 *     are written ONLY through the Skill-23 shell scripts (see seam.ts). This
 *     module is a fast index the UI can read without re-parsing those files on
 *     every request — nothing more.
 *   • This module is NEVER a write authority for `interviewComplete` or for
 *     `canonicalReconciliation.decisions`. By design there is NO interview_complete
 *     column and NO decisions table here — completion + decision authority lives
 *     exclusively in the files (and the scripts that write them). The mirror only
 *     caches derived, UI-facing fields (status / phase / percent / the Q&A list).
 *   • If the mirror and the files ever disagree, the FILES WIN. Callers reconcile
 *     the mirror FROM the files (via the seam), never the files from the mirror.
 *     A mirror write is best-effort: it must never block or override a canonical
 *     file write.
 *
 * The route handlers (mirror-on-write, P2-2) are the only callers of the upsert
 * helpers. Keep the surface small: upsert/get/list for sessions + answers.
 */

import { randomUUID } from 'crypto';
import { queryAll, queryOne, run, transaction } from '../db';

/* ─────────────────────────────── Row shapes ───────────────────────────────── */

/** A mirror of one interview session (keyed by the seam's interviewSessionId). */
export interface InterviewSessionRow {
  id: string;
  client_id: string | null;
  owner_id: string | null;
  channel: string;
  /** Free-text UI status mirror (e.g. 'in_progress' | 'complete'); NON-authoritative. */
  status: string;
  phase: string | null;
  last_question_number: number | null;
  percent: number;
  created_at: string;
  updated_at: string;
}

/** A mirror of one Q/A block from workforce-interview-answers.md (canonical). */
export interface InterviewAnswerRow {
  id: string;
  session_id: string;
  question_number: number | null;
  phase: string | null;
  question: string | null;
  answer: string | null;
  /** Mirror of any provenance note in the file (confirmed-from-context / updated-on). */
  provenance: string | null;
  asked_by: string | null;
  created_at: string;
  updated_at: string;
}

/* ─────────────────────────────── Input shapes ─────────────────────────────── */

export interface UpsertSessionInput {
  /** The stable interviewSessionId (from seam.getOrCreateInterviewSessionId()). */
  id: string;
  clientId?: string | null;
  ownerId?: string | null;
  channel?: string;
  status?: string;
  phase?: string | null;
  lastQuestionNumber?: number | null;
  percent?: number;
}

export interface UpsertAnswerInput {
  sessionId: string;
  questionNumber?: number | null;
  phase?: string | null;
  question?: string | null;
  answer?: string | null;
  provenance?: string | null;
  askedBy?: string | null;
}

/* ─────────────────────────────── Session mirror ───────────────────────────── */

/**
 * Best-effort upsert of a session mirror row. Reflects the CURRENT file-derived
 * status/phase/percent — never decides completion. Only the fields provided are
 * updated on conflict (COALESCE keeps prior values when a field is omitted).
 * Returns the resulting row.
 */
export function upsertSession(input: UpsertSessionInput): InterviewSessionRow {
  run(
    `
    INSERT INTO interview_sessions
      (id, client_id, owner_id, channel, status, phase, last_question_number, percent, created_at, updated_at)
    VALUES
      (?, ?, ?, COALESCE(?, 'web'), COALESCE(?, 'in_progress'), ?, ?, COALESCE(?, 0), datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      client_id            = COALESCE(excluded.client_id, interview_sessions.client_id),
      owner_id             = COALESCE(excluded.owner_id, interview_sessions.owner_id),
      channel              = COALESCE(excluded.channel, interview_sessions.channel),
      status               = COALESCE(excluded.status, interview_sessions.status),
      phase                = COALESCE(excluded.phase, interview_sessions.phase),
      last_question_number = COALESCE(excluded.last_question_number, interview_sessions.last_question_number),
      percent              = COALESCE(excluded.percent, interview_sessions.percent),
      updated_at           = datetime('now')
    `,
    [
      input.id,
      input.clientId ?? null,
      input.ownerId ?? null,
      input.channel ?? null,
      input.status ?? null,
      input.phase ?? null,
      typeof input.lastQuestionNumber === 'number' ? input.lastQuestionNumber : null,
      typeof input.percent === 'number' ? input.percent : null,
    ],
  );
  // Non-null: we just inserted/updated this id.
  return getSession(input.id) as InterviewSessionRow;
}

/** Fetch one session mirror row (or undefined). */
export function getSession(id: string): InterviewSessionRow | undefined {
  return queryOne<InterviewSessionRow>(
    `SELECT * FROM interview_sessions WHERE id = ?`,
    [id],
  );
}

/** List session mirror rows, most-recently-updated first. */
export function listSessions(): InterviewSessionRow[] {
  return queryAll<InterviewSessionRow>(
    `SELECT * FROM interview_sessions ORDER BY datetime(updated_at) DESC, id ASC`,
  );
}

/* ─────────────────────────────── Answer mirror ────────────────────────────── */

/**
 * Best-effort upsert of one Q/A mirror row. Keyed by (session_id, question_number)
 * so a re-answer / inline edit updates the same row instead of duplicating it.
 * When questionNumber is null (a block with no numeric slot) a fresh row is always
 * inserted, since NULLs are distinct under the UNIQUE constraint. Returns the row.
 */
export function upsertAnswer(input: UpsertAnswerInput): InterviewAnswerRow {
  const id = randomUUID();
  run(
    `
    INSERT INTO interview_answers
      (id, session_id, question_number, phase, question, answer, provenance, asked_by, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(session_id, question_number) DO UPDATE SET
      phase      = COALESCE(excluded.phase, interview_answers.phase),
      question   = COALESCE(excluded.question, interview_answers.question),
      answer     = COALESCE(excluded.answer, interview_answers.answer),
      provenance = COALESCE(excluded.provenance, interview_answers.provenance),
      asked_by   = COALESCE(excluded.asked_by, interview_answers.asked_by),
      updated_at = datetime('now')
    `,
    [
      id,
      input.sessionId,
      typeof input.questionNumber === 'number' ? input.questionNumber : null,
      input.phase ?? null,
      input.question ?? null,
      input.answer ?? null,
      input.provenance ?? null,
      input.askedBy ?? null,
    ],
  );
  // Resolve the row we just wrote: prefer the (session, questionNumber) key when
  // present (upsert may have matched an existing row), else the id we inserted.
  const row =
    typeof input.questionNumber === 'number'
      ? queryOne<InterviewAnswerRow>(
          `SELECT * FROM interview_answers WHERE session_id = ? AND question_number = ?`,
          [input.sessionId, input.questionNumber],
        )
      : queryOne<InterviewAnswerRow>(`SELECT * FROM interview_answers WHERE id = ?`, [id]);
  return row as InterviewAnswerRow;
}

/**
 * Prune a session's answer mirror rows so the mirror stays an EXACT reflection of
 * the transcript: deletes any row whose question_number is NULL or greater than
 * `maxQuestionNumber` (the current block count). Used by the mirror-on-write sync
 * (P2-2) after upserting the live blocks. Best-effort / files-win — pruning the
 * mirror never touches a canonical file. Returns the number of rows removed.
 */
export function pruneAnswersBeyond(sessionId: string, maxQuestionNumber: number): number {
  const res = run(
    `DELETE FROM interview_answers
     WHERE session_id = ? AND (question_number IS NULL OR question_number > ?)`,
    [sessionId, maxQuestionNumber],
  );
  return res.changes;
}

/** List a session's answer mirror rows in question order (NULL-numbered last). */
export function listAnswers(sessionId: string): InterviewAnswerRow[] {
  return queryAll<InterviewAnswerRow>(
    `
    SELECT * FROM interview_answers
    WHERE session_id = ?
    ORDER BY (question_number IS NULL), question_number ASC, datetime(created_at) ASC
    `,
    [sessionId],
  );
}

/**
 * Best-effort mirror-sync helper: upsert a session and (optionally) a batch of its
 * answers in one transaction. A convenience for the mirror-on-write routes (P2-2).
 * Callers wrap this in try/catch — a mirror failure NEVER blocks the canonical
 * file write.
 *
 * When `opts.pruneToAnswers` is set AND at least one answer is supplied, any
 * pre-existing answer rows beyond the supplied set (NULL-numbered, or a
 * question_number past the highest supplied) are deleted in the SAME transaction,
 * so the mirror ends up an exact reflection of the transcript. Pruning is skipped
 * when `answers` is empty so a transient empty/failed parse never wipes the mirror.
 */
export function mirrorSession(
  session: UpsertSessionInput,
  answers: UpsertAnswerInput[] = [],
  opts: { pruneToAnswers?: boolean } = {},
): InterviewSessionRow {
  return transaction(() => {
    const row = upsertSession(session);
    for (const a of answers) upsertAnswer(a);
    if (opts.pruneToAnswers && answers.length > 0) {
      const maxQ = answers.reduce(
        (m, a) => (typeof a.questionNumber === 'number' && a.questionNumber > m ? a.questionNumber : m),
        0,
      );
      pruneAnswersBeyond(session.id, maxQ);
    }
    return row;
  });
}
