/**
 * Per-client interview state (JANET-INTERVIEW-FIX phase 2, 2026-08-17).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The shared Command Center serves every client dashboard from ONE process, but
 * the interview's canonical state lives in the OPERATOR's files
 * (.workforce-build-state.json + the encrypted transcript, resolved by
 * interview/paths.ts). Those files are singular and operator-owned: there is
 * exactly one of them on the box. A remote client routed here by hostname has
 * nowhere of its own to keep "which questions have I answered" or "which
 * gateway session am I in".
 *
 * The consequence, observed live: /api/interview/state answered a client tenant
 * with a hardcoded stub (answeredIds: [], nextIndex: 0, interviewSessionId:
 * null), so every page load restarted the structured deck at card 1 and minted
 * a fresh gateway session. A client could answer the entire deck, close the
 * tab, and be asked the identical questions again — indefinitely.
 *
 * This table is that missing per-client store. It is deliberately NARROW:
 *
 *   • answered_ids          which structured question ids this client has
 *                           answered (the resume position)
 *   • interview_session_id  the gateway session minted for this client, so a
 *                           returning browser rejoins its own conversation
 *
 * DOCTRINE
 * --------
 *   • Client tenants ONLY. The operator (self) keeps reading its canonical
 *     files exactly as before — self must never touch this table. That is a
 *     hard regression requirement: the operator path is unchanged.
 *   • Answer CONTENT is never stored here. Only question ids. The transcript
 *     remains the record of what was said.
 *   • Every function fails soft. The interview surface must degrade rather
 *     than 500 when this table is missing or unwritable.
 */

import { getDb } from '@/lib/db';

export interface ClientInterviewState {
  clientId: string;
  interviewSessionId: string | null;
  answeredIds: string[];
  updatedAt: string | null;
}

interface Row {
  client_id: string;
  interview_session_id: string | null;
  answered_ids: string | null;
  updated_at: string | null;
}

/** Parse the stored answered_ids JSON. Tolerates null/garbage → []. */
function parseAnsweredIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

/**
 * Read a client's stored interview state. Returns null when the client has no
 * row yet (a first visit) or when the table is unavailable — callers treat both
 * as "nothing answered yet".
 */
export function getClientInterviewState(clientId: string): ClientInterviewState | null {
  if (!clientId) return null;
  try {
    const row = getDb()
      .prepare(
        `SELECT client_id, interview_session_id, answered_ids, updated_at
           FROM client_interview_state WHERE client_id = ?`,
      )
      .get(clientId) as Row | undefined;
    if (!row) return null;
    return {
      clientId: row.client_id,
      interviewSessionId: row.interview_session_id,
      answeredIds: parseAnsweredIds(row.answered_ids),
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

/**
 * Record that `questionId` now carries an answer for this client. Idempotent:
 * re-answering a question the client already answered does not duplicate the id
 * and does not move the resume position backwards. Returns the resulting id set
 * (or null when the write could not be performed).
 */
export function recordAnsweredQuestion(
  clientId: string,
  questionId: string,
): string[] | null {
  if (!clientId || !questionId) return null;
  try {
    const existing = getClientInterviewState(clientId);
    const ids = existing?.answeredIds ?? [];
    if (ids.includes(questionId)) return ids;
    const next = [...ids, questionId];
    getDb()
      .prepare(
        `INSERT INTO client_interview_state
           (client_id, interview_session_id, answered_ids, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(client_id) DO UPDATE SET
           answered_ids = excluded.answered_ids,
           updated_at   = excluded.updated_at`,
      )
      .run(clientId, existing?.interviewSessionId ?? null, JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}

/**
 * Persist the gateway session minted for this client so a returning browser
 * rejoins the SAME conversation instead of starting a new one. First write
 * wins: an established session is never silently replaced (that would orphan
 * the running conversation), unless `force` is set.
 */
export function setClientInterviewSessionId(
  clientId: string,
  sessionId: string,
  opts: { force?: boolean } = {},
): boolean {
  if (!clientId || !sessionId) return false;
  try {
    const existing = getClientInterviewState(clientId);
    if (existing?.interviewSessionId && !opts.force) {
      return existing.interviewSessionId === sessionId;
    }
    getDb()
      .prepare(
        `INSERT INTO client_interview_state
           (client_id, interview_session_id, answered_ids, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(client_id) DO UPDATE SET
           interview_session_id = excluded.interview_session_id,
           updated_at           = excluded.updated_at`,
      )
      .run(clientId, sessionId, JSON.stringify(existing?.answeredIds ?? []));
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace a client's answered-id set wholesale. Used by the one-time seed that
 * reconstructs state for a client who answered before this table existed.
 * Ordinary answer traffic uses recordAnsweredQuestion() instead.
 */
export function setClientAnsweredIds(clientId: string, answeredIds: string[]): boolean {
  if (!clientId) return false;
  try {
    const existing = getClientInterviewState(clientId);
    const unique = Array.from(new Set(answeredIds.filter((id) => !!id)));
    getDb()
      .prepare(
        `INSERT INTO client_interview_state
           (client_id, interview_session_id, answered_ids, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(client_id) DO UPDATE SET
           answered_ids = excluded.answered_ids,
           updated_at   = excluded.updated_at`,
      )
      .run(clientId, existing?.interviewSessionId ?? null, JSON.stringify(unique));
    return true;
  } catch {
    return false;
  }
}
